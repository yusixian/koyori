import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, lstat, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
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
  "packagedApplication",
  "upgrade",
];
const UPGRADE_KEYS = ["status", "reason"];

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
  now = new Date(),
}) {
  const packageJson = await readJson(join(root, "package.json"), "root package");
  const version = requireString(packageJson.version, "root package version");
  const candidate = await readCandidate(candidatePath, { version, commit });
  await verifyCandidateArtifacts(dirname(candidatePath), candidate);
  await verifyUpdateMetadata(dirname(candidatePath), candidate);
  const candidateSha256 = await sha256(candidatePath);
  const acceptance = {
    schemaVersion: 1,
    version,
    commit,
    candidateSha256,
    acceptedAt: now.toISOString(),
    platform: "darwin",
    arch: "arm64",
    packagedApplication: "mac-arm64/Koyori.app",
    upgrade: {
      status: "not-applicable",
      reason: "first-public-release",
    },
  };
  await writeJsonAtomic(outputPath, acceptance);
  return acceptance;
}

export async function verifyPublishInput({ root, directory, commit, version }) {
  requireCommit(commit);
  assertAlphaVersion(version);
  const packageJson = await readJson(join(root, "package.json"), "root package");
  if (packageJson.version !== version) {
    throw new Error("The release version does not match the checked out package version.");
  }
  await requireRegularFile(join(root, `docs/releases/v${version}.md`), "release notes");

  const candidatePath = join(directory, "candidate.json");
  const acceptancePath = join(directory, "acceptance.json");
  const candidate = await readCandidate(candidatePath, { version, commit });
  const expectedFiles = [
    "candidate.json",
    "acceptance.json",
    ...expectedPublicArtifactNames(version, true),
  ];
  await requireExactFiles(directory, expectedFiles);
  await verifyCandidateArtifacts(directory, candidate);
  await verifyUpdateMetadata(directory, candidate);

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
    signing: "notarized",
    installation: "automatic",
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
  if (
    candidate.dirty !== false ||
    candidate.platform !== "darwin" ||
    candidate.arch !== "arm64" ||
    candidate.minimumSystemVersion !== MAC_MINIMUM_SYSTEM_VERSION ||
    candidate.distribution !== "preview-candidate" ||
    candidate.signing !== "notarized" ||
    candidate.notarized !== true
  ) {
    throw new Error("candidate.json is not a clean, notarized Apple Silicon preview candidate.");
  }
  if (!Array.isArray(candidate.artifacts)) {
    throw new Error("candidate.json artifacts must be an array.");
  }
  const expectedNames = expectedPublicArtifactNames(version, true);
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
    const [digest, info] = await Promise.all([sha256(path), lstat(path)]);
    if (digest !== artifact.sha256 || info.size !== artifact.bytes) {
      throw new Error(`${artifact.file} does not match candidate.json.`);
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
    acceptance.packagedApplication !== "mac-arm64/Koyori.app"
  ) {
    throw new Error("acceptance.json does not describe this packaged candidate.");
  }
  if (!isRecord(acceptance.upgrade)) throw new Error("acceptance.json upgrade is invalid.");
  requireExactKeys(acceptance.upgrade, UPGRADE_KEYS, "acceptance upgrade");
  if (
    acceptance.upgrade.status !== "not-applicable" ||
    acceptance.upgrade.reason !== "first-public-release"
  ) {
    throw new Error("This first-release workflow cannot claim an upgrade was verified.");
  }
  return acceptance;
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
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
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
      directory: { type: "string" },
      local: { type: "string" },
      remote: { type: "string" },
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
    });
  } else if (command === "verify-remote") {
    await verifyRemoteAssets({
      localDirectory: resolve(requiredOption(values.local, "local")),
      remoteDirectory: resolve(requiredOption(values.remote, "remote")),
    });
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
