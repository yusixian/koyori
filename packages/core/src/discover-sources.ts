import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, opendir, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import type { ClientId, ResourceRoot } from "./types.ts";

export type DiscoveryScope = "user" | "project" | "system";
export type DiscoveryRootKind = "standard" | "legacy" | "shared";

export interface DiscoveredRoot extends ResourceRoot {
  origin: "detected";
  scope: DiscoveryScope;
  readOnly: boolean;
  canonicalPath: string;
  kind: DiscoveryRootKind;
  sharedGroupId?: string;
  sharedClients: ClientId[];
}

export type HistorySourceKind = "config" | "projects" | "sessions" | "archived_sessions";

/** A candidate only describes a readable history location; it never imports it. */
export interface HistorySourceCandidate {
  id: string;
  client: ClientId;
  path: string;
  label: string;
  profile: string | null;
  rootId: string | null;
  rootIds: string[];
  scope: DiscoveryScope;
  kind: HistorySourceKind;
  canonicalPath: string;
  readOnly: true;
}

export interface DiscoveryTarget {
  id: string;
  client: ClientId;
  path: string;
  label: string;
  scope: DiscoveryScope;
  kind: DiscoveryRootKind;
  canonicalPath: string;
  exists: boolean;
  writable: boolean;
  readOnly: boolean;
  sharedGroupId?: string;
}

export type DiscoveryIssueCode = "missing" | "unreadable" | "invalid" | "duplicate" | "symlink";

export interface DiscoveryIssue {
  path: string;
  code: DiscoveryIssueCode;
  message: string;
  severity: "warning" | "error";
}

export interface DiscoverSourcesOptions {
  /** The user's home directory. It is explicit so discovery stays testable and deterministic. */
  home: string;
  /** CODEX_HOME. When omitted, the conventional <home>/.codex directory is used. */
  codexHome?: string;
  /** CLAUDE_CONFIG_DIR. When omitted, the conventional <home>/.claude directory is used. */
  claudeConfigDir?: string;
  /** Explicit project directories. Discovery never searches the whole filesystem. */
  projects?: string[];
}

export interface DiscoverSourcesResult {
  roots: DiscoveredRoot[];
  histories: HistorySourceCandidate[];
  issues: DiscoveryIssue[];
  targets: DiscoveryTarget[];
}

interface RootSpec {
  path: string;
  client: ClientId;
  label: string;
  scope: DiscoveryScope;
  kind: DiscoveryRootKind;
  readOnly: boolean;
}

interface HistorySpec {
  path: string;
  client: ClientId;
  label: string;
  profile: string | null;
  scope: DiscoveryScope;
  kind: HistorySourceKind;
}

interface DirectoryProbe {
  state: "exists" | "missing" | "unreadable" | "invalid";
  canonicalPath: string;
  isSymlink: boolean;
}

interface RootEntry {
  spec: RootSpec;
  probe: DirectoryProbe;
}

