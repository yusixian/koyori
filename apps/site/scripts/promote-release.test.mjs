import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
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

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "koyori-promotion-test-"));
  directories.push(root);
  const site = join(root, "apps/site");
  const assets = join(root, "assets");
  await mkdir(join(root, "docs/releases"), { recursive: true });
  await mkdir(assets);
  await writeFile(join(root, `docs/releases/v${version}.md`), "# Preview\n");
  const dmgName = `Koyori-${version}-arm64.dmg`;
  const dmg = Buffer.from("verified public DMG fixture");
  await writeFile(join(assets, dmgName), dmg);
  const artifacts = expectedPublicArtifactNames(version, false).map((file) => ({
    file,
    sha256: digest(file === dmgName ? dmg : Buffer.from(file)),
    sha512: createHash("sha512").update(file).digest("base64"),
    bytes: file === dmgName ? dmg.length : Buffer.byteLength(file),
  }));
  const candidate = {
    version,
    commit,
    dirty: false,
    platform: "darwin",
    arch: "arm64",
    minimumSystemVersion: "13.0",
    distribution: "manual-preview-candidate",
    signing: "unsigned",
    notarized: false,
    artifacts,
  };
  const candidateText = `${JSON.stringify(candidate)}\n`;
  await writeFile(join(assets, "candidate.json"), candidateText);
  await writeFile(
    join(assets, "acceptance.json"),
    JSON.stringify({ schemaVersion: 1, version, commit, candidateSha256: digest(candidateText) }),
  );
  const release = {
    tagName: tag,
    isDraft: false,
    isPrerelease: true,
    publishedAt: "2026-09-22T13:00:00.000Z",
    assets: ["candidate.json", "acceptance.json", dmgName].map((name) => ({ name })),
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
  await assert.rejects(promotePreviewRelease({ tag, root: setup.site, runGh }), /acceptance.json/u);
  await assert.rejects(readFile(setup.target), { code: "ENOENT" });
});
