import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseDocument } from "yaml";

import type {
  BackupEntryInput,
  BackupEntrySummary,
  BackupSummary,
  CompatibilityWarning,
  CreateBackupOptions,
  DirectoryManifest,
  DirectoryManifestEntry,
  DirectoryRevision,
  ExecuteOptions,
  ManagementErrorCode,
  ManagementLimits,
  ManagementPlan,
  ManagementStore,
  ManagementStoreOptions,
  OperationItemRecord,
  OperationRecord,
  PlanConflict,
  PlanRestoreOptions,
  PortableBackupManifest,
  PortableBackupResult,
  RecoveryMaterialState,
  RestorePlan,
  RestorePlanItem,
  SyncAction,
  SyncPlan,
  SyncPlanInput,
  TransferBackupOptions,
} from "./management-types.ts";

const DEFAULT_LIMITS: ManagementLimits = {
  maxFileBytes: 8 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  maxEntries: 10_000,
  planTtlMs: 15 * 60 * 1000,
};

const CLAUDE_SPECIFIC_FIELDS = new Set([
  "allowed-tools",
  "argument-hint",
  "context",
  "agent",
  "hooks",
  "model",
  "disable-model-invocation",
  "user-invocable",
]);

interface AuthorizedRoot {
  logicalPath: string;
  expectedRealPath: string;
  anchorLogicalPath: string;
  anchorRealPath: string;
}

interface FileSnapshot {
  bytes: Buffer;
  entry: DirectoryManifestEntry;
}

interface ScannedDirectory {
  logicalPath: string;
  realPath: string;
  manifest: DirectoryManifest;
  revision: DirectoryRevision & { kind: "directory" };
  hasSkillEntry: boolean;
  skillContent?: string;
  files: Map<string, FileSnapshot>;
}

interface InspectedPath {
  revision: DirectoryRevision;
  directory?: ScannedDirectory;
}

interface StoredBackupEntry extends BackupEntrySummary {
  storage: string;
  manifest: DirectoryManifest;
  storedManifest: DirectoryManifest;
}

interface StoredBackup {
  version: 1;
  id: string;
  createdAt: string;
  reason: BackupSummary["reason"];
  entries: StoredBackupEntry[];
}

interface PlannedState {
  plan: ManagementPlan;
  consumed: boolean;
}

interface ManagementRuntime {
  beforeDisplaceRename?: (target: string, recoveryPath: string) => Promise<void> | void;
}

interface RecoveryUpdate {
  backupSnapshotId?: string;
  recoveryPath: string;
  recoveryDestinationPath?: string;
  recoveryState: RecoveryMaterialState;
}

interface InstallResult {
  backupSnapshotId?: string;
  recoveryPath?: string;
  recoveryState?: RecoveryMaterialState;
}

export class ManagementError extends Error {
  readonly code: ManagementErrorCode;

  constructor(code: ManagementErrorCode, message: string) {
    super(message);
    this.name = "ManagementError";
    this.code = code;
  }
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function abortError(): ManagementError {
  return new ManagementError("aborted", "The file operation was cancelled.");
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function isWithin(candidate: string, root: string): boolean {
  const difference = relative(root, candidate);
  return (
    difference === "" ||
    (difference !== ".." && !difference.startsWith(`..${sep}`) && !isAbsolute(difference))
  );
}

function requireAbsolutePath(path: string, label: string): string {
  if (!isAbsolute(path)) {
    throw new ManagementError("invalid-input", `${label} must be an absolute path.`);
  }
  return resolve(path);
}

async function lstatOptional(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") return undefined;
    throw error;
  }
}

async function nearestExisting(path: string): Promise<{ logicalPath: string; realPath: string }> {
  let current = path;
  while (true) {
    const currentStats = await lstatOptional(current);
    if (currentStats) return { logicalPath: current, realPath: await realpath(current) };
    const parent = dirname(current);
    if (parent === current) {
      throw new ManagementError("missing", `No existing ancestor was found for ${path}.`);
    }
    current = parent;
  }
}

async function resolveAuthorizedRoots(options: ManagementStoreOptions): Promise<AuthorizedRoot[]> {
  const requested = options.authorizedRoots();
  if (requested.some((entry) => !isAbsolute(entry))) {
    throw new ManagementError("invalid-input", "Authorized roots must be absolute paths.");
  }
  const configured = [...new Set(requested.map((entry) => resolve(entry)))];
  if (configured.length === 0) {
    throw new ManagementError(
      "outside-authorized-roots",
      "No file roots are currently authorized.",
    );
  }

  const roots: AuthorizedRoot[] = [];
  for (const configuredPath of configured) {
    const anchor = await nearestExisting(configuredPath);
    const expectedRealPath = resolve(anchor.realPath, relative(anchor.logicalPath, configuredPath));
    roots.push({
      logicalPath: configuredPath,
      expectedRealPath,
      anchorLogicalPath: anchor.logicalPath,
      anchorRealPath: anchor.realPath,
    });
  }
  return roots.sort((left, right) => right.logicalPath.length - left.logicalPath.length);
}

function matchingLogicalRoot(path: string, roots: AuthorizedRoot[]): AuthorizedRoot | undefined {
  return roots.find((root) => isWithin(path, root.logicalPath));
}

function assertRealAuthorized(path: string, roots: AuthorizedRoot[]): void {
  if (!roots.some((root) => isWithin(path, root.expectedRealPath))) {
    throw new ManagementError(
      "outside-authorized-roots",
      `Resolved path is outside the currently authorized roots: ${path}`,
    );
  }
}

async function assertTargetAuthorized(
  path: string,
  roots: AuthorizedRoot[],
): Promise<AuthorizedRoot> {
  const root = matchingLogicalRoot(path, roots);
  if (!root) {
    throw new ManagementError(
      "outside-authorized-roots",
      `Target path is outside the currently authorized roots: ${path}`,
    );
  }

  const anchor = await nearestExisting(path);
  if (isWithin(anchor.logicalPath, root.logicalPath)) {
    assertRealAuthorized(anchor.realPath, [root]);
  } else if (
    anchor.logicalPath !== root.anchorLogicalPath ||
    anchor.realPath !== root.anchorRealPath
  ) {
    throw new ManagementError(
      "outside-authorized-roots",
      `The authorized target root changed before it could be used: ${root.logicalPath}`,
    );
  }
  return root;
}

function modeBits(mode: number): number {
  return mode & 0o777;
}

function sameStat(
  left: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number },
  right: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number },
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

async function readStableFile(
  path: string,
  roots: AuthorizedRoot[],
  limits: ManagementLimits,
  signal?: AbortSignal,
): Promise<{ bytes: Buffer; realPath: string; mode: number }> {
  checkAbort(signal);
  const beforeRealPath = await realpath(path);
  assertRealAuthorized(beforeRealPath, roots);
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile()) {
      throw new ManagementError("unsupported-entry", `Expected a regular file: ${path}`);
    }
    if (before.size > limits.maxFileBytes) {
      throw new ManagementError(
        "limit",
        `File exceeds the ${limits.maxFileBytes}-byte limit: ${path}`,
      );
    }

    const buffer = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      checkAbort(signal);
      const result = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    if (offset > before.size) {
      throw new ManagementError("conflict", `File changed while it was being read: ${path}`);
    }

    const afterRealPath = await realpath(path);
    assertRealAuthorized(afterRealPath, roots);
    const after = await stat(afterRealPath);
    if (beforeRealPath !== afterRealPath || !sameStat(before, after)) {
      throw new ManagementError("conflict", `File changed while it was being read: ${path}`);
    }
    return {
      bytes: buffer.subarray(0, offset),
      realPath: afterRealPath,
      mode: modeBits(before.mode),
    };
  } finally {
    await handle.close();
  }
}