interface TargetEntry {
  spec: RootSpec;
  probe: DirectoryProbe;
  writable: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errorCode(error: unknown): string | undefined {
  if (!isRecord(error) || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function requireAbsolute(name: string, value: string): string {
  if (!isAbsolute(value)) throw new TypeError(`${name} must be an absolute path`);
  return resolve(value);
}

function stableId(prefix: string, ...parts: string[]): string {
  const hash = createHash("sha256");
  hash.update(prefix);
  for (const part of parts) {
    hash.update("\0");
    hash.update(part);
  }
  return `${prefix}:${hash.digest("hex").slice(0, 24)}`;
}

function sharedId(canonicalPath: string): string {
  return stableId("shared", canonicalPath);
}

function rootKey(client: ClientId, canonicalPath: string): string {
  return `${client}\0${canonicalPath}`;
}

function humanRootLabel(client: ClientId, scope: DiscoveryScope, kind: DiscoveryRootKind): string {
  if (scope === "system") return "Codex system Skills";
  if (kind === "shared") return scope === "project" ? "Project shared Skills" : "Shared Skills";
  if (kind === "legacy")
    return client === "codex" ? "Codex compatibility Skills" : "Compatibility Skills";
  return client === "claude-code"
    ? scope === "project"
      ? "Claude Code project Skills"
      : "Claude Code Skills"
    : scope === "project"
      ? "Codex project Skills"
      : "Codex Skills";
}

async function probeDirectory(path: string): Promise<DirectoryProbe> {
  const absolutePath = resolve(path);
  let link: Awaited<ReturnType<typeof lstat>>;
  try {
    link = await lstat(absolutePath);
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") {
      return { state: "missing", canonicalPath: absolutePath, isSymlink: false };
    }
    return { state: "unreadable", canonicalPath: absolutePath, isSymlink: false };
  }

  let canonicalPath = absolutePath;
  try {
    // Resolve the full path, including symlinked parent directories. This is
    // what prevents a project alias from being discovered twice.
    canonicalPath = await realpath(absolutePath);
  } catch {
    return {
      state: "unreadable",
      canonicalPath: absolutePath,
      isSymlink: link.isSymbolicLink(),
    };
  }
  const isSymlink = link.isSymbolicLink() || canonicalPath !== absolutePath;

  let directory: Awaited<ReturnType<typeof opendir>> | undefined;
  try {
    const information = await stat(absolutePath);
    if (!information.isDirectory()) {
      return { state: "invalid", canonicalPath, isSymlink };
    }
    directory = await opendir(absolutePath);
  } catch (error) {
    return {
      state: errorCode(error) === "ENOTDIR" ? "invalid" : "unreadable",
      canonicalPath,
      isSymlink,
    };
  }
  await directory.close();
  return { state: "exists", canonicalPath, isSymlink };
}

async function nearestWritableDirectory(path: string): Promise<boolean> {
  let candidate = resolve(path);
  while (true) {
    try {
      await access(candidate, constants.W_OK | constants.X_OK);
      return true;
    } catch {
      const parent = dirname(candidate);
      if (parent === candidate) return false;
      candidate = parent;
    }
  }
}

function addIssue(
  issues: DiscoveryIssue[],
  path: string,
  code: DiscoveryIssueCode,
  message: string,
  severity: DiscoveryIssue["severity"] = "warning",
): void {
  issues.push({ path, code, message, severity });
}

function configBase(path: string): string {
  const absolute = resolve(path);
  return basename(absolute).toLowerCase() === "skills" ? dirname(absolute) : absolute;
}

function createRootSpec(
  path: string,
  client: ClientId,
  scope: DiscoveryScope,
  kind: DiscoveryRootKind,
  readOnly = false,
): RootSpec {
  return {
    path: resolve(path),
    client,
    scope,
    kind,
    readOnly,
    label: humanRootLabel(client, scope, kind),
  };
}

function rootFromEntry(entry: RootEntry, clients: ClientId[]): DiscoveredRoot {
  const { spec, probe } = entry;
  const result: DiscoveredRoot = {
    id: stableId("detected", spec.client, probe.canonicalPath),
    client: spec.client,
    path: spec.path,
    label: spec.label,
    origin: "detected",
    scope: spec.scope,
    readOnly: spec.readOnly,
    canonicalPath: probe.canonicalPath,
    kind: spec.kind,
    sharedClients: clients,
  };
  if (clients.length > 1) result.sharedGroupId = sharedId(probe.canonicalPath);
  return result;
}

function targetFromEntry(entry: TargetEntry, clients: ClientId[]): DiscoveryTarget {
  const { spec, probe } = entry;
  const result: DiscoveryTarget = {
    id: stableId("target", spec.client, probe.canonicalPath),
    client: spec.client,
    path: spec.path,
    label: spec.label,
    scope: spec.scope,
    kind: spec.kind,
    canonicalPath: probe.canonicalPath,
    exists: probe.state === "exists",
    writable: entry.writable,
    readOnly: spec.readOnly,
  };
  if (clients.length > 1) result.sharedGroupId = sharedId(probe.canonicalPath);
  return result;
}

function historyRootIds(roots: DiscoveredRoot[], client: ClientId): string[] {
  return roots
    .filter((root) => root.client === client && root.scope !== "system")
    .map((root) => root.id)
    .sort();
}

async function addHistoryCandidate(
  histories: HistorySourceCandidate[],
  issues: DiscoveryIssue[],
  roots: DiscoveredRoot[],
  spec: HistorySpec,
  seen: Set<string>,
): Promise<void> {
  const probe = await probeDirectory(spec.path);
  if (probe.state !== "exists") {
    const message =
      probe.state === "missing"
        ? "History directory was not found; no history will be imported."
        : probe.state === "invalid"
          ? "History candidate is not a directory."
          : "History directory could not be read; no history will be imported.";
    addIssue(issues, spec.path, probe.state, message);
    return;
  }
  if (probe.isSymlink) {
    addIssue(
      issues,
      spec.path,
      "symlink",
      "History candidate is a symbolic link; its canonical path is used for deduplication.",
    );
  }
  const key = `${spec.client}\0${probe.canonicalPath}`;
  if (seen.has(key)) {
    addIssue(issues, spec.path, "duplicate", "Duplicate history path was ignored.");
    return;
  }
  seen.add(key);
  const rootIds = historyRootIds(roots, spec.client);
  histories.push({
    id: stableId("history", spec.client, probe.canonicalPath, spec.kind),
    client: spec.client,
    path: spec.path,
    label: spec.label,
    profile: spec.profile,
    rootId: rootIds[0] ?? null,
    rootIds,
    scope: spec.scope,
    kind: spec.kind,
    canonicalPath: probe.canonicalPath,
    readOnly: true,
  });
}

/**
 * Discover only the documented Claude Code and Codex locations.
 *
 * This function does not create directories, read history contents, or import
 * records. Missing writable locations are returned as deployment candidates so
 * a later, explicitly authorized operation can decide whether to create them.
 */
export async function discoverSources(
  options: DiscoverSourcesOptions,
): Promise<DiscoverSourcesResult> {
  const home = requireAbsolute("home", options.home);
  const claudeConfig = configBase(
    requireAbsolute("claudeConfigDir", options.claudeConfigDir ?? join(home, ".claude")),
  );
  const codexConfig = configBase(
    requireAbsolute("codexHome", options.codexHome ?? join(home, ".codex")),
  );
  const projects = (options.projects ?? []).map((project, index) =>
    requireAbsolute(`projects[${index}]`, project),
  );

  const rootSpecs: RootSpec[] = [
    createRootSpec(join(claudeConfig, "skills"), "claude-code", "user", "standard"),
    createRootSpec(join(home, ".agents", "skills"), "codex", "user", "shared"),
    createRootSpec(join(codexConfig, "skills"), "codex", "user", "legacy"),
    createRootSpec("/etc/codex/skills", "codex", "system", "standard", true),
  ];
  for (const project of projects) {
    rootSpecs.push(
      createRootSpec(join(project, ".claude", "skills"), "claude-code", "project", "standard"),
      createRootSpec(join(project, ".agents", "skills"), "codex", "project", "shared"),
    );
  }

  const issues: DiscoveryIssue[] = [];
  const roots: RootEntry[] = [];
  const targets: TargetEntry[] = [];
  const seenRoots = new Set<string>();
  for (const spec of rootSpecs) {
    const probe = await probeDirectory(spec.path);
    if (probe.state === "exists") {
      if (probe.isSymlink) {
        addIssue(
          issues,
          spec.path,
          "symlink",
          "Resource root is a symbolic link; its canonical path is used for deduplication.",
        );
      }
      const key = rootKey(spec.client, probe.canonicalPath);
      if (seenRoots.has(key)) {
        addIssue(issues, spec.path, "duplicate", "Duplicate resource root was ignored.");
        continue;
      }
      seenRoots.add(key);
      roots.push({ spec, probe });
      continue;
    }

    const message =
      probe.state === "missing"
        ? "Resource root was not found; a deployment candidate is returned when writable."
        : probe.state === "invalid"
          ? "Resource root exists but is not a directory."
          : "Resource root exists but could not be read.";
    addIssue(
      issues,
      spec.path,
      probe.state,
      message,
      probe.state === "unreadable" ? "error" : "warning",
    );
    targets.push({
      spec,
      probe,
      writable: !spec.readOnly && (await nearestWritableDirectory(spec.path)),
    });
  }

  const sharedClientsByPath = new Map<string, Set<ClientId>>();
  for (const entry of roots) {
    const clients = sharedClientsByPath.get(entry.probe.canonicalPath) ?? new Set<ClientId>();
    clients.add(entry.spec.client);
    sharedClientsByPath.set(entry.probe.canonicalPath, clients);
  }
  for (const entry of targets) {
    const clients = sharedClientsByPath.get(entry.probe.canonicalPath) ?? new Set<ClientId>();
    clients.add(entry.spec.client);
    sharedClientsByPath.set(entry.probe.canonicalPath, clients);
  }
  const clientsFor = (canonicalPath: string): ClientId[] =>
    [...(sharedClientsByPath.get(canonicalPath) ?? new Set<ClientId>())].sort();

  const discoveredRoots = roots.map((entry) =>
    rootFromEntry(entry, clientsFor(entry.probe.canonicalPath)),
  );
  const discoveredTargets = targets.map((entry) =>
    targetFromEntry(entry, clientsFor(entry.probe.canonicalPath)),
  );

  const histories: HistorySourceCandidate[] = [];
  const seenHistories = new Set<string>();
  const claudeProfile = stableId("profile", "claude-code", claudeConfig);
  const codexProfile = stableId("profile", "codex", codexConfig);
  await addHistoryCandidate(
    histories,
    issues,
    discoveredRoots,
    {
      path: join(claudeConfig, "projects"),
      client: "claude-code",
      label: "Claude Code projects",
      profile: claudeProfile,
      scope: "user",
      kind: "projects",
    },
    seenHistories,
  );
  await addHistoryCandidate(
    histories,
    issues,
    discoveredRoots,
    {
      path: join(codexConfig, "sessions"),
      client: "codex",
      label: "Codex sessions",
      profile: codexProfile,
      scope: "user",
      kind: "sessions",
    },
    seenHistories,
  );
  await addHistoryCandidate(
    histories,
    issues,
    discoveredRoots,
    {
      path: join(codexConfig, "archived_sessions"),
      client: "codex",
      label: "Codex archived sessions",
      profile: codexProfile,
      scope: "user",
      kind: "archived_sessions",
    },
    seenHistories,
  );

  return {
    roots: discoveredRoots,
    histories,
    issues,
    targets: discoveredTargets,
  };
}
