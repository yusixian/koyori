import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { appendFile, lstat, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { parse as parseYaml } from "yaml";
import {
  assertAlphaVersion,
  expectedPublicArtifactNames,
  MAC_MINIMUM_SYSTEM_VERSION,
  validateAlphaUpdateMetadata,
} from "./package-desktop-config.mjs";

const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const MAX_DOWNLOAD_BYTES = 1024 * 1024 * 1024;
const ISO_DATE_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;
const CANDIDATE_KEYS = [
  "version",
  "commit",
  "dirty",
  "platform",
  "arch",
  "minimumSystemVersion",
  "distribution",
  "signing",
  "notarized",
  "artifacts",
];
const ARTIFACT_KEYS = ["file", "sha256", "sha512", "bytes"];
const ACCEPTANCE_KEYS = [
  "schemaVersion",
  "version",
  "commit",
  "candidateSha256",
  "acceptedAt",
  "platform",
  "arch",
  "testedArchives",
  "upgrade",
];
const UPGRADE_KEYS = ["status", "reason"];
const TESTED_ARCHIVE_KEYS = ["file", "sha256", "bytes", "application"];

export async function preparePreview({ root, commit }) {
  requireCommit(commit);
  const packageJson = await readJson(join(root, "package.json"), "root package");
  const version = requireString(packageJson.version, "root package version");
  assertAlphaVersion(version);
  const currentCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  if (currentCommit !== commit)
    throw new Error("The checked out commit does not match the release SHA.");
  const notes = `docs/releases/v${version}.md`;
  await requireRegularFile(join(root, notes), "release notes");
  return { version, tag: `v${version}`, notes };
}

export async function recordAcceptance({
  root,
  candidatePath,
  outputPath,
  commit,
  archiveTestsPath,
  now = new Date(),
}) {
  const packageJson = await readJson(join(root, "package.json"), "root package");
  const version = requireString(packageJson.version, "root package version");
  const candidate = await readCandidate(candidatePath, { version, commit });
  await verifyCandidateArtifacts(dirname(candidatePath), candidate);
  if (hasUpdateMetadata(candidate)) await verifyUpdateMetadata(dirname(candidatePath), candidate);
  const testedArchives = await readArchiveTests(archiveTestsPath, candidate);
  const candidateSha256 = await sha256(candidatePath);
  const acceptance = {
    schemaVersion: 1,
    version,
    commit,
    candidateSha256,
    acceptedAt: now.toISOString(),
    platform: "darwin",
    arch: "arm64",
    testedArchives,
    upgrade: {
      status: "not-tested",
      reason: "no-upgrade-test-evidence",
    },
  };
  await writeJsonAtomic(outputPath, acceptance);
  return acceptance;
}

export async function verifyArchiveInputs({ candidatePath, commit, allowLocalDirty = false }) {
  const candidate = await readCandidate(candidatePath, { commit, allowLocalDirty });
  await verifyCandidateArtifacts(dirname(candidatePath), candidate);
  if (hasUpdateMetadata(candidate)) await verifyUpdateMetadata(dirname(candidatePath), candidate);
  return expectedArchiveTests(candidate);
}

export async function verifyPublishInput({
  root,
  directory,
  commit,
  version,
  requireCurrentVersion = true,
}) {
  requireCommit(commit);
  assertAlphaVersion(version);
  const packageJson = await readJson(join(root, "package.json"), "root package");
  if (requireCurrentVersion && packageJson.version !== version) {
    throw new Error("The release version does not match the checked out package version.");
  }
  await requireRegularFile(join(root, `docs/releases/v${version}.md`), "release notes");

  const candidatePath = join(directory, "candidate.json");
  const acceptancePath = join(directory, "acceptance.json");
  const candidate = await readCandidate(candidatePath, { version, commit });
  const expectedFiles = [
    "candidate.json",
    "acceptance.json",
    ...expectedPublicArtifactNames(version, hasUpdateMetadata(candidate)),
  ];
  await requireExactFiles(directory, expectedFiles);
  await verifyCandidateArtifacts(directory, candidate);
  if (hasUpdateMetadata(candidate)) await verifyUpdateMetadata(directory, candidate);

  const acceptance = await readAcceptance(acceptancePath, { version, commit });
  const candidateSha256 = await sha256(candidatePath);
  if (acceptance.candidateSha256 !== candidateSha256) {
    throw new Error("The acceptance record does not match candidate.json.");
  }
  return {
    version,
    tag: `v${version}`,
    notes: `docs/releases/v${version}.md`,
    files: expectedFiles,
    notarized: candidate.notarized,
  };
}

export async function verifyRemoteAssets({ localDirectory, remoteDirectory }) {
  const localFiles = (await readdir(localDirectory)).sort();
  await requireExactFiles(remoteDirectory, localFiles);
  for (const file of localFiles) {
    assertSafeFileName(file);
    const localPath = join(localDirectory, file);
    const remotePath = join(remoteDirectory, file);
    await requireRegularFile(localPath, file);
    await requireRegularFile(remotePath, file);
    const [localDigest, remoteDigest, localInfo, remoteInfo] = await Promise.all([
      sha256(localPath),
      sha256(remotePath),
      lstat(localPath),
      lstat(remotePath),
    ]);
    if (localDigest !== remoteDigest || localInfo.size !== remoteInfo.size) {
      throw new Error(`The downloaded Release asset does not match ${file}.`);
    }
  }
}

export async function verifyRemoteAssetSubset({ localDirectory, remoteDirectory, names }) {
  const localFiles = await readdir(localDirectory);
  const remoteFiles = (await readdir(remoteDirectory)).sort();
  if (JSON.stringify(remoteFiles) !== JSON.stringify([...names].sort())) {
    throw new Error("The draft contains an unexpected Release asset set.");
  }
  for (const file of remoteFiles) {
    assertSafeFileName(file);
    if (!localFiles.includes(file)) throw new Error(`Unexpected Release asset: ${file}.`);
    const localPath = join(localDirectory, file);
    const remotePath = join(remoteDirectory, file);
    await requireRegularFile(localPath, file);
    await requireRegularFile(remotePath, file);
    const [localDigest, remoteDigest, localInfo, remoteInfo] = await Promise.all([
      sha256(localPath),
      sha256(remotePath),
      lstat(localPath),
      lstat(remotePath),
    ]);
    if (localDigest !== remoteDigest || localInfo.size !== remoteInfo.size) {
      throw new Error(`The downloaded Release asset does not match ${file}.`);
    }
  }
}

export function planReleaseContinuation({
  commit,
  tag,
  tagCommit,
  release,
  publishedTags,
  localFiles,
  remoteFiles,
}) {
  requireCommit(commit);
  if (tagCommit !== null && tagCommit !== commit) {
    throw new Error("The existing release tag points to a different commit.");
  }
  const releaseVersion = alphaVersionParts(tag);
  for (const published of publishedTags) {
    if (published === tag) continue;
    const previous = alphaVersionParts(published);
    if (compareAlphaVersions(previous, releaseVersion) >= 0) {
      throw new Error("A published Release is not older than this Preview.");
    }
  }
  if (release === null) {
    return { action: "create", missing: localFiles };
  }
  if (
    release.tag_name !== tag ||
    (tagCommit === null && release.target_commitish !== commit) ||
    !release.prerelease
  ) {
    throw new Error("The existing Release has a different identity or is not a prerelease.");
  }
  if (release.draft && publishedTags.includes(tag)) {
    throw new Error("Draft and published Release state is inconsistent.");
  }
  if (!release.draft && (!publishedTags.includes(tag) || tagCommit !== commit)) {
    throw new Error("The published Release or tag cannot be verified.");
  }
  if (
    new Set(remoteFiles).size !== remoteFiles.length ||
    remoteFiles.some((name) => !localFiles.includes(name))
  ) {
    throw new Error("The Release contains unexpected or duplicate assets.");
  }
  const missing = localFiles.filter((name) => !remoteFiles.includes(name));
  if (!release.draft && missing.length) {
    throw new Error("The published Release is missing accepted assets.");
  }
  return { action: release.draft ? (missing.length ? "upload" : "publish") : "published", missing };
}

export async function inspectRemoteRelease({
  repository,
  tag,
  commit,
  localDirectory,
  remoteDirectory,
  token,
  request = fetch,
}) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
    throw new Error("Invalid GitHub repository.");
  }
  if (!token) throw new Error("GH_TOKEN is required.");
  requireCommit(commit);
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const api = async (path, optional = false) => {
    const response = await request(`https://api.github.com/repos/${repository}/${path}`, {
      headers,
    });
    if (optional && response.status === 404) return null;
    if (!response.ok) throw new Error(`GitHub API request failed with HTTP ${response.status}.`);
    return response.json();
  };
  const releases = [];
  for (let page = 1; page <= 10; page += 1) {
    const entries = await api(`releases?per_page=100&page=${page}`);
    if (!Array.isArray(entries)) throw new Error("Invalid GitHub Releases response.");
    releases.push(...entries);
    if (entries.length < 100) break;
    if (page === 10) throw new Error("Release history is too large to verify the first version.");
  }
  const publishedTags = releases.filter((entry) => !entry.draft).map((entry) => entry.tag_name);
  const matches = releases.filter((entry) => entry.tag_name === tag);
  if (matches.length > 1) throw new Error("Multiple Releases claim the same tag.");
  const release = matches[0] ?? null;
  const tagRef = await api(`git/ref/tags/${encodeURIComponent(tag)}`, true);
  const tagCommit = tagRef === null ? null : (await api(`commits/${encodeURIComponent(tag)}`)).sha;
  if (release && !Array.isArray(release.assets)) {
    throw new Error("Invalid GitHub Release assets response.");
  }
  const remoteFiles = release?.assets?.map((asset) => asset.name) ?? [];
  const localFiles = localDirectory ? (await readdir(localDirectory)).sort() : remoteFiles;
  for (const name of [...localFiles, ...remoteFiles]) assertSafeFileName(name);
  const plan = planReleaseContinuation({
    commit,
    tag,
    tagCommit,
    release,
    publishedTags,
    localFiles,
    remoteFiles,
  });
  if (localDirectory && remoteFiles.length) {
    if (!remoteDirectory) throw new Error("A remote download directory is required.");
    await mkdir(remoteDirectory, { recursive: true });
    for (const asset of release.assets) {
      if (!Number.isSafeInteger(asset.id) || asset.state !== "uploaded") {
        throw new Error("The Release contains an incomplete asset.");
      }
      const response = await request(
        `https://api.github.com/repos/${repository}/releases/assets/${asset.id}`,
        { headers: { ...headers, Accept: "application/octet-stream" } },
      );
      if (!response.ok || !response.body) {
        throw new Error(`Could not download Release asset ${asset.name}.`);
      }
      await pipeline(
        Readable.fromWeb(response.body),
        createWriteStream(join(remoteDirectory, asset.name), { flags: "wx" }),
      );
    }
    await verifyRemoteAssetSubset({
      localDirectory,
      remoteDirectory,
      names: remoteFiles,
    });
  }
  return plan;
}