function portablePath(path: string): string {
  return path.split(sep).join("/");
}

async function scanDirectory(
  path: string,
  roots: AuthorizedRoot[],
  limits: ManagementLimits,
  options: { requireSkill: boolean; includeContent: boolean; signal?: AbortSignal },
): Promise<ScannedDirectory> {
  checkAbort(options.signal);
  const rootStats = await lstatOptional(path);
  if (!rootStats) throw new ManagementError("missing", `Directory does not exist: ${path}`);
  const rootRealPath = await realpath(path);
  assertRealAuthorized(rootRealPath, roots);
  const resolvedRootStats = await stat(rootRealPath);
  if (!resolvedRootStats.isDirectory()) {
    throw new ManagementError("unsupported-entry", `Expected a directory: ${path}`);
  }

  const entries: DirectoryManifestEntry[] = [];
  const files = new Map<string, FileSnapshot>();
  let totalBytes = 0;
  let fileCount = 0;
  let directoryCount = 0;
  let hasSkillEntry = false;
  let skillContent: string | undefined;

  async function walk(
    ioPath: string,
    relativePath: string,
    ancestors: ReadonlySet<string>,
  ): Promise<void> {
    checkAbort(options.signal);
    if (entries.length >= limits.maxEntries) {
      throw new ManagementError("limit", `Directory exceeds the ${limits.maxEntries}-entry limit.`);
    }

    const logicalStats = await lstat(ioPath);
    const isLink = logicalStats.isSymbolicLink();
    const linkTarget = isLink ? await readlink(ioPath) : undefined;
    const resolvedPath = await realpath(ioPath);
    assertRealAuthorized(resolvedPath, roots);
    const resolvedStats = await stat(resolvedPath);
    const portable = portablePath(relativePath);

    if (resolvedStats.isDirectory()) {
      if (ancestors.has(resolvedPath)) {
        throw new ManagementError("unsafe-link", `Directory link creates a cycle: ${ioPath}`);
      }
      const before = resolvedStats;
      if (relativePath !== "") {
        entries.push({
          path: portable,
          kind: "directory",
          sourceKind: isLink ? "symlink" : "directory",
          mode: modeBits(resolvedStats.mode),
          ...(isLink
            ? { link: { target: linkTarget ?? "", resolvedKind: "directory" as const } }
            : {}),
        });
        directoryCount += 1;
      }
      const nextAncestors = new Set(ancestors);
      nextAncestors.add(resolvedPath);
      const children = await readdir(ioPath);
      children.sort((left, right) => left.localeCompare(right));
      for (const child of children) {
        await walk(
          join(ioPath, child),
          relativePath ? join(relativePath, child) : child,
          nextAncestors,
        );
      }
      const after = await stat(resolvedPath);
      if (!sameStat(before, after)) {
        throw new ManagementError("conflict", `Directory changed while it was scanned: ${ioPath}`);
      }
      return;
    }

    if (!resolvedStats.isFile()) {
      throw new ManagementError("unsupported-entry", `Unsupported directory entry: ${ioPath}`);
    }
    const read = await readStableFile(ioPath, roots, limits, options.signal);
    totalBytes += read.bytes.byteLength;
    if (totalBytes > limits.maxTotalBytes) {
      throw new ManagementError(
        "limit",
        `Directory exceeds the ${limits.maxTotalBytes}-byte total limit.`,
      );
    }
    const entry: DirectoryManifestEntry = {
      path: portable,
      kind: "file",
      sourceKind: isLink ? "symlink" : "file",
      mode: read.mode,
      bytes: read.bytes.byteLength,
      hash: createHash("sha256").update(read.bytes).digest("hex"),
      ...(isLink ? { link: { target: linkTarget ?? "", resolvedKind: "file" as const } } : {}),
    };
    entries.push(entry);
    fileCount += 1;
    if (portable === "SKILL.md") {
      hasSkillEntry = true;
      skillContent = read.bytes.toString("utf8");
    }
    if (options.includeContent) files.set(portable, { bytes: read.bytes, entry });
  }

  await walk(path, "", new Set());
  if (options.requireSkill && !hasSkillEntry) {
    throw new ManagementError(
      "invalid-input",
      `Skill directory does not contain SKILL.md: ${path}`,
    );
  }
  entries.sort((left, right) => left.path.localeCompare(right.path));
  const manifestHash = createHash("sha256").update(JSON.stringify(entries)).digest("hex");
  const manifest: DirectoryManifest = {
    algorithm: "sha256",
    hash: manifestHash,
    files: fileCount,
    directories: directoryCount,
    bytes: totalBytes,
    entries,
  };
  const revision: ScannedDirectory["revision"] = {
    kind: "directory",
    realPath: rootRealPath,
    manifestHash,
    files: fileCount,
    bytes: totalBytes,
  };
  return {
    logicalPath: path,
    realPath: rootRealPath,
    manifest,
    revision,
    hasSkillEntry,
    skillContent,
    files,
  };
}

async function inspectPath(
  path: string,
  roots: AuthorizedRoot[],
  limits: ManagementLimits,
  options: { includeContent?: boolean; signal?: AbortSignal } = {},
): Promise<InspectedPath> {
  checkAbort(options.signal);
  await assertTargetAuthorized(path, roots);
  const pathStats = await lstatOptional(path);
  if (!pathStats) {
    const ancestor = await nearestExisting(path);
    return {
      revision: {
        kind: "absent",
        nearestAncestorPath: ancestor.logicalPath,
        nearestAncestorRealPath: ancestor.realPath,
      },
    };
  }
  const resolvedPath = await realpath(path);
  assertRealAuthorized(resolvedPath, roots);
  if (pathStats.isSymbolicLink()) return { revision: { kind: "symlink", realPath: resolvedPath } };
  if (!pathStats.isDirectory()) return { revision: { kind: "other", realPath: resolvedPath } };
  const directory = await scanDirectory(path, roots, limits, {
    requireSkill: false,
    includeContent: options.includeContent ?? false,
    signal: options.signal,
  });
  return { revision: directory.revision, directory };
}

function revisionsEqual(left: DirectoryRevision, right: DirectoryRevision): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function materializeManifest(manifest: DirectoryManifest): DirectoryManifest {
  const entries: DirectoryManifestEntry[] = manifest.entries.map(({ link: _link, ...entry }) => ({
    ...entry,
    sourceKind: entry.kind,
  }));
  return {
    ...manifest,
    hash: createHash("sha256").update(JSON.stringify(entries)).digest("hex"),
    entries,
  };
}

