import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";

import type { ClientId } from "./types.ts";
import type { UsageEvidence, UsageIssue } from "./usage-types.ts";

export const MAX_USAGE_CACHE_FILES = 5_000;
export const MAX_USAGE_CACHE_BYTES = 64 * 1024 * 1024;

export interface UsageFileFingerprint {
  dev: string;
  ino: string;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  digest: string;
}

export interface UsageCachedCall {
  skillName: string;
  toolUseId: string | null;
  fallbackUuid: string | null;
  blockIndex: number;
  at: string;
  sessionId: string | null;
  agentId: string | null;
  evidence: UsageEvidence;
}

export interface UsageCachedRequest {
  skillName: string;
  uuid: string;
  at: string;
  sessionId: string | null;
  agentId: string | null;
  evidence: UsageEvidence;
}

export interface UsageCachedResult {
  toolUseId: string;
  failed: boolean;
  evidence: UsageEvidence;
}

export interface UsageCachedParsedFile {
  reservedRecords: number;
  recordsRead: number;
  malformedLines: number;
  messageRecords: number;
  clientVersions: string[];
  firstRecord: { at: string; ms: number } | null;
  lastRecord: { at: string; ms: number } | null;
  calls: UsageCachedCall[];
  requests: UsageCachedRequest[];
  results: UsageCachedResult[];
  limitations: string[];
}

export interface UsageFileCacheEntry {
  sourceId: string;
  client: ClientId;
  rootPath: string;
  file: string;
  fingerprint: UsageFileFingerprint;
  parsed: UsageCachedParsedFile;
  issues: UsageIssue[];
}

export interface UsageImportCache {
  version: 1;
  files: Record<string, UsageFileCacheEntry>;
}

