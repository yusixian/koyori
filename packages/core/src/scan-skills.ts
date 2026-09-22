import { constants, type Dirent, type Stats } from "node:fs";
import { lstat, open, opendir, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseDocument } from "yaml";

import type {
  ResourceRoot,
  ScanIssue,
  ScanSkillsOptions,
  SkillInventory,
  SkillRecord,
} from "./types.ts";

const MAX_SKILL_BYTES = 256 * 1024;
const MAX_DIRECTORY_DEPTH = 24;
const MAX_DISCOVERED_ENTRIES = 10_000;
const MANAGEMENT_WORK_DIRECTORY_PREFIXES = [
  ".koyori-recovery-",
  ".koyori-stage-",
  ".koyori-displaced-",
] as const;

interface AuthorizedRoot {
  root: ResourceRoot;
  absolutePath: string;
  realPath: string;
  isSymlink: boolean;
}

interface WalkState {
  authorizedRoots: AuthorizedRoot[];
  inventory: SkillInventory;
  options: ScanSkillsOptions;
  runtime: ScanRuntime;
  entryCount: number;
  limitReached: boolean;
  cancelled: boolean;
}

interface SkillMetadata {
  name: string;
  description: string;
}

interface ScanRuntime {
  beforeOpen?: (path: string) => Promise<void> | void;
  beforeRead?: (path: string) => Promise<void> | void;
}

class CrossRootLinkError extends Error {}

function issue(
  path: string,
  code: ScanIssue["code"],
  message: string,
  severity: ScanIssue["severity"] = "error",
): ScanIssue {
  return { path, code, message, severity };
}

function isWithin(candidate: string, root: string): boolean {
  const difference = relative(root, candidate);
  return (
    difference === "" ||
    (!difference.startsWith(`..${sep}`) && difference !== ".." && !isAbsolute(difference))
  );
}