export async function createPreviewCatalog({ candidatePath, publishedAt, outputPath }) {
  if (!isIsoDate(publishedAt)) throw new Error("The Release publishedAt value is invalid.");
  const candidate = await readCandidate(candidatePath);
  const dmgName = `Koyori-${candidate.version}-arm64.dmg`;
  const dmg = candidate.artifacts.find((artifact) => artifact.file === dmgName);
  if (!dmg) throw new Error("candidate.json does not contain the public DMG.");
  const catalog = {
    schemaVersion: 1,
    version: candidate.version,
    channel: "preview",
    commit: candidate.commit,
    publishedAt,
    platform: "darwin",
    arch: "arm64",
    minimumSystemVersion: candidate.minimumSystemVersion,
    signing: candidate.signing,
    installation: hasUpdateMetadata(candidate) ? "automatic" : "manual",
    releaseNotesUrl: `https://github.com/yusixian/koyori/releases/tag/v${candidate.version}`,
    download: {
      url: `https://github.com/yusixian/koyori/releases/download/v${candidate.version}/${dmgName}`,
      sha256: dmg.sha256,
      bytes: dmg.bytes,
    },
  };
  await writeJsonAtomic(outputPath, catalog);
  return catalog;
}

async function readCandidate(path, expected = {}) {
  const candidate = await readJson(path, "candidate.json");
  requireExactKeys(candidate, CANDIDATE_KEYS, "candidate.json");
  const version = requireString(candidate.version, "candidate version");
  assertAlphaVersion(version);
  const commit = requireString(candidate.commit, "candidate commit");
  requireCommit(commit);
  if (expected.version !== undefined && version !== expected.version) {
    throw new Error("candidate.json comes from a different version.");
  }
  if (expected.commit !== undefined && commit !== expected.commit) {
    throw new Error("candidate.json comes from a different commit.");
  }
  const notarized =
    candidate.distribution === "preview-candidate" &&
    candidate.signing === "notarized" &&
    candidate.notarized === true;
  const manual =
    candidate.distribution === "manual-preview-candidate" &&
    (candidate.signing === "unsigned" || candidate.signing === "signed") &&
    candidate.notarized === false;
  const developmentUpdate =
    candidate.distribution === "development-update-candidate" &&
    candidate.signing === "signed" &&
    candidate.notarized === false;
  if (
    (candidate.dirty !== false && !(expected.allowLocalDirty && candidate.dirty === true)) ||
    candidate.platform !== "darwin" ||
    candidate.arch !== "arm64" ||
    candidate.minimumSystemVersion !== MAC_MINIMUM_SYSTEM_VERSION ||
    (!notarized && !manual && !developmentUpdate)
  ) {
    throw new Error("candidate.json is not a clean Apple Silicon preview candidate.");
  }
  if (!Array.isArray(candidate.artifacts)) {
    throw new Error("candidate.json artifacts must be an array.");
  }
  const expectedNames = expectedPublicArtifactNames(version, notarized || developmentUpdate);
  if (candidate.artifacts.length !== expectedNames.length) {
    throw new Error("candidate.json does not contain the exact public artifact set.");
  }
  const artifacts = candidate.artifacts.map((artifact, index) =>
    normalizeArtifact(artifact, expectedNames[index]),
  );
  if (new Set(artifacts.map((artifact) => artifact.file)).size !== artifacts.length) {
    throw new Error("candidate.json contains duplicate artifact names.");
  }
  return { ...candidate, version, commit, artifacts };
}