async function revisionStillMatches(
  current: DirectoryRevision,
  expected: DirectoryRevision,
): Promise<boolean> {
  if (revisionsEqual(current, expected)) return true;
  if (current.kind !== "absent" || expected.kind !== "absent") return false;
  if (!isWithin(current.nearestAncestorPath, expected.nearestAncestorPath)) return false;
  try {
    if ((await realpath(expected.nearestAncestorPath)) !== expected.nearestAncestorRealPath) {
      return false;
    }
  } catch {
    return false;
  }
  const expectedCurrentReal = resolve(
    expected.nearestAncestorRealPath,
    relative(expected.nearestAncestorPath, current.nearestAncestorPath),
  );
  return current.nearestAncestorRealPath === expectedCurrentReal;
}

function conflictForTarget(
  source: ScannedDirectory,
  target: InspectedPath,
  allowReplace: boolean,
): { action: SyncAction; conflict?: PlanConflict } {
  if (target.revision.kind === "absent") return { action: "copy" };
  if (target.revision.kind === "symlink") {
    if (target.revision.realPath === source.realPath) return { action: "skip" };
    return {
      action: "conflict",
      conflict: {
        code: "target-symlink",
        message: "The target is a symbolic link and cannot be taken over automatically.",
      },
    };
  }
  if (target.revision.kind !== "directory" || !target.directory) {
    return {
      action: "conflict",
      conflict: { code: "target-unsupported", message: "The target is not a directory." },
    };
  }
  if (target.directory.manifest.hash === source.manifest.hash) return { action: "skip" };
  if (!target.directory.hasSkillEntry) {
    return {
      action: "conflict",
      conflict: {
        code: "target-not-skill",
        message: "The existing target has no SKILL.md and will not be replaced as a Skill.",
      },
    };
  }
  if (allowReplace) return { action: "replace" };
  return {
    action: "conflict",
    conflict: {
      code: "different-content",
      message: "The target contains different content. Create a new plan with allowReplace=true.",
    },
  };
}

function compatibilityWarnings(
  input: SyncPlanInput,
  skillContent?: string,
): CompatibilityWarning[] {
  if (input.sourceClient !== "claude-code" || input.targetClient !== "codex" || !skillContent) {
    return [];
  }
  const match = skillContent.match(/^---[\t ]*\r?\n([\s\S]*?)\r?\n---[\t ]*(?:\r?\n|$)/);
  if (!match?.[1]) return [];
  const document = parseDocument(match[1], { prettyErrors: false, strict: true, uniqueKeys: true });
  if (document.errors.length > 0) return [];
  const value: unknown = document.toJS({ maxAliasCount: 20 });
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.keys(value)
    .filter((field) => CLAUDE_SPECIFIC_FIELDS.has(field))
    .sort()
    .map((field) => ({
      code: "client-specific-field" as const,
      field,
      message: `Claude-specific frontmatter field '${field}' may need adaptation in Codex.`,
    }));
}

async function ensureAuthorizedParent(target: string, roots: AuthorizedRoot[]): Promise<void> {
  const parent = dirname(target);
  const root = await assertTargetAuthorized(target, roots);
  const relativeParent = relative(root.anchorLogicalPath, parent);
  if (relativeParent.startsWith(`..${sep}`) || relativeParent === "..") {
    throw new ManagementError("outside-authorized-roots", `Cannot create target parent: ${parent}`);
  }
  if (relativeParent === "") {
    if (!isWithin(parent, root.logicalPath)) {
      throw new ManagementError(
        "outside-authorized-roots",
        `Cannot create target parent: ${parent}`,
      );
    }
    return;
  }
  let current = root.anchorLogicalPath;
  for (const component of relativeParent.split(sep).filter(Boolean)) {
    current = join(current, component);
    let currentStats = await lstatOptional(current);
    if (!currentStats) {
      await mkdir(current);
      currentStats = await lstat(current);
    }
    if (currentStats.isSymbolicLink()) {
      if (current !== root.logicalPath) {
        throw new ManagementError(
          "unsafe-link",
          `Target parent contains a symbolic link: ${current}`,
        );
      }
    } else if (!currentStats.isDirectory()) {
      throw new ManagementError(
        "unsupported-entry",
        `Target parent is not a directory: ${current}`,
      );
    }
    if (isWithin(current, root.logicalPath)) {
      assertRealAuthorized(await realpath(current), [root]);
    }
  }
  await assertTargetAuthorized(target, roots);
}

async function writeScannedDirectory(
  destination: string,
  scanned: ScannedDirectory,
  signal?: AbortSignal,
): Promise<void> {
  checkAbort(signal);
  await mkdir(destination, { recursive: false });
  const directories = scanned.manifest.entries.filter((entry) => entry.kind === "directory");
  directories.sort((left, right) => left.path.split("/").length - right.path.split("/").length);
  for (const entry of directories) {
    checkAbort(signal);
    const path = join(destination, ...entry.path.split("/"));
    await mkdir(path);
    await chmod(path, entry.mode);
  }
  for (const entry of scanned.manifest.entries) {
    if (entry.kind !== "file") continue;
    checkAbort(signal);
    const snapshot = scanned.files.get(entry.path);
    if (!snapshot) throw new ManagementError("conflict", `Missing staged content: ${entry.path}`);
    const path = join(destination, ...entry.path.split("/"));
    await writeFile(path, snapshot.bytes, { flag: "wx", mode: entry.mode });
    await chmod(path, entry.mode);
  }
}

