import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { stringify as stringifyYaml } from "yaml";
import { expectedPublicArtifactNames } from "../../../scripts/package-desktop-config.mjs";
import { promotePreviewRelease } from "./promote-release.mjs";

const version = "0.1.0-alpha.1";
const tag = `v${version}`;
const commit = "a".repeat(40);
const directories = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function fixture({ developmentSigned = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "koyori-promotion-test-"));
  directories.push(root);
  const site = join(root, "apps/site");
  const assets = join(root, "assets");
  await mkdir(join(root, "docs/releases"), { recursive: true });
  await mkdir(assets);
  await writeFile(join(root, "package.json"), JSON.stringify({ version }));
  await writeFile(join(root, `docs/releases/v${version}.md`), "# Preview\n");
  const dmgName = `Koyori-${version}-arm64.dmg`;
  const dmg = Buffer.from("verified public DMG fixture");
  const artifacts = [];
  const artifactNames = expectedPublicArtifactNames(version, developmentSigned);
  for (const file of artifactNames.filter((name) => name !== "alpha-mac.yml")) {
    const bytes = file === dmgName ? dmg : Buffer.from(file);
    await writeFile(join(assets, file), bytes);
  }
  if (developmentSigned) {
    const zipName = `Koyori-${version}-arm64.zip`;
    const files = [dmgName, zipName].map((name) => {
      const bytes = name === dmgName ? dmg : Buffer.from(name);
      return {
        url: name,
        sha512: createHash("sha512").update(bytes).digest("base64"),
        size: bytes.length,
      };
    });
    await writeFile(
      join(assets, "alpha-mac.yml"),
      stringifyYaml({
        version,
        files,
        path: zipName,
        sha512: files[1].sha512,
      }),
    );
  }
  for (const file of artifactNames) {
    const bytes = await readFile(join(assets, file));
    artifacts.push({
      file,
      sha256: digest(bytes),
      sha512: createHash("sha512").update(bytes).digest("base64"),
      bytes: bytes.length,
    });
  }
  const candidate = {
    version,
    commit,
    dirty: false,
    platform: "darwin",
    arch: "arm64",
    minimumSystemVersion: "13.0",
    distribution: developmentSigned ? "development-update-candidate" : "manual-preview-candidate",
    signing: developmentSigned ? "signed" : "unsigned",
    notarized: false,
    artifacts,
  };
  const candidateText = `${JSON.stringify(candidate)}\n`;
  await writeFile(join(assets, "candidate.json"), candidateText);
  await writeFile(
    join(assets, "acceptance.json"),
    JSON.stringify({
      schemaVersion: 1,
      version,
      commit,
      candidateSha256: digest(candidateText),
      acceptedAt: "2026-09-22T13:00:00.000Z",
      platform: "darwin",
      arch: "arm64",
      testedArchives: [dmgName, `Koyori-${version}-arm64.zip`].map((file) => {
        const artifact = artifacts.find((item) => item.file === file);
        return { file, sha256: artifact.sha256, bytes: artifact.bytes, application: "Koyori.app" };
      }),
      upgrade: { status: "not-tested", reason: "no-upgrade-test-evidence" },
    }),
  );
  const release = {
    tagName: tag,
    isDraft: false,
    isPrerelease: true,
    publishedAt: "2026-09-22T13:00:00.000Z",
    assets: ["candidate.json", "acceptance.json", ...artifacts.map((item) => item.file)].map(
      (name) => ({ name }),
    ),
  };
  const target = join(site, "public/releases/preview-mac-arm64.json");
  const runGh = async (args) => {
    if (args[0] === "release" && args[1] === "view") return JSON.stringify(release);
    if (args[0] === "api") return commit;
    if (args[0] === "release" && args[1] === "download") {
      const name = args[args.indexOf("--pattern") + 1];
      await copyFile(join(assets, name), join(args[args.indexOf("--dir") + 1], name));
      return "";
    }
    throw new Error(`Unexpected gh invocation: ${args.join(" ")}`);
  };
  return { site, assets, release, target, runGh, dmgName };
}