function hasUpdateMetadata(candidate) {
  return (
    candidate.distribution === "preview-candidate" ||
    candidate.distribution === "development-update-candidate"
  );
}

function alphaVersionParts(tag) {
  const match = /^v(\d+)\.(\d+)\.(\d+)-alpha\.(\d+)$/u.exec(tag);
  if (!match) throw new Error("Published Releases must use Koyori alpha version tags.");
  return match.slice(1).map(BigInt);
}

function compareAlphaVersions(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] > right[index] ? 1 : -1;
  }
  return 0;
}

function normalizeArtifact(artifact, expectedName) {
  if (!isRecord(artifact)) throw new Error("candidate.json contains an invalid artifact.");
  requireExactKeys(artifact, ARTIFACT_KEYS, "candidate artifact");
  const file = requireString(artifact.file, "artifact file");
  assertSafeFileName(file);
  if (file !== expectedName) throw new Error("candidate.json artifact order or name is invalid.");
  const sha256Value = requireString(artifact.sha256, `${file} sha256`);
  if (!SHA256_PATTERN.test(sha256Value)) throw new Error(`${file} has an invalid SHA-256.`);
  const sha512 = requireString(artifact.sha512, `${file} sha512`);
  if (!isSha512(sha512)) throw new Error(`${file} has an invalid SHA-512.`);
  if (!Number.isSafeInteger(artifact.bytes) || artifact.bytes <= 0) {
    throw new Error(`${file} has an invalid byte size.`);
  }
  if (file.endsWith(".dmg") && artifact.bytes > MAX_DOWNLOAD_BYTES) {
    throw new Error(`${file} exceeds the public catalog size limit.`);
  }
  return { file, sha256: sha256Value, sha512, bytes: artifact.bytes };
}

