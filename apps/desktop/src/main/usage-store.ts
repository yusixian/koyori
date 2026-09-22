import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import type {
  HistoryCoverage,
  HistorySource,
  SkillPreference,
  UsageEvent,
  UsageImportCache,
  UsageIssue,
  UsageRules,
  UsageState,
} from "@koyori/core";
import { createUsageImportCache, isUsageImportCache } from "@koyori/core";

export interface CollectionState {
  version: 1;
  enabled: boolean;
  candidateIds: string[];
  lastAttemptAt: string | null;
  error: string | null;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4096;
}
function date(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
function nullableDate(value: unknown): value is string | null {
  return value === null || date(value);
}
function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}
function client(value: unknown) {
  return value === "claude-code" || value === "codex";
}
function isSource(value: unknown): value is HistorySource {
  return (
    record(value) &&
    text(value.id) &&
    text(value.rootId) &&
    (value.rootIds === undefined ||
      (Array.isArray(value.rootIds) &&
        value.rootIds.length > 0 &&
        value.rootIds.length <= 100 &&
        value.rootIds.every(text) &&
        new Set(value.rootIds).size === value.rootIds.length)) &&
    client(value.client) &&
    text(value.path) &&
    isAbsolute(value.path) &&
    text(value.label) &&
    typeof value.enabled === "boolean"
  );
}
function isEvent(value: unknown): value is UsageEvent {
  return (
    record(value) &&
    text(value.id) &&
    client(value.client) &&
    text(value.skillName) &&
    (value.sessionKey === null || text(value.sessionKey)) &&
    date(value.at) &&
    (value.kind === "invocation" || value.kind === "request") &&
    ["loaded", "failed", "unresolved"].includes(String(value.status)) &&
    (value.resultConflict === undefined || value.resultConflict === true) &&
    Array.isArray(value.evidence) &&
    value.evidence.length > 0 &&
    value.evidence.every(
      (item) =>
        record(item) &&
        text(item.sourceId) &&
        text(item.file) &&
        !isAbsolute(item.file) &&
        !item.file.split(/[\\/]/).includes("..") &&
        integer(item.line, 1),
    )
  );
}
function isCoverage(value: unknown): value is HistoryCoverage {
  return (
    record(value) &&
    text(value.sourceId) &&
    text(value.adapter) &&
    ["supported", "unsupported", "empty", "unreadable"].includes(String(value.status)) &&
    date(value.scannedAt) &&
    typeof value.readLimited === "boolean" &&
    integer(value.filesRead) &&
    (value.cachedFiles === undefined || integer(value.cachedFiles)) &&
    integer(value.recordsRead) &&
    integer(value.malformedLines) &&
    integer(value.skippedFiles) &&
    nullableDate(value.firstRecordAt) &&
    nullableDate(value.lastRecordAt) &&
    Array.isArray(value.clientVersions) &&
    value.clientVersions.every(text) &&
    Array.isArray(value.limitations) &&
    value.limitations.every(text)
  );
}
function isIssue(value: unknown): value is UsageIssue {
  return (
    record(value) &&
    text(value.sourceId) &&
    text(value.message) &&
    ["unreadable", "malformed", "unsupported", "limit", "link", "identity"].includes(
      String(value.code),
    ) &&
    (value.file === undefined ||
      (text(value.file) && !isAbsolute(value.file) && !value.file.split(/[\\/]/).includes(".."))) &&
    (value.line === undefined || integer(value.line, 1))
  );
}
export function isPreference(value: unknown): value is SkillPreference {
  return (
    record(value) &&
    typeof value.keep === "boolean" &&
    nullableDate(value.reviewAfter) &&
    date(value.firstSeenAt)
  );
}
export function isUsageRules(value: unknown): value is UsageRules {
  return (
    record(value) &&
    integer(value.idleDays, 1, 365) &&
    integer(value.lowUseThreshold, 0, 100) &&
    integer(value.graceDays, 0, 365)
  );
}
export function isPreferencePatch(
  value: unknown,
): value is { keep?: boolean; reviewAfter?: string | null } {
  return (
    record(value) &&
    Object.keys(value).length > 0 &&
    Object.keys(value).every((key) => key === "keep" || key === "reviewAfter") &&
    (value.keep === undefined || typeof value.keep === "boolean") &&
    (value.reviewAfter === undefined || nullableDate(value.reviewAfter))
  );
}
function isUsageState(value: unknown): value is UsageState {
  return (
    record(value) &&
    value.version === 1 &&
    Array.isArray(value.sources) &&
    value.sources.every(isSource) &&
    Array.isArray(value.events) &&
    value.events.every(isEvent) &&
    Array.isArray(value.coverage) &&
    value.coverage.every(isCoverage) &&
    Array.isArray(value.issues) &&
    value.issues.every(isIssue) &&
    record(value.preferences) &&
    Object.values(value.preferences).every(isPreference) &&
    isUsageRules(value.rules) &&
    nullableDate(value.lastImportedAt) &&
    nullableDate(value.lastReviewedAt)
  );
}