test("promotes a verified public Release and is safe to retry", async () => {
  const setup = await fixture();
  const first = await promotePreviewRelease({ tag, root: setup.site, runGh: setup.runGh });
  assert.equal(first.changed, true);
  assert.equal(first.catalog.download.sha256, digest(Buffer.from("verified public DMG fixture")));
  const previous = await readFile(setup.target, "utf8");
  const second = await promotePreviewRelease({ tag, root: setup.site, runGh: setup.runGh });
  assert.equal(second.changed, false);
  assert.equal(await readFile(setup.target, "utf8"), previous);
});

test("promotes a development-signed update release and refuses an older catalog", async () => {
  const setup = await fixture({ developmentSigned: true });
  const result = await promotePreviewRelease({ tag, root: setup.site, runGh: setup.runGh });
  assert.equal(result.catalog.installation, "automatic");
  assert.equal(result.catalog.signing, "signed");
  const newerVersion = "0.1.0-alpha.2";
  const newer = {
    ...result.catalog,
    version: newerVersion,
    releaseNotesUrl: `https://github.com/yusixian/koyori/releases/tag/v${newerVersion}`,
    download: {
      ...result.catalog.download,
      url: `https://github.com/yusixian/koyori/releases/download/v${newerVersion}/Koyori-${newerVersion}-arm64.dmg`,
    },
  };
  await writeFile(setup.target, `${JSON.stringify(newer, null, 2)}\n`);
  await assert.rejects(
    promotePreviewRelease({ tag, root: setup.site, runGh: setup.runGh }),
    /not older/u,
  );
});

test("promotes a published version after the workspace version has advanced", async () => {
  const setup = await fixture();
  await writeFile(
    join(setup.site, "../../package.json"),
    JSON.stringify({ version: "0.1.0-alpha.2" }),
  );
  const result = await promotePreviewRelease({ tag, root: setup.site, runGh: setup.runGh });
  assert.equal(result.catalog.version, version);
  assert.equal(result.changed, true);
});

test("keeps the old catalog when Release is draft or the actual DMG differs", async () => {
  const setup = await fixture();
  await mkdir(join(setup.site, "public/releases"), { recursive: true });
  await writeFile(setup.target, "old catalog\n");
  setup.release.isDraft = true;
  await assert.rejects(
    promotePreviewRelease({ tag, root: setup.site, runGh: setup.runGh }),
    /not public/u,
  );
  assert.equal(await readFile(setup.target, "utf8"), "old catalog\n");
  setup.release.isDraft = false;
  await writeFile(join(setup.assets, setup.dmgName), "changed DMG");
  await assert.rejects(
    promotePreviewRelease({ tag, root: setup.site, runGh: setup.runGh }),
    /does not match/u,
  );
  assert.equal(await readFile(setup.target, "utf8"), "old catalog\n");
});

test("rejects a tag that does not resolve to the accepted commit", async () => {
  const setup = await fixture();
  const runGh = async (args) => (args[0] === "api" ? "b".repeat(40) : setup.runGh(args));
  await assert.rejects(
    promotePreviewRelease({ tag, root: setup.site, runGh }),
    /different commit/u,
  );
  await assert.rejects(readFile(setup.target), { code: "ENOENT" });
});

test("rejects an incomplete Release or archive acceptance before changing the site", async () => {
  const setup = await fixture();
  setup.release.assets = setup.release.assets.filter(
    (asset) => asset.name !== `Koyori-${version}-arm64.zip`,
  );
  await assert.rejects(
    promotePreviewRelease({ tag, root: setup.site, runGh: setup.runGh }),
    /exact accepted asset set/u,
  );
  setup.release.assets.push({ name: `Koyori-${version}-arm64.zip` });
  const acceptancePath = join(setup.assets, "acceptance.json");
  const acceptance = JSON.parse(await readFile(acceptancePath, "utf8"));
  acceptance.testedArchives = acceptance.testedArchives.slice(0, 1);
  await writeFile(acceptancePath, JSON.stringify(acceptance));
  await assert.rejects(
    promotePreviewRelease({ tag, root: setup.site, runGh: setup.runGh }),
    /Both public archives/u,
  );
  await assert.rejects(readFile(setup.target), { code: "ENOENT" });
});