async function verifyCandidateArtifacts(directory, candidate) {
  for (const artifact of candidate.artifacts) {
    const path = join(directory, artifact.file);
    await requireRegularFile(path, artifact.file);
    const [digests, info] = await Promise.all([fileDigests(path), lstat(path)]);
    if (digests.sha256 !== artifact.sha256 || info.size !== artifact.bytes) {
      throw new Error(`${artifact.file} does not match candidate.json.`);
    }
    if (digests.sha512 !== artifact.sha512) {
      throw new Error(`${artifact.file} SHA-512 does not match candidate.json.`);
    }
  }
}

async function verifyUpdateMetadata(directory, candidate) {
  const metadataName = "alpha-mac.yml";
  const metadataPath = join(directory, metadataName);
  await requireRegularFile(metadataPath, metadataName);
  let metadata;
  try {
    metadata = parseYaml(await readFile(metadataPath, "utf8"));
  } catch {
    throw new Error("alpha-mac.yml is not valid YAML.");
  }
  validateAlphaUpdateMetadata({
    value: metadata,
    version: candidate.version,
    artifacts: candidate.artifacts,
  });
}

async function readAcceptance(path, expected) {
  const acceptance = await readJson(path, "acceptance.json");
  requireExactKeys(acceptance, ACCEPTANCE_KEYS, "acceptance.json");
  if (
    acceptance.schemaVersion !== 1 ||
    acceptance.version !== expected.version ||
    acceptance.commit !== expected.commit ||
    !SHA256_PATTERN.test(acceptance.candidateSha256) ||
    !isIsoDate(acceptance.acceptedAt) ||
    acceptance.platform !== "darwin" ||
    acceptance.arch !== "arm64" ||
    !Array.isArray(acceptance.testedArchives)
  ) {
    throw new Error("acceptance.json does not describe this packaged candidate.");
  }
  const candidate = await readCandidate(join(dirname(path), "candidate.json"), expected);
  validateArchiveTests(acceptance.testedArchives, candidate);
  if (!isRecord(acceptance.upgrade)) throw new Error("acceptance.json upgrade is invalid.");
  requireExactKeys(acceptance.upgrade, UPGRADE_KEYS, "acceptance upgrade");
  if (
    !(
      (acceptance.upgrade.status === "not-applicable" &&
        acceptance.upgrade.reason === "first-public-release") ||
      (acceptance.upgrade.status === "not-tested" &&
        acceptance.upgrade.reason === "no-upgrade-test-evidence")
    )
  ) {
    throw new Error("The upgrade status is invalid or claims unrecorded evidence.");
  }
  return acceptance;
}

