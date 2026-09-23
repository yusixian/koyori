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
  inspectRemoteRelease,
  planReleaseContinuation,
  recordAcceptance,
  verifyArchiveInputs,
  verifyPublishInput,
  verifyRemoteAssetSubset,
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

async function fixture({ notarized = true, developmentSigned = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "koyori-preview-release-"));
  temporaryDirectories.push(root);
  const directory = join(root, "release-input");
  await mkdir(join(root, "docs/releases"), { recursive: true });
  await mkdir(directory, { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ version: VERSION }));
  await writeFile(join(root, `docs/releases/v${VERSION}.md`), "# Preview\n");

  const artifactNames = expectedPublicArtifactNames(VERSION, notarized || developmentSigned);
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
  if (notarized || developmentSigned)
    await writeFile(join(directory, "alpha-mac.yml"), stringifyYaml(metadata));
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
    distribution: notarized
      ? "preview-candidate"
      : developmentSigned
        ? "development-update-candidate"
        : "manual-preview-candidate",
    signing: notarized ? "notarized" : developmentSigned ? "signed" : "unsigned",
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
    testedArchives: [dmgName, zipName].map((file) => {
      const artifact = artifacts.find((item) => item.file === file);
      return {
        file,
        sha256: artifact.sha256,
        bytes: artifact.bytes,
        application: "Koyori.app",
      };
    }),
    upgrade: { status: "not-tested", reason: "no-upgrade-test-evidence" },
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

