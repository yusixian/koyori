import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { stringify as stringifyYaml } from "yaml";
import { expectedPublicArtifactNames } from "./package-desktop-config.mjs";
import {
  createPreviewCatalog,
  verifyPublishInput,
  verifyRemoteAssets,
} from "./release-preview.mjs";

const VERSION = "0.1.0-alpha.1";
const COMMIT = "a".repeat(40);
const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture({ notarized = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), "koyori-preview-release-"));
  temporaryDirectories.push(root);
  const directory = join(root, "release-input");
  await mkdir(join(root, "docs/releases"), { recursive: true });
  await mkdir(directory, { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ version: VERSION }));
  await writeFile(join(root, `docs/releases/v${VERSION}.md`), "# Preview\n");

  const artifactNames = expectedPublicArtifactNames(VERSION, notarized);
  const binaryNames = artifactNames.filter((name) => name !== "alpha-mac.yml");
  for (const name of binaryNames) await writeFile(join(directory, name), `fixture:${name}`);
  const zipName = `Koyori-${VERSION}-arm64.zip`;
  const dmgName = `Koyori-${VERSION}-arm64.dmg`;
  const metadata = {
    version: VERSION,
    files: await Promise.all(
      [zipName, dmgName].map(async (name) => ({
        url: name,
        sha512: await digest(join(directory, name), "sha512", "base64"),
        size: (await readFile(join(directory, name))).byteLength,
      })),
    ),
    path: zipName,
    sha512: await digest(join(directory, zipName), "sha512", "base64"),
    releaseDate: "2026-09-22T12:00:00.000Z",
  };
  if (notarized) await writeFile(join(directory, "alpha-mac.yml"), stringifyYaml(metadata));
  const artifacts = await Promise.all(
    artifactNames.map(async (file) => {
      const data = await readFile(join(directory, file));
      return {
        file,
        sha256: createHash("sha256").update(data).digest("hex"),
        sha512: createHash("sha512").update(data).digest("base64"),
        bytes: data.byteLength,
      };
    }),
  );
  const candidate = {
    version: VERSION,
    commit: COMMIT,
    dirty: false,
    platform: "darwin",
    arch: "arm64",
    minimumSystemVersion: "13.0",
    distribution: notarized ? "preview-candidate" : "manual-preview-candidate",
    signing: notarized ? "notarized" : "unsigned",
    notarized,
    artifacts,
  };
  const candidatePath = join(directory, "candidate.json");
  await writeFile(candidatePath, `${JSON.stringify(candidate, null, 2)}\n`);
  const acceptance = {
    schemaVersion: 1,
    version: VERSION,
    commit: COMMIT,
    candidateSha256: await digest(candidatePath, "sha256", "hex"),
    acceptedAt: "2026-09-22T12:30:00.000Z",
    platform: "darwin",
    arch: "arm64",
    packagedApplication: "mac-arm64/Koyori.app",
    upgrade: { status: "not-applicable", reason: "first-public-release" },
  };
  await writeFile(join(directory, "acceptance.json"), `${JSON.stringify(acceptance, null, 2)}\n`);
  return { root, directory, candidate, candidatePath };
}

test("verifies the exact candidate and creates the website catalog", async () => {
  const setup = await fixture();
  const verified = await verifyPublishInput({
    root: setup.root,
    directory: setup.directory,
    commit: COMMIT,
    version: VERSION,
  });
  assert.equal(verified.tag, `v${VERSION}`);

  const catalogPath = join(setup.root, "catalog/preview-mac-arm64.json");
  const catalog = await createPreviewCatalog({
    candidatePath: setup.candidatePath,
    publishedAt: "2026-09-22T13:00:00.000Z",
    outputPath: catalogPath,
  });
  assert.equal(catalog.installation, "automatic");
  assert.equal(catalog.signing, "notarized");
  assert.equal(
    catalog.download.url,
    `https://github.com/yusixian/koyori/releases/download/v${VERSION}/Koyori-${VERSION}-arm64.dmg`,
  );
  assert.deepEqual(JSON.parse(await readFile(catalogPath, "utf8")), catalog);
});

test("accepts an unsigned manual preview without updater metadata", async () => {
  const setup = await fixture({ notarized: false });
  const verified = await verifyPublishInput({
    root: setup.root,
    directory: setup.directory,
    commit: COMMIT,
    version: VERSION,
  });
  assert.equal(verified.notarized, false);
  assert.equal(verified.files.includes("alpha-mac.yml"), false);
  const catalog = await createPreviewCatalog({
    candidatePath: setup.candidatePath,
    publishedAt: "2026-09-22T13:00:00.000Z",
    outputPath: join(setup.root, "catalog/preview-mac-arm64.json"),
  });
  assert.equal(catalog.signing, "unsigned");
  assert.equal(catalog.installation, "manual");
});

test("rejects a local-only unsigned build from the publish path", async () => {
  const setup = await fixture({ notarized: false });
  const candidate = { ...setup.candidate, distribution: "local-candidate" };
  await writeFile(setup.candidatePath, JSON.stringify(candidate));
  await assert.rejects(
    verifyPublishInput({
      root: setup.root,
      directory: setup.directory,
      commit: COMMIT,
      version: VERSION,
    }),
    /not a clean Apple Silicon preview candidate/u,
  );
});

test("rejects a candidate from another commit", async () => {
  const setup = await fixture();
  await assert.rejects(
    verifyPublishInput({
      root: setup.root,
      directory: setup.directory,
      commit: "b".repeat(40),
      version: VERSION,
    }),
    /different commit/u,
  );
});

test("rejects an artifact whose digest changed after acceptance", async () => {
  const setup = await fixture();
  await writeFile(join(setup.directory, `Koyori-${VERSION}-arm64.dmg`), "tampered");
  await assert.rejects(
    verifyPublishInput({
      root: setup.root,
      directory: setup.directory,
      commit: COMMIT,
      version: VERSION,
    }),
    /does not match candidate/u,
  );
});

test("rejects malicious candidate artifact names", async () => {
  const setup = await fixture();
  const candidate = JSON.parse(await readFile(setup.candidatePath, "utf8"));
  candidate.artifacts[0].file = "../outside.dmg";
  await writeFile(setup.candidatePath, JSON.stringify(candidate));
  await assert.rejects(
    verifyPublishInput({
      root: setup.root,
      directory: setup.directory,
      commit: COMMIT,
      version: VERSION,
    }),
    /safe base file names/u,
  );
});

test("rejects missing updater metadata", async () => {
  const setup = await fixture();
  await unlink(join(setup.directory, "alpha-mac.yml"));
  await assert.rejects(
    verifyPublishInput({
      root: setup.root,
      directory: setup.directory,
      commit: COMMIT,
      version: VERSION,
    }),
    /exact expected file set/u,
  );
});

test("compares every downloaded draft asset with the accepted input", async () => {
  const setup = await fixture();
  const remote = join(setup.root, "remote");
  await mkdir(remote);
  for (const file of await readdir(setup.directory)) {
    await copyFile(join(setup.directory, file), join(remote, file));
  }
  await verifyRemoteAssets({ localDirectory: setup.directory, remoteDirectory: remote });
  await writeFile(join(remote, "acceptance.json"), "changed");
  await assert.rejects(
    verifyRemoteAssets({ localDirectory: setup.directory, remoteDirectory: remote }),
    /downloaded Release asset does not match/u,
  );
});

async function digest(path, algorithm, encoding) {
  return createHash(algorithm)
    .update(await readFile(path))
    .digest(encoding);
}