interface FingerprintInput {
  dev: number | bigint;
  ino: number | bigint;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

function digest(...parts: string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(part);
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function createUsageImportCache(): UsageImportCache {
  return { version: 1, files: {} };
}

export function usageFileCacheKey(
  sourceId: string,
  client: ClientId,
  rootPath: string,
  file: string,
): string {
  return digest(sourceId, client, rootPath, file);
}

export function usageFileFingerprint(stats: FingerprintInput): UsageFileFingerprint {
  const dev = String(stats.dev);
  const ino = String(stats.ino);
  const size = stats.size;
  const mtimeMs = stats.mtimeMs;
  const ctimeMs = stats.ctimeMs;
  return {
    dev,
    ino,
    size,
    mtimeMs,
    ctimeMs,
    digest: digest(dev, ino, String(size), String(mtimeMs), String(ctimeMs)),
  };
}

export function sameUsageFileFingerprint(
  left: UsageFileFingerprint,
  right: UsageFileFingerprint,
): boolean {
  return (
    left.digest === right.digest &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

export function boundUsageImportCache(
  entries: Iterable<readonly [string, UsageFileCacheEntry]>,
): UsageImportCache {
  const files: Record<string, UsageFileCacheEntry> = {};
  let bytes = Buffer.byteLength('{"version":1,"files":{}}');
  let count = 0;
  for (const [key, entry] of [...entries].sort(([left], [right]) => left.localeCompare(right))) {
    if (count >= MAX_USAGE_CACHE_FILES) break;
    const entryBytes =
      Buffer.byteLength(JSON.stringify(key)) + Buffer.byteLength(JSON.stringify(entry)) + 2;
    if (bytes + entryBytes > MAX_USAGE_CACHE_BYTES) continue;
    files[key] = entry;
    bytes += entryBytes;
    count += 1;
  }
  return { version: 1, files };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function boundedText(value: unknown, max = 4096): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function nonnegativeInteger(value: unknown, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max;
}

function finiteNonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function client(value: unknown): value is ClientId {
  return value === "claude-code" || value === "codex";
}

function relativeFile(value: unknown): value is string {
  return (
    boundedText(value) &&
    !isAbsolute(value) &&
    !value.split(/[\\/]/).includes("..") &&
    value !== "."
  );
}

function date(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && Number.isFinite(Date.parse(value));
}

function nullableText(value: unknown, max = 256): value is string | null {
  return value === null || boundedText(value, max);
}

function evidence(value: unknown, sourceId: string, file: string): value is UsageEvidence {
  return (
    record(value) &&
    onlyKeys(value, ["sourceId", "file", "line"]) &&
    value.sourceId === sourceId &&
    value.file === file &&
    nonnegativeInteger(value.line) &&
    value.line >= 1
  );
}

function issue(value: unknown, sourceId: string, file: string): value is UsageIssue {
  return (
    record(value) &&
    onlyKeys(value, ["sourceId", "code", "message", "file", "line"]) &&
    value.sourceId === sourceId &&
    ["unreadable", "malformed", "unsupported", "limit", "link", "identity"].includes(
      String(value.code),
    ) &&
    boundedText(value.message, 16_384) &&
    (value.file === undefined || value.file === file) &&
    (value.line === undefined || (nonnegativeInteger(value.line) && value.line >= 1))
  );
}

function fingerprint(value: unknown): value is UsageFileFingerprint {
  return (
    record(value) &&
    onlyKeys(value, ["dev", "ino", "size", "mtimeMs", "ctimeMs", "digest"]) &&
    /^\d+$/.test(String(value.dev)) &&
    /^\d+$/.test(String(value.ino)) &&
    finiteNonnegative(value.size) &&
    finiteNonnegative(value.mtimeMs) &&
    finiteNonnegative(value.ctimeMs) &&
    typeof value.digest === "string" &&
    /^[a-f0-9]{64}$/.test(value.digest) &&
    value.digest ===
      digest(
        String(value.dev),
        String(value.ino),
        String(value.size),
        String(value.mtimeMs),
        String(value.ctimeMs),
      )
  );
}

function parsedFile(
  value: unknown,
  sourceId: string,
  file: string,
): value is UsageCachedParsedFile {
  if (!record(value)) return false;
  if (
    !onlyKeys(value, [
      "reservedRecords",
      "recordsRead",
      "malformedLines",
      "messageRecords",
      "clientVersions",
      "firstRecord",
      "lastRecord",
      "calls",
      "requests",
      "results",
      "limitations",
    ]) ||
    !nonnegativeInteger(value.reservedRecords, 250_000) ||
    !nonnegativeInteger(value.recordsRead, 250_000) ||
    !nonnegativeInteger(value.malformedLines, 250_000) ||
    !nonnegativeInteger(value.messageRecords, 250_000) ||
    value.recordsRead + value.malformedLines > value.reservedRecords ||
    !Array.isArray(value.clientVersions) ||
    value.clientVersions.length > 1_000 ||
    !value.clientVersions.every((entry) => boundedText(entry, 64)) ||
    !Array.isArray(value.limitations) ||
    value.limitations.length > 1_000 ||
    !value.limitations.every((entry) => boundedText(entry, 16_384))
  ) {
    return false;
  }
  const validRecord = (candidate: unknown) =>
    candidate === null ||
    (record(candidate) &&
      onlyKeys(candidate, ["at", "ms"]) &&
      date(candidate.at) &&
      finiteNonnegative(candidate.ms));
  if (!validRecord(value.firstRecord) || !validRecord(value.lastRecord)) return false;
  if (
    !Array.isArray(value.calls) ||
    !Array.isArray(value.requests) ||
    !Array.isArray(value.results) ||
    value.calls.length + value.requests.length > 50_000 ||
    value.results.length > 250_000
  ) {
    return false;
  }
  const validCall = value.calls.every(
    (candidate) =>
      record(candidate) &&
      onlyKeys(candidate, [
        "skillName",
        "toolUseId",
        "fallbackUuid",
        "blockIndex",
        "at",
        "sessionId",
        "agentId",
        "evidence",
      ]) &&
      boundedText(candidate.skillName, 128) &&
      nullableText(candidate.toolUseId) &&
      nullableText(candidate.fallbackUuid) &&
      nonnegativeInteger(candidate.blockIndex, 100_000) &&
      date(candidate.at) &&
      nullableText(candidate.sessionId) &&
      nullableText(candidate.agentId) &&
      evidence(candidate.evidence, sourceId, file),
  );
  const validRequests = value.requests.every(
    (candidate) =>
      record(candidate) &&
      onlyKeys(candidate, ["skillName", "uuid", "at", "sessionId", "agentId", "evidence"]) &&
      boundedText(candidate.skillName, 128) &&
      boundedText(candidate.uuid, 256) &&
      date(candidate.at) &&
      nullableText(candidate.sessionId) &&
      nullableText(candidate.agentId) &&
      evidence(candidate.evidence, sourceId, file),
  );
  const validResults = value.results.every(
    (candidate) =>
      record(candidate) &&
      onlyKeys(candidate, ["toolUseId", "failed", "evidence"]) &&
      boundedText(candidate.toolUseId, 256) &&
      typeof candidate.failed === "boolean" &&
      evidence(candidate.evidence, sourceId, file),
  );
  return validCall && validRequests && validResults;
}

function cacheEntry(value: unknown): value is UsageFileCacheEntry {
  if (
    !record(value) ||
    !onlyKeys(value, [
      "sourceId",
      "client",
      "rootPath",
      "file",
      "fingerprint",
      "parsed",
      "issues",
    ]) ||
    !boundedText(value.sourceId) ||
    !client(value.client) ||
    !boundedText(value.rootPath) ||
    !isAbsolute(value.rootPath) ||
    !relativeFile(value.file) ||
    !fingerprint(value.fingerprint) ||
    !parsedFile(value.parsed, value.sourceId, value.file) ||
    !Array.isArray(value.issues) ||
    value.issues.length > 1_000
  ) {
    return false;
  }
  const sourceId = value.sourceId;
  const file = value.file;
  return value.issues.every((entry) => issue(entry, sourceId, file));
}

export function isUsageImportCache(value: unknown): value is UsageImportCache {
  if (
    !record(value) ||
    !onlyKeys(value, ["version", "files"]) ||
    value.version !== 1 ||
    !record(value.files)
  )
    return false;
  const entries = Object.entries(value.files);
  if (entries.length > MAX_USAGE_CACHE_FILES) return false;
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_USAGE_CACHE_BYTES) return false;
  return entries.every(
    ([key, entry]) =>
      /^[a-f0-9]{64}$/.test(key) &&
      cacheEntry(entry) &&
      key === usageFileCacheKey(entry.sourceId, entry.client, entry.rootPath, entry.file),
  );
}
