import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

import type { ResourceRoot } from "@koyori/core";
import type { DiscoveredRoot } from "../../../../packages/core/src/discover-sources.ts";

export interface StoredResourceRoot extends ResourceRoot {
  /** Canonical identity retained for symlinked automatic roots across restarts. */
  canonicalPath?: string;
}

export interface SourceSettingsV2 {
  version: 2;
  roots: StoredResourceRoot[];
  ignoredPaths: string[];
  automaticDiscovery: boolean;
  projects: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function absolutePath(value: unknown): value is string {
  return nonEmptyString(value) && isAbsolute(value);
}

function isRoot(value: unknown): value is ResourceRoot {
  return (
    isRecord(value) &&
    nonEmptyString(value.id) &&
    (value.client === "claude-code" || value.client === "codex") &&
    absolutePath(value.path) &&
    nonEmptyString(value.label)
  );
}

function normalizedPaths(values: unknown, field: string): string[] {
  if (!Array.isArray(values) || !values.every(absolutePath)) {
    throw new Error(`Invalid source settings: ${field} must contain absolute paths.`);
  }
  return [...new Set(values.map((value) => resolve(value)))].sort();
}

function normalizedRoots(values: unknown): StoredResourceRoot[] {
  if (!Array.isArray(values) || !values.every(isRoot)) {
    throw new Error("Invalid source settings: roots are malformed.");
  }
  return values.map((root) => ({
    id: root.id,
    client: root.client,
    path: resolve(root.path),
    label: root.label,
    ...("canonicalPath" in root && absolutePath(root.canonicalPath)
      ? { canonicalPath: resolve(root.canonicalPath) }
      : {}),
  }));
}

function settingsV2(value: Record<string, unknown>): SourceSettingsV2 {
  if (value.version !== 2 || typeof value.automaticDiscovery !== "boolean") {
    throw new Error("Invalid source settings: unsupported version or discovery flag.");
  }
  return {
    version: 2,
    roots: normalizedRoots(value.roots),
    ignoredPaths: normalizedPaths(value.ignoredPaths, "ignoredPaths"),
    automaticDiscovery: value.automaticDiscovery,
    projects: normalizedPaths(value.projects, "projects"),
  };
}

function settingsV1(value: Record<string, unknown>): SourceSettingsV2 {
  if (value.version !== 1) {
    throw new Error("Invalid source settings: unsupported version.");
  }
  return {
    version: 2,
    roots: normalizedRoots(value.roots),
    ignoredPaths: [],
    automaticDiscovery: true,
    projects: [],
  };
}

export function emptySourceSettings(): SourceSettingsV2 {
  return {
    version: 2,
    roots: [],
    ignoredPaths: [],
    automaticDiscovery: true,
    projects: [],
  };
}

/** Parse without writing. A v1 value is returned as its v2 representation. */
export function parseSourceSettings(value: unknown): SourceSettingsV2 {
  if (!isRecord(value)) throw new Error("Invalid source settings: expected an object.");
  if (value.version === 1) return settingsV1(value);
  return settingsV2(value);
}

function errorCode(error: unknown): string | undefined {
  if (!isRecord(error) || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

/**
 * Read the source settings without silently replacing a corrupt file.
 * A valid v1 file is migrated and persisted through the same backup path.
 */
export async function readSourceSettings(path: string): Promise<SourceSettingsV2> {
  try {
    const raw = await readFile(path, "utf8");
    const value: unknown = JSON.parse(raw);
    const parsed = parseSourceSettings(value);
    if (isRecord(value) && value.version === 1) {
      await writeSourceSettings(path, parsed);
    }
    return parsed;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return emptySourceSettings();
    throw error;
  }
}

/**
 * Validate, back up, and atomically replace a source settings file. The old
 * file is copied to `.bak` before the rename; any failure leaves the current
 * settings in place and removes the temporary file.
 */
export async function writeSourceSettings(path: string, next: SourceSettingsV2): Promise<void> {
  const parsed = parseSourceSettings(next);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    await handle.writeFile(`${JSON.stringify(parsed, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;

    try {
      await stat(path);
      await copyFile(path, `${path}.bak`);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
    await rename(temporary, path);
  } finally {
    if (handle) await handle.close().catch(() => {});
    await unlink(temporary).catch((error: unknown) => {
      if (errorCode(error) !== "ENOENT") throw error;
    });
  }
}

function rootCanonicalPath(root: ResourceRoot): string {
  const candidate = root as ResourceRoot & { canonicalPath?: unknown };
  return typeof candidate.canonicalPath === "string" && isAbsolute(candidate.canonicalPath)
    ? resolve(candidate.canonicalPath)
    : resolve(root.path);
}

function sameRoot(left: ResourceRoot, right: DiscoveredRoot): boolean {
  return (
    left.client === right.client &&
    (rootCanonicalPath(left) === resolve(right.canonicalPath) ||
      resolve(left.path) === resolve(right.path))
  );
}

/** Merge a discovery refresh while retaining user root IDs and manual roots. */
export function mergeDiscoveredRoots(
  settings: SourceSettingsV2,
  discovered: readonly DiscoveredRoot[],
): SourceSettingsV2 {
  const roots = [...settings.roots];
  for (const candidate of discovered) {
    if (settings.ignoredPaths.includes(resolve(candidate.canonicalPath))) continue;
    const existing = roots.find((root) => sameRoot(root, candidate));
    if (existing) {
      // Keep the persisted ID and user label, but retain the canonical identity
      // so a symlinked automatic root remains deduplicated after restart.
      if (rootCanonicalPath(existing) !== resolve(candidate.canonicalPath)) {
        const index = roots.indexOf(existing);
        roots[index] = { ...existing, canonicalPath: resolve(candidate.canonicalPath) };
      } else if (existing.canonicalPath === undefined) {
        const index = roots.indexOf(existing);
        roots[index] = { ...existing, canonicalPath: resolve(candidate.canonicalPath) };
      }
      continue;
    }
    roots.push({
      id: candidate.id,
      client: candidate.client,
      path: resolve(candidate.path),
      label: candidate.label,
      canonicalPath: resolve(candidate.canonicalPath),
    });
  }
  return { ...settings, roots };
}

/** Disconnect an automatic root and remember its canonical path permanently. */
export function disconnectAutomaticRoot(
  settings: SourceSettingsV2,
  canonicalPath: string,
): SourceSettingsV2 {
  const ignored = resolve(canonicalPath);
  return {
    ...settings,
    roots: settings.roots.filter((root) => rootCanonicalPath(root) !== ignored),
    ignoredPaths: [...new Set([...settings.ignoredPaths, ignored])].sort(),
  };
}

/** Explicitly allow a previously disconnected automatic path to reappear. */
export function resetIgnoredPath(
  settings: SourceSettingsV2,
  canonicalPath: string,
): SourceSettingsV2 {
  const reset = resolve(canonicalPath);
  return {
    ...settings,
    ignoredPaths: settings.ignoredPaths.filter((path) => resolve(path) !== reset),
  };
}