test("acceptance binds both tested archives to candidate bytes", async () => {
  const setup = await fixture();
  const testedArchives = await verifyArchiveInputs({
    candidatePath: setup.candidatePath,
    commit: COMMIT,
  });
  const evidencePath = join(setup.root, "archive-tests.json");
  await writeFile(evidencePath, JSON.stringify({ testedArchives }));
  const acceptance = await recordAcceptance({
    root: setup.root,
    candidatePath: setup.candidatePath,
    archiveTestsPath: evidencePath,
    outputPath: join(setup.root, "fresh-acceptance.json"),
    commit: COMMIT,
  });
  assert.deepEqual(acceptance.testedArchives, testedArchives);
  await writeFile(evidencePath, JSON.stringify({ testedArchives: testedArchives.slice(0, 1) }));
  await assert.rejects(
    recordAcceptance({
      root: setup.root,
      candidatePath: setup.candidatePath,
      archiveTestsPath: evidencePath,
      outputPath: join(setup.root, "invalid-acceptance.json"),
      commit: COMMIT,
    }),
    /Both public archives/u,
  );
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

test("accepts an Apple Development-signed Preview with updater metadata", async () => {
  const setup = await fixture({ notarized: false, developmentSigned: true });
  const verified = await verifyPublishInput({
    root: setup.root,
    directory: setup.directory,
    commit: COMMIT,
    version: VERSION,
  });
  assert.equal(verified.notarized, false);
  assert.equal(verified.files.includes("alpha-mac.yml"), true);
  const catalog = await createPreviewCatalog({
    candidatePath: setup.candidatePath,
    publishedAt: "2026-09-22T13:00:00.000Z",
    outputPath: join(setup.root, "catalog/preview-mac-arm64.json"),
  });
  assert.equal(catalog.signing, "signed");
  assert.equal(catalog.installation, "automatic");
});

test("rejects mismatched Apple Development update metadata", async () => {
  const setup = await fixture({ notarized: false, developmentSigned: true });
  const metadataPath = join(setup.directory, "alpha-mac.yml");
  const metadata = await readFile(metadataPath, "utf8");
  await writeFile(metadataPath, metadata.replace(`version: ${VERSION}`, "version: 0.1.0-alpha.9"));
  await assert.rejects(
    verifyPublishInput({
      root: setup.root,
      directory: setup.directory,
      commit: COMMIT,
      version: VERSION,
    }),
    /does not match candidate|version must be/u,
  );
});

test("local archive checks can inspect a dirty build without making it publishable", async () => {
  const setup = await fixture({ notarized: false, developmentSigned: true });
  await writeFile(setup.candidatePath, JSON.stringify({ ...setup.candidate, dirty: true }));
  await assert.rejects(
    verifyArchiveInputs({ candidatePath: setup.candidatePath, commit: COMMIT }),
    /not a clean Apple Silicon preview candidate/u,
  );
  assert.equal(
    (
      await verifyArchiveInputs({
        candidatePath: setup.candidatePath,
        commit: COMMIT,
        allowLocalDirty: true,
      })
    ).length,
    2,
  );
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

test("release workflow requires the checked out package version", async () => {
  const setup = await fixture();
  await writeFile(join(setup.root, "package.json"), JSON.stringify({ version: "0.1.0-alpha.2" }));
  await assert.rejects(
    verifyPublishInput({
      root: setup.root,
      directory: setup.directory,
      commit: COMMIT,
      version: VERSION,
    }),
    /release version does not match/u,
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

test("rejects an artifact with an incorrect SHA-512 record", async () => {
  const setup = await fixture();
  const candidate = JSON.parse(await readFile(setup.candidatePath, "utf8"));
  candidate.artifacts[0].sha512 = Buffer.alloc(64, 1).toString("base64");
  await writeFile(setup.candidatePath, JSON.stringify(candidate));
  await assert.rejects(
    verifyPublishInput({
      root: setup.root,
      directory: setup.directory,
      commit: COMMIT,
      version: VERSION,
    }),
    /SHA-512 does not match/u,
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

test("compares partial remote assets without permitting changed bytes", async () => {
  const setup = await fixture();
  const remote = join(setup.root, "remote");
  await mkdir(remote);
  await copyFile(join(setup.directory, "candidate.json"), join(remote, "candidate.json"));
  await verifyRemoteAssetSubset({
    localDirectory: setup.directory,
    remoteDirectory: remote,
    names: ["candidate.json"],
  });
  await writeFile(join(remote, "candidate.json"), "changed");
  await assert.rejects(
    verifyRemoteAssetSubset({
      localDirectory: setup.directory,
      remoteDirectory: remote,
      names: ["candidate.json"],
    }),
    /does not match/u,
  );
});

test("release continuation allows only matching drafts and immutable published prereleases", () => {
  const tag = `v${VERSION}`;
  const files = ["candidate.json", "acceptance.json"];
  const base = { commit: COMMIT, tag, tagCommit: COMMIT, publishedTags: [], localFiles: files };
  assert.deepEqual(planReleaseContinuation({ ...base, release: null, remoteFiles: [] }), {
    action: "create",
    missing: files,
  });
  const release = { tag_name: tag, target_commitish: COMMIT, prerelease: true, draft: true };
  assert.deepEqual(planReleaseContinuation({ ...base, release, remoteFiles: ["candidate.json"] }), {
    action: "upload",
    missing: ["acceptance.json"],
  });
  assert.deepEqual(planReleaseContinuation({ ...base, release, remoteFiles: files }), {
    action: "publish",
    missing: [],
  });
  assert.equal(
    planReleaseContinuation({
      ...base,
      release: { ...release, target_commitish: "main" },
      remoteFiles: files,
    }).action,
    "publish",
  );
  assert.throws(
    () =>
      planReleaseContinuation({
        ...base,
        tagCommit: null,
        release: { ...release, target_commitish: "main" },
        remoteFiles: files,
      }),
    /different identity/u,
  );
  assert.deepEqual(
    planReleaseContinuation({
      ...base,
      release: { ...release, draft: false },
      publishedTags: [tag],
      remoteFiles: files,
    }),
    { action: "published", missing: [] },
  );
  assert.throws(
    () =>
      planReleaseContinuation({ ...base, tagCommit: "b".repeat(40), release, remoteFiles: files }),
    /different commit/u,
  );
  assert.throws(
    () =>
      planReleaseContinuation({
        ...base,
        release: { ...release, draft: false },
        publishedTags: [tag],
        remoteFiles: [],
      }),
    /missing accepted assets/u,
  );
  assert.throws(
    () => planReleaseContinuation({ ...base, release, remoteFiles: ["other.json"] }),
    /unexpected/u,
  );
  assert.equal(
    planReleaseContinuation({
      ...base,
      release,
      publishedTags: ["v0.1.0-alpha.0"],
      remoteFiles: files,
    }).action,
    "publish",
  );
  assert.throws(
    () =>
      planReleaseContinuation({
        ...base,
        release,
        publishedTags: ["v0.1.0-alpha.2"],
        remoteFiles: files,
      }),
    /not older/u,
  );
});

test("remote inspection finds a draft in the Release list and checks downloaded bytes", async () => {
  const setup = await fixture();
  const remoteDirectory = join(setup.root, "remote-by-api");
  const tag = `v${VERSION}`;
  const candidateBytes = await readFile(setup.candidatePath);
  const release = {
    tag_name: tag,
    target_commitish: COMMIT,
    prerelease: true,
    draft: true,
    assets: [{ id: 12, name: "candidate.json", state: "uploaded" }],
  };
  const request = async (url) => {
    if (url.includes("releases?")) return Response.json([release]);
    if (url.includes("git/ref/tags/")) return new Response(null, { status: 404 });
    if (url.includes("releases/assets/12")) return new Response(candidateBytes);
    throw new Error(`Unexpected test URL: ${url}`);
  };
  const plan = await inspectRemoteRelease({
    repository: "owner/repo",
    tag,
    commit: COMMIT,
    localDirectory: setup.directory,
    remoteDirectory,
    token: "synthetic-token",
    request,
  });
  assert.equal(plan.action, "upload");
  assert.equal(plan.missing.includes("candidate.json"), false);
  await rm(remoteDirectory, { recursive: true });
  await assert.rejects(
    inspectRemoteRelease({
      repository: "owner/repo",
      tag,
      commit: COMMIT,
      localDirectory: setup.directory,
      remoteDirectory,
      token: "synthetic-token",
      request: async (url) =>
        url.includes("releases/assets/12") ? new Response("different") : request(url),
    }),
    /downloaded Release asset does not match/u,
  );
});

test("remote inspection treats API permission failures as errors", async () => {
  await assert.rejects(
    inspectRemoteRelease({
      repository: "owner/repo",
      tag: `v${VERSION}`,
      commit: COMMIT,
      token: "synthetic-token",
      request: async () => new Response(null, { status: 403 }),
    }),
    /HTTP 403/u,
  );
});

async function digest(path, algorithm, encoding) {
  return createHash(algorithm)
    .update(await readFile(path))
    .digest(encoding);
}