async function readArchiveTests(path, candidate) {
  if (!path) throw new Error("Archive test evidence is required.");
  const receipt = await readJson(path, "archive test evidence");
  requireExactKeys(receipt, ["testedArchives"], "archive test evidence");
  return validateArchiveTests(receipt.testedArchives, candidate);
}

function expectedArchiveTests(candidate) {
  return ["dmg", "zip"].map((extension) => {
    const file = `Koyori-${candidate.version}-arm64.${extension}`;
    const artifact = candidate.artifacts.find((entry) => entry.file === file);
    if (!artifact) throw new Error(`candidate.json is missing ${file}.`);
    return {
      file,
      sha256: artifact.sha256,
      bytes: artifact.bytes,
      application: "Koyori.app",
    };
  });
}

function validateArchiveTests(value, candidate) {
  const expected = expectedArchiveTests(candidate);
  if (!Array.isArray(value) || value.length !== expected.length) {
    throw new Error("Both public archives must have desktop test evidence.");
  }
  value.forEach((entry, index) => {
    requireExactKeys(entry, TESTED_ARCHIVE_KEYS, "archive test evidence entry");
    if (TESTED_ARCHIVE_KEYS.some((key) => entry[key] !== expected[index][key])) {
      throw new Error("Archive test evidence does not match candidate.json.");
    }
  });
  return expected;
}

async function requireExactFiles(directory, expectedFiles) {
  for (const file of expectedFiles) assertSafeFileName(file);
  const actual = (await readdir(directory)).sort();
  const expected = [...expectedFiles].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("The release directory does not contain the exact expected file set.");
  }
  for (const file of expected) await requireRegularFile(join(directory, file), file);
}

export function assertSafeFileName(file) {
  if (
    typeof file !== "string" ||
    file.length === 0 ||
    file !== basename(file) ||
    file === "." ||
    file === ".." ||
    file.includes("\\") ||
    [...file].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
    })
  ) {
    throw new Error("Release artifacts must use safe base file names.");
  }
}

async function readJson(path, description) {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    if (!isRecord(value)) throw new Error("not an object");
    return value;
  } catch {
    throw new Error(`${description} is missing or invalid.`);
  }
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

async function requireRegularFile(path, description) {
  const info = await lstat(path).catch(() => null);
  if (!info?.isFile() || info.isSymbolicLink()) {
    throw new Error(`${description} is missing or is not a regular file.`);
  }
}

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function fileDigests(path) {
  const sha256Hash = createHash("sha256");
  const sha512Hash = createHash("sha512");
  for await (const chunk of createReadStream(path)) {
    sha256Hash.update(chunk);
    sha512Hash.update(chunk);
  }
  return { sha256: sha256Hash.digest("hex"), sha512: sha512Hash.digest("base64") };
}