function isAuthorized(candidate: string, roots: AuthorizedRoot[]): boolean {
  return roots.some((root) => isWithin(candidate, root.realPath));
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }

  const { code } = error;
  return typeof code === "string" ? code : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isManagementWorkDirectory(name: string): boolean {
  return MANAGEMENT_WORK_DIRECTORY_PREFIXES.some((prefix) => name.startsWith(prefix));
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameSnapshot(left: Stats, right: Stats): boolean {
  return (
    sameFile(left, right) &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function checkCancelled(state: WalkState, path: string): boolean {
  if (!state.options.signal?.aborted) {
    return false;
  }

  if (!state.cancelled) {
    state.inventory.issues.push(issue(path, "cancel", "Skill scan was cancelled."));
    state.cancelled = true;
  }

  return true;
}

function parseMetadata(content: string): SkillMetadata {
  const normalized = content.startsWith("\uFEFF") ? content.slice(1) : content;
  const frontmatter = normalized.match(/^---[\t ]*\r?\n([\s\S]*?)\r?\n---[\t ]*(?:\r?\n|$)/);
  if (!frontmatter?.[1]) {
    throw new Error("SKILL.md must begin with YAML frontmatter.");
  }

  const document = parseDocument(frontmatter[1], {
    prettyErrors: false,
    strict: true,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    throw new Error(document.errors.map((entry) => entry.message).join("; "));
  }

  const metadata: unknown = document.toJS({ maxAliasCount: 20 });
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
    throw new Error("Skill frontmatter must be a mapping.");
  }

  const record = metadata as Record<string, unknown>;
  if (typeof record.name !== "string" || record.name.trim() === "") {
    throw new Error("Skill frontmatter requires a non-empty name.");
  }
  if (typeof record.description !== "string" || record.description.trim() === "") {
    throw new Error("Skill frontmatter requires a non-empty description.");
  }

  return { name: record.name.trim(), description: record.description.trim() };
}

async function readBoundedFile(
  path: string,
  authorizedRoots: AuthorizedRoot[],
  runtime: ScanRuntime,
): Promise<{ content: string; truncated: boolean; realPath: string }> {
  const resolvedBeforeOpen = await realpath(path);
  if (!isAuthorized(resolvedBeforeOpen, authorizedRoots)) {
    throw new CrossRootLinkError("Skill entry points outside the authorized resource roots.");
  }

  await runtime.beforeOpen?.(path);
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);

  try {
    const openedStats = await handle.stat();
    if (!openedStats.isFile()) {
      throw new Error("Skill entry is not a regular file.");
    }

    const resolvedAfterOpen = await realpath(path);
    if (!isAuthorized(resolvedAfterOpen, authorizedRoots)) {
      throw new CrossRootLinkError(
        "Skill entry moved outside the authorized resource roots before it could be read.",
      );
    }
    const statsAfterOpen = await stat(resolvedAfterOpen);
    if (resolvedBeforeOpen !== resolvedAfterOpen || !sameFile(openedStats, statsAfterOpen)) {
      throw new Error("Skill entry changed before it could be read.");
    }

    await runtime.beforeRead?.(path);
    const buffer = Buffer.allocUnsafe(MAX_SKILL_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.byteLength) {
      const result = await handle.read(buffer, bytesRead, buffer.byteLength - bytesRead, bytesRead);
      if (result.bytesRead === 0) {
        break;
      }
      bytesRead += result.bytesRead;
    }

    const resolvedAfterRead = await realpath(path);
    if (!isAuthorized(resolvedAfterRead, authorizedRoots)) {
      throw new CrossRootLinkError(
        "Skill entry moved outside the authorized resource roots while it was being read.",
      );
    }
    const currentStats = await stat(resolvedAfterRead);
    if (resolvedBeforeOpen !== resolvedAfterRead || !sameSnapshot(openedStats, currentStats)) {
      throw new Error("Skill entry changed while it was being scanned.");
    }

    const truncated = bytesRead > MAX_SKILL_BYTES || openedStats.size > MAX_SKILL_BYTES;
    const contentBytes = buffer.subarray(0, Math.min(bytesRead, MAX_SKILL_BYTES));
    const content = new TextDecoder("utf-8", { fatal: !truncated }).decode(contentBytes);
    return { content, truncated, realPath: resolvedAfterRead };
  } finally {
    await handle.close();
  }
}

function recordId(root: AuthorizedRoot, skillPath: string): string {
  const relativeDirectory = relative(root.absolutePath, dirname(skillPath));
  const portableDirectory = (relativeDirectory || ".").split(sep).join("/");
  return `${root.root.id}:${portableDirectory}`;
}

async function scanSkillEntry(
  state: WalkState,
  root: AuthorizedRoot,
  logicalPath: string,
  ioPath: string,
  viaSymlink: boolean,
  nonstandardEntry: boolean,
): Promise<void> {
  if (checkCancelled(state, logicalPath)) {
    return;
  }

  let resolvedPath: string;
  try {
    resolvedPath = await realpath(ioPath);
  } catch (error) {
    state.inventory.issues.push(
      issue(logicalPath, "unreadable", `Cannot resolve skill entry: ${errorMessage(error)}`),
    );
    return;
  }

  if (!isAuthorized(resolvedPath, state.authorizedRoots)) {
    state.inventory.issues.push(
      issue(
        logicalPath,
        "cross-root-link",
        "Skill link points outside the authorized resource roots.",
      ),
    );
    return;
  }

  try {
    const result = await readBoundedFile(ioPath, state.authorizedRoots, state.runtime);
    if (!isAuthorized(result.realPath, state.authorizedRoots)) {
      state.inventory.issues.push(
        issue(
          logicalPath,
          "cross-root-link",
          "Skill entry moved outside the authorized resource roots while scanning.",
        ),
      );
      return;
    }

    let metadata: SkillMetadata;
    try {
      metadata = parseMetadata(result.content);
    } catch (error) {
      state.inventory.issues.push(
        issue(
          logicalPath,
          "invalid-metadata",
          `Cannot parse skill metadata: ${errorMessage(error)}`,
        ),
      );
      return;
    }

    if (nonstandardEntry) {
      state.inventory.issues.push(
        issue(
          logicalPath,
          "nonstandard-entry",
          "Found lowercase skill.md; rename it to SKILL.md for portable client compatibility.",
          "warning",
        ),
      );
    }

    const isSymlink = viaSymlink || result.realPath !== ioPath;
    const skill: SkillRecord = {
      id: recordId(root, logicalPath),
      name: metadata.name,
      description: metadata.description,
      path: logicalPath,
      rootId: root.root.id,
      client: root.root.client,
      content: result.content,
      contentTruncated: result.truncated,
      isSymlink,
      ...(isSymlink ? { realPath: result.realPath } : {}),
    };
    state.inventory.skills.push(skill);
  } catch (error) {
    if (error instanceof CrossRootLinkError) {
      state.inventory.issues.push(issue(logicalPath, "cross-root-link", error.message));
      return;
    }
    state.inventory.issues.push(
      issue(logicalPath, "unreadable", `Cannot read skill entry: ${errorMessage(error)}`),
    );
  }
}

async function walkDirectory(
  state: WalkState,
  root: AuthorizedRoot,
  logicalDirectory: string,
  ioDirectory: string,
  depth: number,
  viaSymlink: boolean,
  ancestorRealDirectories: ReadonlySet<string>,
): Promise<void> {
  if (checkCancelled(state, logicalDirectory) || state.limitReached) {
    return;
  }
  if (depth > MAX_DIRECTORY_DEPTH) {
    state.inventory.issues.push(
      issue(
        logicalDirectory,
        "limit",
        `Directory depth exceeds the limit of ${MAX_DIRECTORY_DEPTH}.`,
      ),
    );
    return;
  }

  let entries: Dirent[];
  try {
    entries = [];
    const directory = await opendir(ioDirectory);
    for await (const entry of directory) {
      if (checkCancelled(state, logicalDirectory)) {
        return;
      }
      if (isManagementWorkDirectory(entry.name)) {
        continue;
      }
      state.entryCount += 1;
      if (state.entryCount > MAX_DISCOVERED_ENTRIES) {
        state.limitReached = true;
        state.inventory.issues.push(
          issue(
            logicalDirectory,
            "limit",
            `Scan stopped after ${MAX_DISCOVERED_ENTRIES} directory entries.`,
          ),
        );
        return;
      }
      entries.push(entry);
    }
  } catch (error) {
    state.inventory.issues.push(
      issue(logicalDirectory, "unreadable", `Cannot read directory: ${errorMessage(error)}`),
    );
    return;
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));

  const exactSkill = entries.find((entry) => entry.name === "SKILL.md");
  const lowercaseSkill = exactSkill
    ? undefined
    : entries.find((entry) => entry.name === "skill.md");
  const entrySkill = exactSkill ?? lowercaseSkill;
  if (entrySkill) {
    const logicalSkillPath = join(logicalDirectory, entrySkill.name);
    const ioSkillPath = join(ioDirectory, entrySkill.name);
    const entryStats = await lstat(ioSkillPath).catch((error: unknown) => {
      state.inventory.issues.push(
        issue(logicalSkillPath, "unreadable", `Cannot inspect skill entry: ${errorMessage(error)}`),
      );
      return undefined;
    });
    if (entryStats) {
      await scanSkillEntry(
        state,
        root,
        logicalSkillPath,
        ioSkillPath,
        viaSymlink || entryStats.isSymbolicLink(),
        entrySkill === lowercaseSkill,
      );
    }
  }

  for (const entry of entries) {
    if (checkCancelled(state, logicalDirectory) || state.limitReached) {
      return;
    }
    if (entry.name === "SKILL.md" || entry.name === "skill.md") {
      continue;
    }

    const logicalChild = join(logicalDirectory, entry.name);
    const ioChild = join(ioDirectory, entry.name);
    let childStats: Stats;
    try {
      childStats = await lstat(ioChild);
    } catch (error) {
      state.inventory.issues.push(
        issue(logicalChild, "unreadable", `Cannot inspect directory entry: ${errorMessage(error)}`),
      );
      continue;
    }

    if (!childStats.isDirectory() && !childStats.isSymbolicLink()) {
      continue;
    }

    let realChild: string;
    try {
      realChild = await realpath(ioChild);
    } catch (error) {
      state.inventory.issues.push(
        issue(logicalChild, "unreadable", `Cannot resolve directory link: ${errorMessage(error)}`),
      );
      continue;
    }

    if (!isAuthorized(realChild, state.authorizedRoots)) {
      state.inventory.issues.push(
        issue(
          logicalChild,
          "cross-root-link",
          "Directory link points outside the authorized resource roots.",
        ),
      );
      continue;
    }

    let targetStats: Stats;
    try {
      targetStats = await stat(realChild);
    } catch (error) {
      state.inventory.issues.push(
        issue(
          logicalChild,
          "unreadable",
          `Cannot inspect directory target: ${errorMessage(error)}`,
        ),
      );
      continue;
    }
    if (!targetStats.isDirectory()) {
      continue;
    }

    if (ancestorRealDirectories.has(realChild)) {
      state.inventory.issues.push(
        issue(
          logicalChild,
          "symlink-loop",
          "Directory link creates a traversal loop and was skipped.",
          "warning",
        ),
      );
      continue;
    }

    await walkDirectory(
      state,
      root,
      logicalChild,
      realChild,
      depth + 1,
      viaSymlink || childStats.isSymbolicLink(),
      new Set([...ancestorRealDirectories, realChild]),
    );
  }
}

async function authorizeRoots(
  roots: ResourceRoot[],
  inventory: SkillInventory,
  options: ScanSkillsOptions,
): Promise<{ authorized: AuthorizedRoot[]; cancelled: boolean }> {
  const authorized: AuthorizedRoot[] = [];

  for (const root of roots) {
    const absolutePath = resolve(root.path);
    if (options.signal?.aborted) {
      inventory.issues.push(issue(absolutePath, "cancel", "Skill scan was cancelled."));
      return { authorized, cancelled: true };
    }

    try {
      const pathStats = await lstat(absolutePath);
      const canonicalPath = await realpath(absolutePath);
      const rootStats = await stat(canonicalPath);
      if (!rootStats.isDirectory()) {
        inventory.issues.push(
          issue(absolutePath, "unreadable", "Resource root is not a directory."),
        );
        continue;
      }

      authorized.push({
        root,
        absolutePath,
        realPath: canonicalPath,
        isSymlink: pathStats.isSymbolicLink(),
      });
    } catch (error) {
      const code = errorCode(error);
      if (code === "ENOENT") {
        inventory.issues.push(issue(absolutePath, "missing", "Resource root does not exist."));
      } else {
        inventory.issues.push(
          issue(absolutePath, "unreadable", `Cannot access resource root: ${errorMessage(error)}`),
        );
      }
    }
  }

  return { authorized, cancelled: false };
}

async function scanSkillsInternal(
  roots: ResourceRoot[],
  options: ScanSkillsOptions,
  runtime: ScanRuntime,
): Promise<SkillInventory> {
  const inventory: SkillInventory = { skills: [], issues: [], scannedAt: new Date().toISOString() };
  const authorization = await authorizeRoots(roots, inventory, options);
  if (authorization.cancelled) {
    return inventory;
  }

  const state: WalkState = {
    authorizedRoots: authorization.authorized,
    inventory,
    options,
    runtime,
    entryCount: 0,
    limitReached: false,
    cancelled: false,
  };

  for (const root of authorization.authorized) {
    if (checkCancelled(state, root.absolutePath) || state.limitReached) {
      break;
    }
    await walkDirectory(
      state,
      root,
      root.absolutePath,
      root.realPath,
      0,
      root.isSymlink,
      new Set([root.realPath]),
    );
  }

  return inventory;
}

export async function scanSkills(
  roots: ResourceRoot[],
  options: ScanSkillsOptions = {},
): Promise<SkillInventory> {
  return scanSkillsInternal(roots, options, {});
}

/** @internal Deterministic filesystem race coverage; not exported by the package entrypoint. */
export async function scanSkillsWithRuntimeForTest(
  roots: ResourceRoot[],
  options: ScanSkillsOptions,
  runtime: ScanRuntime,
): Promise<SkillInventory> {
  return scanSkillsInternal(roots, options, runtime);
}