export async function readUsageState(path: string, empty: () => UsageState): Promise<UsageState> {
  try {
    if ((await stat(path)).size > 64 * 1024 * 1024)
      throw new Error("Usage ledger exceeds the supported size; preserve it before exporting.");
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isUsageState(value))
      throw new Error("Usage ledger has an unsupported or invalid format; it was preserved.");
    return value;
  } catch (error) {
    if (record(error) && error.code === "ENOENT") return empty();
    throw error;
  }
}

export async function writeUsageState(path: string, next: UsageState): Promise<void> {
  if (!isUsageState(next)) throw new Error("Invalid usage state; previous ledger was preserved.");
  const serialized = JSON.stringify(next);
  if (Buffer.byteLength(serialized) > 64 * 1024 * 1024)
    throw new Error("Usage ledger is full; no records were discarded.");
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    try {
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await copyFile(path, `${path}.bak`);
    } catch (error) {
      if (!record(error) || error.code !== "ENOENT") throw error;
    }
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch((error: unknown) => {
      if (!record(error) || error.code !== "ENOENT") throw error;
    });
  }
}

export async function readUsageCache(path: string): Promise<UsageImportCache> {
  try {
    if ((await stat(path)).size > 64 * 1024 * 1024)
      throw new Error("Usage cache exceeds the supported size and was ignored.");
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isUsageImportCache(value)) throw new Error("Usage cache has an invalid format.");
    return value;
  } catch (error) {
    if (record(error) && error.code === "ENOENT") return createUsageImportCache();
    throw error;
  }
}

export async function writeUsageCache(path: string, next: UsageImportCache): Promise<void> {
  if (!isUsageImportCache(next))
    throw new Error("Invalid usage cache; previous cache was preserved.");
  await writePrivateJson(path, JSON.stringify(next));
}

export function createCollectionState(): CollectionState {
  return { version: 1, enabled: false, candidateIds: [], lastAttemptAt: null, error: null };
}

function isCollectionState(value: unknown): value is CollectionState {
  return (
    record(value) &&
    value.version === 1 &&
    typeof value.enabled === "boolean" &&
    Array.isArray(value.candidateIds) &&
    value.candidateIds.length <= 100 &&
    value.candidateIds.every(text) &&
    nullableDate(value.lastAttemptAt) &&
    (value.error === null || text(value.error))
  );
}

export async function readCollectionState(path: string): Promise<CollectionState> {
  try {
    if ((await stat(path)).size > 1024 * 1024)
      throw new Error("Collection settings exceed the supported size; they were preserved.");
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isCollectionState(value))
      throw new Error("Collection settings have an unsupported format; they were preserved.");
    return value;
  } catch (error) {
    if (record(error) && error.code === "ENOENT") return createCollectionState();
    throw error;
  }
}

export async function writeCollectionState(path: string, next: CollectionState): Promise<void> {
  if (!isCollectionState(next))
    throw new Error("Invalid collection settings; previous settings were preserved.");
  await writePrivateJson(path, JSON.stringify(next));
}

async function writePrivateJson(path: string, serialized: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    try {
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch((error: unknown) => {
      if (!record(error) || error.code !== "ENOENT") throw error;
    });
  }
}