function requireCommit(value) {
  if (!COMMIT_PATTERN.test(value)) throw new Error("The release commit must be a full Git SHA.");
}

function requireString(value, description) {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new Error(`${description} must be a non-empty string.`);
  }
  return value;
}

function requireExactKeys(value, keys, description) {
  if (!isRecord(value)) throw new Error(`${description} must be an object.`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${description} contains missing or unsupported fields.`);
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSha512(value) {
  if (typeof value !== "string" || value.length === 0) return false;
  const decoded = Buffer.from(value, "base64");
  return decoded.length === 64 && decoded.toString("base64") === value;
}

function isIsoDate(value) {
  return (
    typeof value === "string" && ISO_DATE_PATTERN.test(value) && Number.isFinite(Date.parse(value))
  );
}

async function writeOutputs(path, values) {
  for (const [key, value] of Object.entries(values)) {
    if (!/^[a-z][a-z0-9_-]*$/u.test(key) || typeof value !== "string" || /[\r\n]/u.test(value)) {
      throw new Error("Invalid GitHub Actions output.");
    }
    await appendFile(path, `${key}=${value}\n`, "utf8");
  }
}

async function main() {
  const command = process.argv[2];
  const { values } = parseArgs({
    args: process.argv.slice(3),
    strict: true,
    options: {
      root: { type: "string" },
      commit: { type: "string" },
      version: { type: "string" },
      candidate: { type: "string" },
      archiveTests: { type: "string" },
      directory: { type: "string" },
      local: { type: "string" },
      remote: { type: "string" },
      repository: { type: "string" },
      tag: { type: "string" },
      plan: { type: "string" },
      publishedAt: { type: "string" },
      output: { type: "string" },
    },
  });
  const root = resolve(values.root ?? ".");
  if (command === "prepare") {
    const prepared = await preparePreview({
      root,
      commit: requiredOption(values.commit, "commit"),
    });
    await writeOutputs(requiredOption(values.output, "output"), prepared);
  } else if (command === "record-acceptance") {
    await recordAcceptance({
      root,
      commit: requiredOption(values.commit, "commit"),
      candidatePath: resolve(requiredOption(values.candidate, "candidate")),
      archiveTestsPath: resolve(requiredOption(values.archiveTests, "archiveTests")),
      outputPath: resolve(requiredOption(values.output, "output")),
    });
  } else if (command === "verify-publish") {
    const verified = await verifyPublishInput({
      root,
      commit: requiredOption(values.commit, "commit"),
      version: requiredOption(values.version, "version"),
      directory: resolve(requiredOption(values.directory, "directory")),
    });
    await writeOutputs(requiredOption(values.output, "output"), {
      version: verified.version,
      tag: verified.tag,
      notes: verified.notes,
      notarized: String(verified.notarized),
    });
  } else if (command === "verify-remote") {
    await verifyRemoteAssets({
      localDirectory: resolve(requiredOption(values.local, "local")),
      remoteDirectory: resolve(requiredOption(values.remote, "remote")),
    });
  } else if (command === "inspect-remote") {
    const plan = await inspectRemoteRelease({
      repository: requiredOption(values.repository, "repository"),
      tag: requiredOption(values.tag, "tag"),
      commit: requiredOption(values.commit, "commit"),
      localDirectory: values.local ? resolve(values.local) : undefined,
      remoteDirectory: values.remote ? resolve(values.remote) : undefined,
      token: process.env.GH_TOKEN,
    });
    if (values.plan) await writeJsonAtomic(resolve(values.plan), plan);
    if (values.output) await writeOutputs(values.output, { action: plan.action });
  } else if (command === "catalog") {
    await createPreviewCatalog({
      candidatePath: resolve(requiredOption(values.candidate, "candidate")),
      publishedAt: requiredOption(values.publishedAt, "publishedAt"),
      outputPath: resolve(requiredOption(values.output, "output")),
    });
  } else {
    throw new Error("Unknown release-preview command.");
  }
}

function requiredOption(value, name) {
  if (!value) throw new Error(`Missing --${name}.`);
  return value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