function backupSummary(metadata: StoredBackup): BackupSummary {
  return {
    id: metadata.id,
    createdAt: metadata.createdAt,
    reason: metadata.reason,
    entries: metadata.entries.map(
      ({ storage: _storage, manifest: _manifest, storedManifest: _storedManifest, ...entry }) =>
        entry,
    ),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertStoredBackup(value: unknown, source: string): asserts value is StoredBackup {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.id !== "string" ||
    typeof value.createdAt !== "string" ||
    !["manual", "write-before", "restore-before", "import"].includes(String(value.reason)) ||
    !Array.isArray(value.entries)
  ) {
    throw new ManagementError("corrupt-data", `Invalid backup metadata: ${source}`);
  }
  for (const entry of value.entries) {
    if (
      !isRecord(entry) ||
      typeof entry.id !== "string" ||
      typeof entry.name !== "string" ||
      typeof entry.directoryName !== "string" ||
      !isSafeDirectoryName(entry.directoryName) ||
      (entry.originalPath !== undefined && typeof entry.originalPath !== "string") ||
      typeof entry.storage !== "string" ||
      typeof entry.files !== "number" ||
      typeof entry.bytes !== "number" ||
      !isRecord(entry.revision) ||
      !isRecord(entry.manifest) ||
      !isRecord(entry.storedManifest)
    ) {
      throw new ManagementError("corrupt-data", `Invalid backup entry metadata: ${source}`);
    }
  }
}

function isSafeDirectoryName(value: string): boolean {
  return (
    value !== "" &&
    value !== "." &&
    value !== ".." &&
    !value.includes("/") &&
    !value.includes("\\") &&
    value.includes("\0") === false
  );
}

function assertPortableManifest(
  value: unknown,
  source: string,
  limits: ManagementLimits,
): asserts value is PortableBackupManifest {
  if (
    !isRecord(value) ||
    value.schema !== "koyori.skill-backup" ||
    value.version !== 1 ||
    typeof value.id !== "string" ||
    typeof value.createdAt !== "string" ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    !Array.isArray(value.entries) ||
    value.entries.length === 0 ||
    value.entries.length > limits.maxEntries
  ) {
    throw new ManagementError("corrupt-data", `Invalid portable backup manifest: ${source}`);
  }
  const ids = new Set<string>();
  for (const rawEntry of value.entries) {
    if (
      !isRecord(rawEntry) ||
      typeof rawEntry.id !== "string" ||
      !/^[A-Za-z0-9._-]{1,100}$/.test(rawEntry.id) ||
      ids.has(rawEntry.id) ||
      typeof rawEntry.name !== "string" ||
      rawEntry.name.trim() === "" ||
      typeof rawEntry.directoryName !== "string" ||
      !isSafeDirectoryName(rawEntry.directoryName) ||
      (rawEntry.client !== undefined &&
        rawEntry.client !== "claude-code" &&
        rawEntry.client !== "codex") ||
      typeof rawEntry.files !== "number" ||
      typeof rawEntry.bytes !== "number" ||
      !isRecord(rawEntry.manifest) ||
      rawEntry.manifest.algorithm !== "sha256" ||
      typeof rawEntry.manifest.hash !== "string" ||
      !/^[0-9a-f]{64}$/.test(rawEntry.manifest.hash) ||
      typeof rawEntry.manifest.files !== "number" ||
      typeof rawEntry.manifest.directories !== "number" ||
      typeof rawEntry.manifest.bytes !== "number" ||
      !Array.isArray(rawEntry.manifest.entries)
    ) {
      throw new ManagementError("corrupt-data", `Invalid portable backup entry: ${source}`);
    }
    ids.add(rawEntry.id);
    if (
      rawEntry.files !== rawEntry.manifest.files ||
      rawEntry.bytes !== rawEntry.manifest.bytes ||
      rawEntry.bytes > limits.maxTotalBytes ||
      rawEntry.manifest.entries.length > limits.maxEntries
    ) {
      throw new ManagementError("corrupt-data", `Inconsistent portable backup totals: ${source}`);
    }
    const paths = new Set<string>();
    for (const rawManifestEntry of rawEntry.manifest.entries) {
      if (
        !isRecord(rawManifestEntry) ||
        typeof rawManifestEntry.path !== "string" ||
        rawManifestEntry.path === "" ||
        rawManifestEntry.path.startsWith("/") ||
        rawManifestEntry.path
          .split("/")
          .some((component) => component === ".." || component === "") ||
        paths.has(rawManifestEntry.path) ||
        (rawManifestEntry.kind !== "file" && rawManifestEntry.kind !== "directory") ||
        rawManifestEntry.sourceKind !== rawManifestEntry.kind ||
        typeof rawManifestEntry.mode !== "number" ||
        rawManifestEntry.mode < 0 ||
        rawManifestEntry.mode > 0o777 ||
        "link" in rawManifestEntry
      ) {
        throw new ManagementError(
          "corrupt-data",
          `Unsafe portable backup path or entry: ${source}`,
        );
      }
      paths.add(rawManifestEntry.path);
      if (
        rawManifestEntry.kind === "file" &&
        (typeof rawManifestEntry.bytes !== "number" ||
          rawManifestEntry.bytes > limits.maxFileBytes ||
          typeof rawManifestEntry.hash !== "string" ||
          !/^[0-9a-f]{64}$/.test(rawManifestEntry.hash))
      ) {
        throw new ManagementError("corrupt-data", `Invalid portable file digest: ${source}`);
      }
    }
    const calculatedHash = createHash("sha256")
      .update(JSON.stringify(rawEntry.manifest.entries))
      .digest("hex");
    if (calculatedHash !== rawEntry.manifest.hash) {
      throw new ManagementError("corrupt-data", `Portable manifest digest mismatch: ${source}`);
    }
  }
}

function assertOperation(value: unknown, source: string): asserts value is OperationRecord {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.planId !== "string" ||
    !["sync", "restore"].includes(String(value.kind)) ||
    !["running", "succeeded", "partial", "failed", "cancelled", "interrupted"].includes(
      String(value.status),
    ) ||
    typeof value.startedAt !== "string" ||
    !Array.isArray(value.items)
  ) {
    throw new ManagementError("corrupt-data", `Invalid operation journal: ${source}`);
  }
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (errorCode(error) === "ENOENT") throw error;
    throw new ManagementError(
      "corrupt-data",
      `Cannot read persistent data ${path}: ${message(error)}`,
    );
  }
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function createManagementStoreInternal(
  dataDir: string,
  options: ManagementStoreOptions,
  runtime: ManagementRuntime,
): Promise<ManagementStore> {
  const absoluteDataDir = requireAbsolutePath(dataDir, "dataDir");
  const limits: ManagementLimits = { ...DEFAULT_LIMITS, ...options.limits };
  if (
    limits.maxFileBytes <= 0 ||
    limits.maxTotalBytes <= 0 ||
    limits.maxEntries <= 0 ||
    limits.planTtlMs <= 0
  ) {
    throw new ManagementError("invalid-input", "Management limits must be positive numbers.");
  }
  const stateDirectory = join(absoluteDataDir, "managed-files");
  const backupsDirectory = join(stateDirectory, "backups");
  const operationsDirectory = join(stateDirectory, "operations");
  const recoveriesDirectory = join(stateDirectory, "recoveries");
  const lockPath = join(stateDirectory, "mutation.lock");
  await mkdir(backupsDirectory, { recursive: true });
  await mkdir(operationsDirectory, { recursive: true });
  await mkdir(recoveriesDirectory, { recursive: true });
  const plans = new Map<string, PlannedState>();
  let localMutation = false;

  function processIsAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return errorCode(error) !== "ESRCH";
    }
  }

  async function acquireMutationLock() {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const handle = await open(lockPath, "wx", 0o600);
        const token = randomUUID();
        await handle.writeFile(
          `${JSON.stringify({ version: 1, pid: process.pid, token, createdAt: new Date().toISOString() })}\n`,
        );
        return handle;
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
      }

      let lockValue: unknown;
      let before: Awaited<ReturnType<typeof lstat>>;
      try {
        before = await lstat(lockPath);
        lockValue = JSON.parse(await readFile(lockPath, "utf8"));
      } catch (error) {
        if (errorCode(error) === "ENOENT") continue;
        throw new ManagementError(
          "busy",
          `Managed file lock exists but cannot be verified safely: ${message(error)}`,
        );
      }
      if (
        !isRecord(lockValue) ||
        lockValue.version !== 1 ||
        typeof lockValue.pid !== "number" ||
        !Number.isInteger(lockValue.pid) ||
        lockValue.pid <= 0 ||
        typeof lockValue.token !== "string"
      ) {
        throw new ManagementError("busy", "Managed file lock has an unknown owner format.");
      }
      if (processIsAlive(lockValue.pid)) {
        throw new ManagementError("busy", "Another process holds the managed file lock.");
      }

      const quarantined = join(stateDirectory, `.stale-lock-${lockValue.token}-${randomUUID()}`);
      try {
        await rename(lockPath, quarantined);
      } catch (error) {
        if (errorCode(error) === "ENOENT") continue;
        throw error;
      }
      const moved = await lstat(quarantined);
      if (moved.dev !== before.dev || moved.ino !== before.ino) {
        if (!(await lstatOptional(lockPath))) await rename(quarantined, lockPath);
        throw new ManagementError("busy", "Managed file lock ownership changed during recovery.");
      }
      await rm(quarantined, { force: true });
    }
    throw new ManagementError("busy", "Could not acquire the managed file lock safely.");
  }

  async function withMutation<T>(work: () => Promise<T>): Promise<T> {
    if (localMutation)
      throw new ManagementError("busy", "Another managed file operation is running.");
    localMutation = true;
    let lock: Awaited<ReturnType<typeof open>> | undefined;
    try {
      lock = await acquireMutationLock();
      return await work();
    } finally {
      await lock?.close();
      if (lock) await rm(lockPath, { force: true });
      localMutation = false;
    }
  }

  async function readBackup(snapshotId: string): Promise<StoredBackup> {
    if (!/^[0-9a-f-]{36}$/i.test(snapshotId)) {
      throw new ManagementError("invalid-input", "Invalid backup snapshot id.");
    }
    const metadataPath = join(backupsDirectory, snapshotId, "metadata.json");
    let value: unknown;
    try {
      value = await readJson(metadataPath);
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        throw new ManagementError("missing", `Backup snapshot does not exist: ${snapshotId}`);
      }
      throw error;
    }
    assertStoredBackup(value, metadataPath);
    if (value.id !== snapshotId) {
      throw new ManagementError(
        "corrupt-data",
        `Backup id does not match its directory: ${snapshotId}`,
      );
    }
    return value;
  }

  async function persistOperation(operation: OperationRecord): Promise<void> {
    await atomicWriteJson(join(operationsDirectory, `${operation.id}.json`), operation);
  }

  async function createBackupInternal(
    entries: readonly BackupEntryInput[],
    backupOptions: CreateBackupOptions = {},
  ): Promise<BackupSummary> {
    if (entries.length === 0) {
      throw new ManagementError("invalid-input", "A backup requires at least one entry.");
    }
    const roots = await resolveAuthorizedRoots(options);
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const finalDirectory = join(backupsDirectory, id);
    const temporaryDirectory = await mkdtemp(join(backupsDirectory, `.creating-${id}-`));
    const storedEntries: StoredBackupEntry[] = [];
    const ids = new Set<string>();
    try {
      for (const input of entries) {
        checkAbort(backupOptions.signal);
        const path = requireAbsolutePath(input.path, "Backup entry path");
        const entryId =
          input.id && /^[A-Za-z0-9._-]{1,100}$/.test(input.id) ? input.id : randomUUID();
        if (ids.has(entryId) || input.name.trim() === "" || !isSafeDirectoryName(basename(path))) {
          throw new ManagementError(
            "invalid-input",
            `Invalid or duplicate backup entry id: ${entryId}`,
          );
        }
        ids.add(entryId);
        const scanned = await scanDirectory(path, roots, limits, {
          requireSkill: true,
          includeContent: true,
          signal: backupOptions.signal,
        });
        const storage = join("entries", entryId);
        await mkdir(dirname(join(temporaryDirectory, storage)), { recursive: true });
        await writeScannedDirectory(
          join(temporaryDirectory, storage),
          scanned,
          backupOptions.signal,
        );
        const storedManifest = materializeManifest(scanned.manifest);
        storedEntries.push({
          id: entryId,
          name: input.name,
          directoryName: basename(path),
          ...(input.client ? { client: input.client } : {}),
          originalPath: path,
          revision: scanned.revision,
          files: scanned.manifest.files,
          bytes: scanned.manifest.bytes,
          storage,
          manifest: scanned.manifest,
          storedManifest,
        });
      }
      const metadata: StoredBackup = {
        version: 1,
        id,
        createdAt,
        reason: backupOptions.reason ?? "manual",
        entries: storedEntries,
      };
      await atomicWriteJson(join(temporaryDirectory, "metadata.json"), metadata);
      await rename(temporaryDirectory, finalDirectory);
      return backupSummary(metadata);
    } catch (error) {
      await rm(temporaryDirectory, { recursive: true, force: true });
      throw error;
    }
  }

  async function revalidateTarget(
    target: string,
    expected: DirectoryRevision,
    roots: AuthorizedRoot[],
    signal?: AbortSignal,
  ): Promise<InspectedPath> {
    const current = await inspectPath(target, roots, limits, { signal });
    if (!(await revisionStillMatches(current.revision, expected))) {
      throw new ManagementError("conflict", `Target changed after the plan was created: ${target}`);
    }
    return current;
  }

  async function installDirectory(
    source: ScannedDirectory,
    target: string,
    action: SyncAction,
    expectedTarget: DirectoryRevision,
    roots: AuthorizedRoot[],
    onRecoveryUpdate: (update: RecoveryUpdate) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<InstallResult> {
    if (action === "skip") return {};
    if (action !== "copy" && action !== "replace") {
      throw new ManagementError("conflict", `Plan cannot execute target action '${action}'.`);
    }
    await ensureAuthorizedParent(target, roots);
    await revalidateTarget(target, expectedTarget, roots, signal);
    const parent = dirname(target);
    const stage = await mkdtemp(join(parent, `.koyori-stage-${basename(target)}-`));
    await rm(stage, { recursive: true });
    let backupId: string | undefined;
    try {
      await writeScannedDirectory(stage, source, signal);
      checkAbort(signal);
      if (action === "replace") {
        const backup = await createBackupInternal([{ name: basename(target), path: target }], {
          reason: "write-before",
          signal,
        });
        backupId = backup.id;
        if (
          !revisionsEqual(
            backup.entries[0]?.revision ?? { kind: "other", realPath: "" },
            expectedTarget,
          )
        ) {
          throw new ManagementError(
            "conflict",
            `Target changed while its recovery snapshot was made: ${target}`,
          );
        }
        await revalidateTarget(target, expectedTarget, roots, signal);
        const recoveryId = randomUUID();
        const siblingRecovery = join(parent, `.koyori-recovery-${basename(target)}-${recoveryId}`);
        const managedRecovery = join(recoveriesDirectory, recoveryId);
        let recoveryPath = siblingRecovery;
        await onRecoveryUpdate({
          backupSnapshotId: backupId,
          recoveryPath,
          recoveryState: "reserved",
        });
        await runtime.beforeDisplaceRename?.(target, siblingRecovery);
        await rename(target, siblingRecovery);
        await onRecoveryUpdate({
          backupSnapshotId: backupId,
          recoveryPath,
          recoveryState: "preserved",
        });

        const rollback = async (cause: unknown): Promise<never> => {
          try {
            if (await lstatOptional(target)) {
              throw new ManagementError(
                "conflict",
                `Target reappeared; recovery material remains at ${recoveryPath}.`,
              );
            }
            await rename(recoveryPath, target);
            await onRecoveryUpdate({
              backupSnapshotId: backupId,
              recoveryPath: target,
              recoveryState: "restored",
            });
          } catch (rollbackError) {
            await onRecoveryUpdate({
              backupSnapshotId: backupId,
              recoveryPath,
              recoveryState: "preserved",
            }).catch(() => undefined);
            throw new ManagementError(
              "conflict",
              `${message(cause)} Recovery remains at ${recoveryPath}; automatic rollback failed: ${message(rollbackError)}`,
            );
          }
          throw new ManagementError(
            "conflict",
            `${message(cause)} The displaced directory was restored to ${target}.`,
          );
        };

        const displaced = await scanDirectory(siblingRecovery, roots, limits, {
          requireSkill: true,
          includeContent: false,
          signal,
        }).catch((error: unknown) => rollback(error));
        if (
          expectedTarget.kind !== "directory" ||
          displaced.manifest.hash !== expectedTarget.manifestHash ||
          displaced.manifest.files !== expectedTarget.files ||
          displaced.manifest.bytes !== expectedTarget.bytes
        ) {
          await rollback(
            new ManagementError(
              "conflict",
              `Target changed immediately before it was displaced: ${target}`,
            ),
          );
        }

        await onRecoveryUpdate({
          backupSnapshotId: backupId,
          recoveryPath,
          recoveryDestinationPath: managedRecovery,
          recoveryState: "moving",
        });
        try {
          await rename(recoveryPath, managedRecovery);
          recoveryPath = managedRecovery;
        } catch {
          // Cross-device and permission failures keep the original directory beside the target.
        }
        await onRecoveryUpdate({
          backupSnapshotId: backupId,
          recoveryPath,
          recoveryState: "preserved",
        });

        try {
          await rename(stage, target);
        } catch (error) {
          await rollback(error);
        }
        const installed = await scanDirectory(target, roots, limits, {
          requireSkill: false,
          includeContent: false,
          signal,
        });
        if (installed.manifest.hash !== materializeManifest(source.manifest).hash) {
          throw new ManagementError(
            "conflict",
            `Installed content failed verification: ${target}. Recovery remains at ${recoveryPath}.`,
          );
        }
        return {
          backupSnapshotId: backupId,
          recoveryPath,
          recoveryState: "preserved",
        };
      } else {
        await revalidateTarget(target, expectedTarget, roots, signal);
        await rename(stage, target);
      }
      const installed = await scanDirectory(target, roots, limits, {
        requireSkill: false,
        includeContent: false,
        signal,
      });
      if (installed.manifest.hash !== materializeManifest(source.manifest).hash) {
        throw new ManagementError("conflict", `Installed content failed verification: ${target}`);
      }
      return { backupSnapshotId: backupId };
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  }

  async function executeSync(
    plan: SyncPlan,
    item: OperationItemRecord,
    onItemUpdate: () => Promise<void>,
    signal?: AbortSignal,
  ): Promise<void> {
    if (plan.action === "skip") {
      item.status = "skipped";
      return;
    }
    const roots = await resolveAuthorizedRoots(options);
    const source = await scanDirectory(plan.source.path, roots, limits, {
      requireSkill: true,
      includeContent: true,
      signal,
    });
    if (!revisionsEqual(source.revision, plan.source.revision)) {
      throw new ManagementError("conflict", "Source changed after the sync plan was created.");
    }
    const installed = await installDirectory(
      source,
      plan.target.path,
      plan.action,
      plan.target.revision,
      roots,
      async (update) => {
        item.backupSnapshotId = update.backupSnapshotId;
        item.recoveryPath = update.recoveryPath;
        item.recoveryDestinationPath = update.recoveryDestinationPath;
        item.recoveryState = update.recoveryState;
        await onItemUpdate();
      },
      signal,
    );
    item.backupSnapshotId = installed.backupSnapshotId;
    item.recoveryPath = installed.recoveryPath;
    item.recoveryState = installed.recoveryState;
    item.recoveryDestinationPath = undefined;
    item.status = "succeeded";
  }

  async function executeRestoreItem(
    planItem: RestorePlanItem,
    operationItem: OperationItemRecord,
    metadata: StoredBackup,
    onItemUpdate: () => Promise<void>,
    signal?: AbortSignal,
  ): Promise<void> {
    if (planItem.action === "skip") {
      operationItem.status = "skipped";
      return;
    }
    const roots = await resolveAuthorizedRoots(options);
    const entry = metadata.entries.find((candidate) => candidate.id === planItem.entryId);
    if (!entry)
      throw new ManagementError("corrupt-data", "Restore entry disappeared from metadata.");
    const sourcePath = join(backupsDirectory, metadata.id, entry.storage);
    const source = await scanDirectory(
      sourcePath,
      roots.concat([await backupAuthorizedRoot(sourcePath)]),
      limits,
      {
        requireSkill: false,
        includeContent: true,
        signal,
      },
    );
    if (source.manifest.hash !== entry.storedManifest.hash) {
      throw new ManagementError(
        "corrupt-data",
        `Backup content was modified: ${metadata.id}/${entry.id}`,
      );
    }
    const installed = await installDirectory(
      source,
      planItem.target,
      planItem.action,
      planItem.targetRevision,
      roots,
      async (update) => {
        operationItem.backupSnapshotId = update.backupSnapshotId;
        operationItem.recoveryPath = update.recoveryPath;
        operationItem.recoveryDestinationPath = update.recoveryDestinationPath;
        operationItem.recoveryState = update.recoveryState;
        await onItemUpdate();
      },
      signal,
    );
    operationItem.backupSnapshotId = installed.backupSnapshotId;
    operationItem.recoveryPath = installed.recoveryPath;
    operationItem.recoveryState = installed.recoveryState;
    operationItem.recoveryDestinationPath = undefined;
    operationItem.status = "succeeded";
  }

  async function backupAuthorizedRoot(path: string): Promise<AuthorizedRoot> {
    const real = await realpath(path);
    return {
      logicalPath: path,
      expectedRealPath: real,
      anchorLogicalPath: path,
      anchorRealPath: real,
    };
  }

  async function recoverInterruptedOperations(): Promise<void> {
    const entries = await readdir(operationsDirectory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const path = join(operationsDirectory, entry.name);
      const value = await readJson(path);
      assertOperation(value, path);
      if (value.status !== "running") continue;
      value.status = "interrupted";
      value.completedAt = new Date().toISOString();
      value.error = "The previous process stopped before this operation completed.";
      for (const item of value.items) {
        if (item.status === "pending") {
          item.status = "interrupted";
          item.error = value.error;
        }
      }
      await persistOperation(value);
    }
  }

  const store: ManagementStore = {
    async planSync(input) {
      checkAbort(input.signal);
      if (typeof input.allowReplace !== "boolean") {
        throw new ManagementError("invalid-input", "allowReplace must be an explicit boolean.");
      }
      const roots = await resolveAuthorizedRoots(options);
      const sourcePath = requireAbsolutePath(input.source, "Source");
      const targetPath = requireAbsolutePath(input.target, "Target");
      const source = await scanDirectory(sourcePath, roots, limits, {
        requireSkill: true,
        includeContent: false,
        signal: input.signal,
      });
      const target = await inspectPath(targetPath, roots, limits, { signal: input.signal });
      const decision = conflictForTarget(source, target, input.allowReplace);
      const createdAt = new Date();
      const plan: SyncPlan = {
        id: randomUUID(),
        kind: "sync",
        createdAt: createdAt.toISOString(),
        expiresAt: new Date(createdAt.getTime() + limits.planTtlMs).toISOString(),
        allowReplace: input.allowReplace,
        source: {
          path: sourcePath,
          realPath: source.realPath,
          revision: source.revision,
          manifest: source.manifest,
        },
        target: { path: targetPath, revision: target.revision },
        action: decision.action,
        executable: decision.action !== "conflict",
        ...(decision.conflict ? { conflict: decision.conflict } : {}),
        compatibilityWarnings: compatibilityWarnings(input, source.skillContent),
      };
      plans.set(plan.id, { plan, consumed: false });
      return plan;
    },

    async execute(planId, executeOptions: ExecuteOptions = {}) {
      const planned = plans.get(planId);
      if (!planned) throw new ManagementError("missing", "Plan is unknown to this process.");
      if (planned.consumed)
        throw new ManagementError("plan-consumed", "Plan was already executed.");
      planned.consumed = true;
      if (Date.now() > Date.parse(planned.plan.expiresAt)) {
        throw new ManagementError("expired-plan", "Plan expired; create a new plan.");
      }
      if (!planned.plan.executable) {
        throw new ManagementError("conflict", "Plan has unresolved conflicts and cannot execute.");
      }

      return withMutation(async () => {
        const operation: OperationRecord = {
          id: randomUUID(),
          planId,
          kind: planned.plan.kind,
          status: "running",
          startedAt: new Date().toISOString(),
          items:
            planned.plan.kind === "sync"
              ? [
                  {
                    id: randomUUID(),
                    target: planned.plan.target.path,
                    action: planned.plan.action,
                    status: "pending",
                  },
                ]
              : planned.plan.items.map((item) => ({
                  id: item.id,
                  target: item.target,
                  action: item.action,
                  status: "pending",
                })),
        };
        await persistOperation(operation);
        try {
          if (planned.plan.kind === "sync") {
            await executeSync(
              planned.plan,
              operation.items[0] as OperationItemRecord,
              () => persistOperation(operation),
              executeOptions.signal,
            );
          } else {
            const metadata = await readBackup(planned.plan.snapshotId);
            for (let index = 0; index < planned.plan.items.length; index += 1) {
              const planItem = planned.plan.items[index];
              const operationItem = operation.items[index];
              if (!planItem || !operationItem) continue;
              try {
                await executeRestoreItem(
                  planItem,
                  operationItem,
                  metadata,
                  () => persistOperation(operation),
                  executeOptions.signal,
                );
              } catch (error) {
                operationItem.status =
                  error instanceof ManagementError && error.code === "aborted"
                    ? "cancelled"
                    : "failed";
                operationItem.error = message(error);
                await persistOperation(operation);
                if (operationItem.status === "cancelled") throw error;
              }
              await persistOperation(operation);
            }
          }
          const failed = operation.items.filter((item) => item.status === "failed").length;
          const succeeded = operation.items.filter(
            (item) => item.status === "succeeded" || item.status === "skipped",
          ).length;
          operation.status = failed === 0 ? "succeeded" : succeeded > 0 ? "partial" : "failed";
        } catch (error) {
          const cancelled = error instanceof ManagementError && error.code === "aborted";
          operation.status = cancelled ? "cancelled" : "failed";
          operation.error = message(error);
          for (const item of operation.items) {
            if (item.status === "pending") {
              item.status = cancelled ? "cancelled" : "failed";
              item.error = message(error);
            }
          }
        }
        operation.completedAt = new Date().toISOString();
        await persistOperation(operation);
        return operation;
      });
    },

    async createBackup(entries, backupOptions = {}) {
      return withMutation(() => createBackupInternal(entries, backupOptions));
    },

    async listBackups() {
      const directoryEntries = await readdir(backupsDirectory, { withFileTypes: true });
      const results: BackupSummary[] = [];
      for (const entry of directoryEntries) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
        const metadata = await readBackup(entry.name);
        results.push(backupSummary(metadata));
      }
      return results.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    },

    async exportBackup(
      snapshotId: string,
      destination: string,
      transferOptions: TransferBackupOptions = {},
    ): Promise<PortableBackupResult> {
      return withMutation(async () => {
        checkAbort(transferOptions.signal);
        const metadata = await readBackup(snapshotId);
        const roots = await resolveAuthorizedRoots(options);
        const destinationPath = requireAbsolutePath(destination, "Backup export destination");
        await assertTargetAuthorized(destinationPath, roots);
        if (await lstatOptional(destinationPath)) {
          throw new ManagementError(
            "conflict",
            `Export destination already exists: ${destinationPath}`,
          );
        }
        await ensureAuthorizedParent(destinationPath, roots);
        const parent = dirname(destinationPath);
        const stage = await mkdtemp(join(parent, `.koyori-export-${basename(destinationPath)}-`));
        await rm(stage, { recursive: true });
        try {
          await mkdir(join(stage, "entries"), { recursive: true });
          const portableEntries: PortableBackupManifest["entries"] = [];
          for (const entry of metadata.entries) {
            checkAbort(transferOptions.signal);
            const sourcePath = join(backupsDirectory, metadata.id, entry.storage);
            const sourceRoots = roots.concat([await backupAuthorizedRoot(sourcePath)]);
            const scanned = await scanDirectory(sourcePath, sourceRoots, limits, {
              requireSkill: true,
              includeContent: true,
              signal: transferOptions.signal,
            });
            if (scanned.manifest.hash !== entry.storedManifest.hash) {
              throw new ManagementError(
                "corrupt-data",
                `Backup content was modified: ${metadata.id}/${entry.id}`,
              );
            }
            await writeScannedDirectory(
              join(stage, "entries", entry.id),
              scanned,
              transferOptions.signal,
            );
            portableEntries.push({
              id: entry.id,
              name: entry.name,
              directoryName: entry.directoryName,
              ...(entry.client ? { client: entry.client } : {}),
              files: scanned.manifest.files,
              bytes: scanned.manifest.bytes,
              manifest: scanned.manifest,
            });
          }
          const portable: PortableBackupManifest = {
            schema: "koyori.skill-backup",
            version: 1,
            id: metadata.id,
            createdAt: metadata.createdAt,
            entries: portableEntries,
          };
          await atomicWriteJson(join(stage, "backup.json"), portable);
          checkAbort(transferOptions.signal);
          if (await lstatOptional(destinationPath)) {
            throw new ManagementError(
              "conflict",
              `Export destination appeared during export: ${destinationPath}`,
            );
          }
          await rename(stage, destinationPath);
          return { path: destinationPath, manifest: portable };
        } finally {
          await rm(stage, { recursive: true, force: true });
        }
      });
    },

    async importBackup(
      path: string,
      transferOptions: TransferBackupOptions = {},
    ): Promise<BackupSummary> {
      return withMutation(async () => {
        checkAbort(transferOptions.signal);
        const packagePath = requireAbsolutePath(path, "Backup import path");
        const roots = await resolveAuthorizedRoots(options);
        const packageRealPath = await realpath(packagePath);
        assertRealAuthorized(packageRealPath, roots);
        const manifestRead = await readStableFile(
          join(packagePath, "backup.json"),
          roots,
          limits,
          transferOptions.signal,
        );
        let portableValue: unknown;
        try {
          portableValue = JSON.parse(manifestRead.bytes.toString("utf8"));
        } catch (error) {
          throw new ManagementError(
            "corrupt-data",
            `Cannot parse portable backup manifest: ${message(error)}`,
          );
        }
        assertPortableManifest(portableValue, join(packagePath, "backup.json"), limits);
        const topLevel = (await readdir(packagePath)).sort();
        if (JSON.stringify(topLevel) !== JSON.stringify(["backup.json", "entries"])) {
          throw new ManagementError(
            "corrupt-data",
            "Portable backup contains unexpected top-level entries.",
          );
        }
        const expectedEntryIds = portableValue.entries.map((entry) => entry.id).sort();
        const actualEntryIds = (await readdir(join(packagePath, "entries"))).sort();
        if (JSON.stringify(expectedEntryIds) !== JSON.stringify(actualEntryIds)) {
          throw new ManagementError(
            "corrupt-data",
            "Portable backup entry directories do not match its manifest.",
          );
        }

        const scans = new Map<string, ScannedDirectory>();
        for (const entry of portableValue.entries) {
          checkAbort(transferOptions.signal);
          const scanned = await scanDirectory(
            join(packagePath, "entries", entry.id),
            roots,
            limits,
            {
              requireSkill: true,
              includeContent: true,
              signal: transferOptions.signal,
            },
          );
          if (
            scanned.manifest.hash !== entry.manifest.hash ||
            scanned.manifest.files !== entry.files ||
            scanned.manifest.bytes !== entry.bytes
          ) {
            throw new ManagementError(
              "corrupt-data",
              `Portable backup content does not match its digest: ${entry.id}`,
            );
          }
          scans.set(entry.id, scanned);
        }

        const id = randomUUID();
        const temporaryDirectory = await mkdtemp(join(backupsDirectory, `.importing-${id}-`));
        const finalDirectory = join(backupsDirectory, id);
        try {
          const storedEntries: StoredBackupEntry[] = [];
          for (const entry of portableValue.entries) {
            const scanned = scans.get(entry.id);
            if (!scanned)
              throw new ManagementError("corrupt-data", "Validated import disappeared.");
            const storage = join("entries", entry.id);
            await mkdir(dirname(join(temporaryDirectory, storage)), { recursive: true });
            await writeScannedDirectory(
              join(temporaryDirectory, storage),
              scanned,
              transferOptions.signal,
            );
            storedEntries.push({
              id: entry.id,
              name: entry.name,
              directoryName: entry.directoryName,
              ...(entry.client ? { client: entry.client } : {}),
              revision: scanned.revision,
              files: entry.files,
              bytes: entry.bytes,
              storage,
              manifest: entry.manifest,
              storedManifest: entry.manifest,
            });
          }
          const imported: StoredBackup = {
            version: 1,
            id,
            createdAt: new Date().toISOString(),
            reason: "import",
            entries: storedEntries,
          };
          await atomicWriteJson(join(temporaryDirectory, "metadata.json"), imported);
          await rename(temporaryDirectory, finalDirectory);
          return backupSummary(imported);
        } catch (error) {
          await rm(temporaryDirectory, { recursive: true, force: true });
          throw error;
        }
      });
    },

    async planRestore(snapshotId, targets, restoreOptions: PlanRestoreOptions) {
      checkAbort(restoreOptions.signal);
      if (typeof restoreOptions.allowReplace !== "boolean") {
        throw new ManagementError("invalid-input", "allowReplace must be an explicit boolean.");
      }
      if (targets.length === 0) {
        throw new ManagementError("invalid-input", "A restore plan requires at least one target.");
      }
      const metadata = await readBackup(snapshotId);
      const roots = await resolveAuthorizedRoots(options);
      const seenEntries = new Set<string>();
      const seenTargets = new Set<string>();
      const items: RestorePlanItem[] = [];
      for (const targetInput of targets) {
        checkAbort(restoreOptions.signal);
        const entry = metadata.entries.find((candidate) => candidate.id === targetInput.entryId);
        if (!entry) {
          throw new ManagementError(
            "invalid-input",
            `Backup entry does not exist: ${targetInput.entryId}`,
          );
        }
        const target = requireAbsolutePath(targetInput.target, "Restore target");
        if (seenEntries.has(entry.id) || seenTargets.has(target)) {
          throw new ManagementError("invalid-input", "Restore entries and targets must be unique.");
        }
        seenEntries.add(entry.id);
        seenTargets.add(target);
        const backupPath = join(backupsDirectory, metadata.id, entry.storage);
        const backupRoots = roots.concat([await backupAuthorizedRoot(backupPath)]);
        const source = await scanDirectory(backupPath, backupRoots, limits, {
          requireSkill: false,
          includeContent: false,
          signal: restoreOptions.signal,
        });
        if (source.manifest.hash !== entry.storedManifest.hash) {
          throw new ManagementError(
            "corrupt-data",
            `Backup content was modified: ${metadata.id}/${entry.id}`,
          );
        }
        const inspected = await inspectPath(target, roots, limits, {
          signal: restoreOptions.signal,
        });
        const decision = conflictForTarget(source, inspected, restoreOptions.allowReplace);
        items.push({
          id: randomUUID(),
          entryId: entry.id,
          sourceRevision: source.revision,
          target,
          targetRevision: inspected.revision,
          action: decision.action,
          ...(decision.conflict ? { conflict: decision.conflict } : {}),
        });
      }
      const createdAt = new Date();
      const plan: RestorePlan = {
        id: randomUUID(),
        kind: "restore",
        snapshotId,
        createdAt: createdAt.toISOString(),
        expiresAt: new Date(createdAt.getTime() + limits.planTtlMs).toISOString(),
        allowReplace: restoreOptions.allowReplace,
        executable: items.every((item) => item.action !== "conflict"),
        items,
      };
      plans.set(plan.id, { plan, consumed: false });
      return plan;
    },

    async getOperation(id) {
      if (!/^[0-9a-f-]{36}$/i.test(id)) {
        throw new ManagementError("invalid-input", "Invalid operation id.");
      }
      const path = join(operationsDirectory, `${id}.json`);
      let value: unknown;
      try {
        value = await readJson(path);
      } catch (error) {
        if (errorCode(error) === "ENOENT") return undefined;
        throw error;
      }
      assertOperation(value, path);
      return value;
    },

    async listOperations() {
      const entries = await readdir(operationsDirectory, { withFileTypes: true });
      const results: OperationRecord[] = [];
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        const path = join(operationsDirectory, entry.name);
        const value = await readJson(path);
        assertOperation(value, path);
        results.push(value);
      }
      return results.sort((left, right) => right.startedAt.localeCompare(left.startedAt));
    },
  };

  await withMutation(recoverInterruptedOperations);
  return store;
}

export async function createManagementStore(
  dataDir: string,
  options: ManagementStoreOptions,
): Promise<ManagementStore> {
  return createManagementStoreInternal(dataDir, options, {});
}

export async function createManagementStoreWithRuntimeForTest(
  dataDir: string,
  options: ManagementStoreOptions,
  runtime: ManagementRuntime,
): Promise<ManagementStore> {
  return createManagementStoreInternal(dataDir, options, runtime);
}
