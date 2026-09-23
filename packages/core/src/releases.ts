import { parse, prerelease, valid } from "semver";

export interface ReleaseManifest {
  schemaVersion: 1;
  version: string;
  channel: "preview" | "stable";
  commit: string;
  publishedAt: string;
  platform: "darwin";
  arch: "arm64";
  minimumSystemVersion: string;
  signing: "unsigned" | "signed" | "notarized";
  installation: "automatic" | "manual";
  releaseNotesUrl: string;
  download: {
    url: string;
    sha256: string;
    bytes: number;
  };
}

const MAX_ARTIFACT_BYTES = 1024 * 1024 * 1024;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/iu;
const SHA256_PATTERN = /^[0-9a-f]{64}$/iu;
const SYSTEM_VERSION_PATTERN = /^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*))*$/u;
const ISO_DATE_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;

const MANIFEST_KEYS = [
  "schemaVersion",
  "version",
  "channel",
  "commit",
  "publishedAt",
  "platform",
  "arch",
  "minimumSystemVersion",
  "signing",
  "installation",
  "releaseNotesUrl",
  "download",
] as const;

const DOWNLOAD_KEYS = ["url", "sha256", "bytes"] as const;

export function parseReleaseManifest(input: unknown): ReleaseManifest {
  if (!isRecord(input)) invalid("manifest", "must be an object");
  requireExactKeys(input, MANIFEST_KEYS, "manifest");

  if (input.schemaVersion !== 1) invalid("schemaVersion", "must be 1");
  const version = parseStrictVersion(input.version, "version");

  if (input.channel !== "preview" && input.channel !== "stable") {
    invalid("channel", "must be preview or stable");
  }
  const hasPrerelease = prerelease(version) !== null;
  if (input.channel === "preview" && !hasPrerelease) {
    invalid("channel", "preview releases must have a prerelease version");
  }
  if (input.channel === "stable" && hasPrerelease) {
    invalid("channel", "stable releases cannot have a prerelease version");
  }

  const commit = requireString(input.commit, "commit");
  if (!COMMIT_PATTERN.test(commit)) invalid("commit", "must be 40 hexadecimal characters");

  const publishedAt = requireString(input.publishedAt, "publishedAt");
  if (!isIsoDate(publishedAt)) invalid("publishedAt", "must be a valid ISO timestamp");

  if (input.platform !== "darwin") invalid("platform", "must be darwin");
  if (input.arch !== "arm64") invalid("arch", "must be arm64");

  const minimumSystemVersion = requireString(input.minimumSystemVersion, "minimumSystemVersion");
  if (!SYSTEM_VERSION_PATTERN.test(minimumSystemVersion)) {
    invalid("minimumSystemVersion", "must contain only dotted numeric components");
  }

  if (input.signing !== "unsigned" && input.signing !== "signed" && input.signing !== "notarized") {
    invalid("signing", "must be unsigned, signed, or notarized");
  }
  if (input.installation !== "automatic" && input.installation !== "manual") {
    invalid("installation", "must be automatic or manual");
  }
  if (input.installation === "automatic" && input.signing !== "notarized") {
    invalid("installation", "automatic installation requires notarized signing");
  }

  const releaseNotesUrl = requireString(input.releaseNotesUrl, "releaseNotesUrl");
  const expectedNotesUrl = `https://github.com/yusixian/koyori/releases/tag/v${version}`;
  if (releaseNotesUrl !== expectedNotesUrl) {
    invalid("releaseNotesUrl", "must use the exact GitHub release URL");
  }

  if (!isRecord(input.download)) invalid("download", "must be an object");
  requireExactKeys(input.download, DOWNLOAD_KEYS, "download");
  const downloadUrl = requireString(input.download.url, "download.url");
  const expectedDownloadUrl = `https://github.com/yusixian/koyori/releases/download/v${version}/Koyori-${version}-arm64.dmg`;
  if (downloadUrl !== expectedDownloadUrl) {
    invalid("download.url", "must use the exact GitHub artifact URL");
  }

  const sha256 = requireString(input.download.sha256, "download.sha256");
  if (!SHA256_PATTERN.test(sha256)) {
    invalid("download.sha256", "must be 64 hexadecimal characters");
  }
  const bytes = input.download.bytes;
  if (
    typeof bytes !== "number" ||
    !Number.isSafeInteger(bytes) ||
    bytes <= 0 ||
    bytes > MAX_ARTIFACT_BYTES
  ) {
    invalid("download.bytes", "must be a positive integer no larger than 1 GiB");
  }

  return {
    schemaVersion: 1,
    version,
    channel: input.channel,
    commit,
    publishedAt,
    platform: "darwin",
    arch: "arm64",
    minimumSystemVersion,
    signing: input.signing,
    installation: input.installation,
    releaseNotesUrl,
    download: {
      url: downloadUrl,
      sha256,
      bytes,
    },
  };
}

export function getReleaseChannel(version: string): "preview" | "stable" {
  const parsedVersion = parseStrictVersion(version, "version");
  return prerelease(parsedVersion) === null ? "stable" : "preview";
}

function parseStrictVersion(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    invalid(field, "must be a strict SemVer string");
  }
  if (value.startsWith("v") || value.startsWith("V")) {
    invalid(field, "must omit a leading v");
  }
  const parsed = parse(value);
  if (!parsed || valid(value) === null) invalid(field, "must be a strict SemVer string");
  return value;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) invalid(field, "must be a non-empty string");
  return value;
}

function isIsoDate(value: string): boolean {
  return ISO_DATE_PATTERN.test(value) && Number.isFinite(Date.parse(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  field: string,
): void {
  if (Object.keys(value).length !== keys.length || keys.some((key) => !(key in value))) {
    invalid(field, "contains unsupported or missing fields");
  }
}

function invalid(field: string, reason: string): never {
  throw new Error(`Invalid release manifest: ${field} ${reason}.`);
}
