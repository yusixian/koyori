import { type ChildProcessByStdio, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Readable } from "node:stream";

import {
  GIT_BACKUP_BRANCH,
  GitBackupError,
  type GitBackupFetchedSnapshot,
  type GitBackupHistoryEntry,
  type GitBackupPublishResult,
  type GitBackupState,
  type GitBackupStatus,
  type GitBackupStore,
} from "./git-backup-types.ts";

const STORE_VERSION = 1 as const;
const REPOSITORY_DIRECTORY = "repo";
const SNAPSHOT_DIRECTORY = "snapshot";
const FETCHED_DIRECTORY = "fetched";
const SETTINGS_FILE = "settings.json";
const STATUS_FILE = "status.json";
const EMPTY_GLOBAL_CONFIG = "empty.gitconfig";
const HOOKS_DIRECTORY = "hooks-disabled";

const MAX_COMMAND_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_SNAPSHOT_FILE_BYTES = 8 * 1024 * 1024;
const MAX_SNAPSHOT_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_SNAPSHOT_FILES = 10_000;
const MAX_HISTORY_ENTRIES = 50;
const COMMAND_TIMEOUT_MS = 30_000;

const REMOTE_BRANCH = `refs/heads/${GIT_BACKUP_BRANCH}`;
const LOCAL_REMOTE_BRANCH = `refs/remotes/origin/${GIT_BACKUP_BRANCH}`;

interface PersistedSettings {
  version: typeof STORE_VERSION;
  remote: string | null;
  lastRemote?: string | null;
  branch: typeof GIT_BACKUP_BRANCH;
}

interface GitContext {
  dataDirectory: string;
  stateDirectory: string;
  repositoryDirectory: string;
  fetchedDirectory: string;
  settingsFile: string;
  statusFile: string;
  emptyGlobalConfig: string;
  hooksDirectory: string;
}

interface GitRunResult {
  stdout: string;
  stderr: string;
  stdoutBytes: Buffer;
  stderrBytes: Buffer;
  code: number;
}

interface GitRunOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
}

interface SnapshotFile {
  relativePath: string;
  bytes: Buffer;
  mode: number;
}

interface TreeFile {
  gitPath: string;
  relativePath: string;
  mode: number;
  size: number;
}

interface PortableManifestSummary {
  ids: Set<string>;
  entries: Map<string, PortableManifestEntrySummary>;
}

interface PortableManifestEntrySummary {
  fileModes: Map<string, number>;
  directoryModes: Map<string, number>;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === code,
  );
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw new GitBackupError("aborted", "The Git backup operation was cancelled.");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sanitizeText(value: string, context: GitContext, remote?: string | null): string {
  let sanitized = value
    .replace(/([a-z][a-z\d+.-]*:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/gi, "$1<redacted>@")
    .replace(/\b[^\s/@:]+:[^\s/@]+@/g, "<redacted>@");
  sanitized = sanitized.replace(new RegExp(escapeRegExp(context.dataDirectory), "g"), "<data>");
  if (remote) sanitized = sanitized.replace(new RegExp(escapeRegExp(remote), "g"), "<remote>");
  return sanitized.trim().slice(0, 2_000);
}

function errorMessage(error: unknown, context: GitContext, remote?: string | null): string {
  if (error instanceof GitBackupError) return sanitizeText(error.message, context, remote);
  if (error instanceof Error) return sanitizeText(error.message, context, remote);
  return sanitizeText(String(error), context, remote);
}

function toGitBackupError(
  error: unknown,
  context: GitContext,
  remote?: string | null,
): GitBackupError {
  if (error instanceof GitBackupError) {
    return new GitBackupError(error.code, errorMessage(error, context, remote));
  }
  return new GitBackupError("io", errorMessage(error, context, remote));
}

function isWithin(parent: string, child: string): boolean {
  const parentPath = resolve(parent);
  const childPath = resolve(child);
  const childRelative = relative(parentPath, childPath);
  return (
    childRelative === "" ||
    (!childRelative.startsWith(`..${sep}`) && childRelative !== ".." && !isAbsolute(childRelative))
  );
}

function hasUnsafeControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if ((code >= 1 && code <= 31) || code === 127) return true;
  }
  return false;
}

function assertSafeRelativePath(value: string, label: string): void {
  if (
    value === "" ||
    value.includes("\0") ||
    hasUnsafeControlCharacter(value) ||
    value.includes("\\") ||
    value.startsWith("/") ||
    value.split("/").some((part) => part === "" || part === "." || part === ".." || part === ".git")
  ) {
    throw new GitBackupError("corrupt-data", `Unsafe ${label}.`);
  }
}

function isSafeDirectoryName(value: string): boolean {
  return (
    value !== "" &&
    value !== "." &&
    value !== ".." &&
    !value.includes("/") &&
    !value.includes("\\") &&
    !value.includes("\0")
  );
}

function isState(value: unknown): value is GitBackupState {
  return (
    value === "local-only" ||
    value === "pending" ||
    value === "verified" ||
    value === "failed" ||
    value === "unknown"
  );
}

function assertSettings(value: unknown, source: string): asserts value is PersistedSettings {
  if (
    !isRecord(value) ||
    value.version !== STORE_VERSION ||
    value.branch !== GIT_BACKUP_BRANCH ||
    (value.remote !== null && typeof value.remote !== "string") ||
    (value.lastRemote !== undefined &&
      value.lastRemote !== null &&
      typeof value.lastRemote !== "string")
  ) {
    throw new GitBackupError("corrupt-data", `Invalid Git backup settings: ${source}`);
  }
  if (value.remote !== null) validateRemote(value.remote);
  if (value.lastRemote !== undefined && value.lastRemote !== null) validateRemote(value.lastRemote);
}

function assertStatus(value: unknown, source: string): asserts value is GitBackupStatus {
  if (
    !isRecord(value) ||
    value.version !== STORE_VERSION ||
    value.configured !== (value.remote !== null) ||
    (value.remote !== null && typeof value.remote !== "string") ||
    value.branch !== GIT_BACKUP_BRANCH ||
    (value.localCommit !== null && typeof value.localCommit !== "string") ||
    (value.remoteCommit !== null && typeof value.remoteCommit !== "string") ||
    !isState(value.state) ||
    (value.lastPublishedAt !== null && typeof value.lastPublishedAt !== "string") ||
    (value.lastError !== null && typeof value.lastError !== "string")
  ) {
    throw new GitBackupError("corrupt-data", `Invalid Git backup status: ${source}`);
  }
  if (value.localCommit !== null && !/^[0-9a-f]{40}$/.test(value.localCommit)) {
    throw new GitBackupError("corrupt-data", `Invalid local Git commit in status: ${source}`);
  }
  if (value.remoteCommit !== null && !/^[0-9a-f]{40}$/.test(value.remoteCommit)) {
    throw new GitBackupError("corrupt-data", `Invalid remote Git commit in status: ${source}`);
  }
  if (value.remote !== null) validateRemote(value.remote);
}

async function readJson(file: string, context: GitContext): Promise<unknown | null> {
  try {
    const content = await readFile(file, "utf8");
    try {
      return JSON.parse(content) as unknown;
    } catch {
      throw new GitBackupError("corrupt-data", `Cannot parse persistent Git backup state: ${file}`);
    }
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return null;
    throw toGitBackupError(error, context);
  }
}

async function atomicWriteJson(file: string, value: unknown, context: GitContext): Promise<void> {
  const temporary = join(
    dirname(file),
    `.${file.split(/[\\/]/).pop() ?? "state"}.${process.pid}-${randomUUID()}.tmp`,
  );
  try {
    const handle = await open(temporary, "w", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await copyFile(file, `${file}.bak`);
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
    }
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw toGitBackupError(error, context);
  }
}

async function readSettings(context: GitContext): Promise<PersistedSettings> {
  const value = await readJson(context.settingsFile, context);
  if (value === null)
    return { version: STORE_VERSION, remote: null, lastRemote: null, branch: GIT_BACKUP_BRANCH };
  assertSettings(value, context.settingsFile);
  return { ...value, lastRemote: value.lastRemote ?? value.remote };
}

async function readStatus(context: GitContext): Promise<GitBackupStatus> {
  const value = await readJson(context.statusFile, context);
  if (value === null) {
    return {
      version: STORE_VERSION,
      configured: false,
      remote: null,
      branch: GIT_BACKUP_BRANCH,
      localCommit: null,
      remoteCommit: null,
      state: "local-only",
      lastPublishedAt: null,
      lastError: null,
    };
  }
  assertStatus(value, context.statusFile);
  return value;
}

function gitEnvironment(
  context: GitContext,
  extra?: Record<string, string | undefined>,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (/^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/.test(key)) delete environment[key];
  }
  environment.GIT_CONFIG_NOSYSTEM = "1";
  environment.GIT_CONFIG_GLOBAL = context.emptyGlobalConfig;
  environment.GIT_TERMINAL_PROMPT = "0";
  environment.GIT_ASKPASS = "";
  for (const [key, value] of Object.entries(extra ?? {})) {
    if (value === undefined) delete environment[key];
    else environment[key] = value;
  }
  return environment;
}

function gitArguments(context: GitContext, args: string[]): string[] {
  return ["-c", `core.hooksPath=${context.hooksDirectory}`, "-c", "core.fsmonitor=false", ...args];
}

async function runGit(
  context: GitContext,
  args: string[],
  options: GitRunOptions = {},
): Promise<GitRunResult> {
  checkAbort(options.signal);
  const timeoutMs = options.timeoutMs ?? COMMAND_TIMEOUT_MS;
  return await new Promise<GitRunResult>((resolvePromise, rejectPromise) => {
    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      child = spawn("git", gitArguments(context, args), {
        cwd: context.repositoryDirectory,
        env: gitEnvironment(context, options.env),
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      rejectPromise(toGitBackupError(error, context));
      return;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let outputBytes = 0;
    let forcedError: GitBackupError | undefined;
    let finished = false;
    let killTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      forcedError = new GitBackupError("timeout", "Git backup command timed out.");
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 500);
    }, timeoutMs);

    const finish = (error?: GitBackupError, result?: GitRunResult): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", onAbort);
      if (error) rejectPromise(error);
      else if (result) resolvePromise(result);
      else rejectPromise(new GitBackupError("git", "Git backup command did not produce a result."));
    };

    const onAbort = (): void => {
      forcedError = new GitBackupError("aborted", "The Git backup operation was cancelled.");
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 500);
    };

    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      outputBytes += bytes.byteLength;
      if (outputBytes > MAX_COMMAND_OUTPUT_BYTES) {
        forcedError = new GitBackupError("limit", "Git backup command output exceeded its limit.");
        child.kill("SIGTERM");
        return;
      }
      stdoutChunks.push(bytes);
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      outputBytes += bytes.byteLength;
      if (outputBytes > MAX_COMMAND_OUTPUT_BYTES) {
        forcedError = new GitBackupError("limit", "Git backup command output exceeded its limit.");
        child.kill("SIGTERM");
        return;
      }
      stderrChunks.push(bytes);
    });
    child.once("error", (error) => {
      finish(forcedError ?? toGitBackupError(error, context));
    });
    child.once("close", (code) => {
      if (forcedError) {
        finish(forcedError);
        return;
      }
      const stdoutBytes = Buffer.concat(stdoutChunks);
      const stderrBytes = Buffer.concat(stderrChunks);
      const result: GitRunResult = {
        stdout: stdoutBytes.toString("utf8"),
        stderr: stderrBytes.toString("utf8"),
        stdoutBytes,
        stderrBytes,
        code: code ?? -1,
      };
      if (result.code !== 0) {
        const detail = sanitizeText(
          result.stderr || result.stdout || `Git exited with code ${result.code}.`,
          context,
        );
        finish(new GitBackupError("git", detail));
        return;
      }
      finish(undefined, result);
    });
  });
}

async function tryGit(
  context: GitContext,
  args: string[],
  options: GitRunOptions = {},
): Promise<GitRunResult | null> {
  try {
    return await runGit(context, args, options);
  } catch (error) {
    const backupError = toGitBackupError(error, context);
    if (backupError.code === "git") return null;
    throw backupError;
  }
}

function normalizeRemote(remote: string): string {
  if (remote.startsWith("/") || remote.startsWith("~")) return resolve(remote);
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(remote) || /^(?:[^\s/:]+@)?[^\s/:]+:[^\s]+$/.test(remote))
    return remote;
  return resolve(remote);
}

function validateRemote(remote: string): string {
  if (
    remote.trim() !== remote ||
    remote === "" ||
    remote.includes("\0") ||
    remote.startsWith("-")
  ) {
    throw new GitBackupError("invalid-input", "Invalid Git backup remote.");
  }
  if (hasUnsafeControlCharacter(remote) || /[;&|`$<>]/.test(remote)) {
    throw new GitBackupError("invalid-input", "Git backup remote contains unsafe characters.");
  }
  if (
    /^file:/i.test(remote) ||
    /^ext::/i.test(remote) ||
    /^fd::/i.test(remote) ||
    /^git\+file:/i.test(remote)
  ) {
    throw new GitBackupError("invalid-input", "This Git backup remote protocol is not allowed.");
  }
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(remote)) {
    let parsed: URL;
    try {
      parsed = new URL(remote);
    } catch {
      throw new GitBackupError("invalid-input", "Invalid Git backup remote URL.");
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "ssh:") {
      throw new GitBackupError(
        "invalid-input",
        "Only HTTPS and SSH Git backup remotes are allowed.",
      );
    }
    if (
      parsed.password !== "" ||
      parsed.search !== "" ||
      parsed.hash !== "" ||
      parsed.hostname === "" ||
      (parsed.protocol === "https:" && parsed.username !== "")
    ) {
      throw new GitBackupError(
        "invalid-input",
        "Git backup remotes cannot contain passwords or options.",
      );
    }
    return normalizeRemote(remote);
  }
  if (/^[^\s/:]+:[^@\s]+@[^\s/:]+:[^\s]+$/.test(remote)) {
    throw new GitBackupError("invalid-input", "Git backup remotes cannot contain passwords.");
  }
  if (/^(?:[^\s/:]+@)?[^\s/:]+:[^\s]+$/.test(remote)) return normalizeRemote(remote);
  if (remote.includes("://") || remote.includes("\n") || remote.includes("\r")) {
    throw new GitBackupError("invalid-input", "Invalid Git backup remote.");
  }
  const local = normalizeRemote(remote);
  if (local.startsWith("-"))
    throw new GitBackupError("invalid-input", "Invalid Git backup remote path.");
  return local;
}

function classifyTransportFailure(error: GitBackupError): boolean {
  if (error.code === "timeout") return true;
  const text = error.message.toLowerCase();
  return /could not resolve host|unable to access|connection|timed out|network|no such file|terminal prompts disabled|could not read from remote/.test(
    text,
  );
}

function classifyConflict(error: GitBackupError): boolean {
  if (error.code === "conflict") return true;
  return /non-fast-forward|rejected|fetch first|unrelated histories|diverg/.test(
    error.message.toLowerCase(),
  );
}

async function ensureRepository(context: GitContext): Promise<void> {
  await mkdir(context.repositoryDirectory, { recursive: true });
  const gitPath = join(context.repositoryDirectory, ".git");
  try {
    const gitStat = await lstat(gitPath);
    if (!gitStat.isDirectory() && !gitStat.isFile()) {
      throw new GitBackupError("corrupt-data", "The private Git backup repository is invalid.");
    }
    const bare = await runGit(context, ["rev-parse", "--is-bare-repository"]);
    if (bare.stdout.trim() === "true") {
      throw new GitBackupError("corrupt-data", "The private Git backup repository cannot be bare.");
    }
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw toGitBackupError(error, context);
    await runGit(context, ["init", "--quiet", `--initial-branch=${GIT_BACKUP_BRANCH}`]);
  }
  const branch = await tryGit(context, ["symbolic-ref", "--short", "HEAD"]);
  if (branch && branch.stdout.trim() !== GIT_BACKUP_BRANCH) {
    await runGit(context, ["checkout", "-B", GIT_BACKUP_BRANCH]);
  }
}

async function localCommit(context: GitContext): Promise<string | null> {
  try {
    await lstat(join(context.repositoryDirectory, ".git"));
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return null;
    throw toGitBackupError(error, context);
  }
  const result = await tryGit(context, ["rev-parse", `refs/heads/${GIT_BACKUP_BRANCH}`]);
  const commit = result?.stdout.trim() ?? "";
  return /^[0-9a-f]{40}$/.test(commit) ? commit : null;
}

async function configureOrigin(context: GitContext, remote: string): Promise<void> {
  const existing = await tryGit(context, ["remote", "get-url", "origin"]);
  if (existing) await runGit(context, ["remote", "set-url", "origin", remote]);
  else await runGit(context, ["remote", "add", "origin", remote]);
  await runGit(context, ["remote", "set-url", "--push", "origin", remote]);
}

function parseRemoteHead(stdout: string, context: GitContext, remote: string): string | null {
  const line = stdout
    .trim()
    .split(/\r?\n/)
    .find((candidate) => candidate.trim() !== "");
  if (!line) return null;
  const [commit, ref] = line.trim().split(/\s+/);
  if (ref !== REMOTE_BRANCH || !/^[0-9a-f]{40}$/.test(commit ?? "")) {
    throw new GitBackupError(
      "corrupt-data",
      sanitizeText("Remote backup branch returned an invalid commit.", context, remote),
    );
  }
  return commit ?? null;
}

async function remoteHead(
  context: GitContext,
  remote: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const result = await runGit(context, ["ls-remote", "--heads", "origin", REMOTE_BRANCH], {
    signal,
  });
  return parseRemoteHead(result.stdout, context, remote);
}

async function fetchRemote(
  context: GitContext,
  remote: string,
  signal?: AbortSignal,
): Promise<string | null> {
  checkAbort(signal);
  const head = await remoteHead(context, remote, signal);
  if (!head) return null;
  await runGit(
    context,
    ["fetch", "--no-tags", "origin", `${REMOTE_BRANCH}:${LOCAL_REMOTE_BRANCH}`],
    { signal },
  );
  const fetched = (
    await runGit(context, ["rev-parse", LOCAL_REMOTE_BRANCH], { signal })
  ).stdout.trim();
  if (fetched !== head)
    throw new GitBackupError("git", "Fetched Git backup commit could not be verified.");
  return head;
}

async function isAncestor(
  context: GitContext,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  return (await tryGit(context, ["merge-base", "--is-ancestor", ancestor, descendant])) !== null;
}

async function reconcileRemote(
  context: GitContext,
  remoteHeadCommit: string | null,
): Promise<void> {
  if (!remoteHeadCommit) return;
  const local = await localCommit(context);
  if (!local) {
    await runGit(context, ["checkout", "-B", GIT_BACKUP_BRANCH, LOCAL_REMOTE_BRANCH]);
    return;
  }
  if (local === remoteHeadCommit) return;
  if (await isAncestor(context, local, remoteHeadCommit)) {
    await runGit(context, ["merge", "--ff-only", LOCAL_REMOTE_BRANCH]);
    return;
  }
  if (await isAncestor(context, remoteHeadCommit, local)) return;
  throw new GitBackupError("conflict", "Local and remote Git backup histories diverged.");
}

async function persistStatus(context: GitContext, status: GitBackupStatus): Promise<void> {
  await atomicWriteJson(context.statusFile, status, context);
}

async function statusWithCurrentCommit(
  context: GitContext,
  settings: PersistedSettings,
): Promise<GitBackupStatus> {
  const persisted = await readStatus(context);
  let currentCommit = persisted.localCommit;
  try {
    currentCommit = await localCommit(context);
  } catch (error) {
    const backupError = toGitBackupError(error, context, settings.remote);
    if (backupError.code !== "git" && backupError.code !== "io") throw backupError;
  }
  return {
    ...persisted,
    configured: settings.remote !== null,
    remote: settings.remote,
    branch: GIT_BACKUP_BRANCH,
    localCommit: currentCommit,
    state: settings.remote === null ? "local-only" : persisted.state,
  };
}

function assertNoPrivateValues(value: unknown, key?: string): void {
  if (typeof value === "string") {
    if (value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\")) {
      throw new GitBackupError("corrupt-data", "Portable Git backup contains an absolute path.");
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertNoPrivateValues(item, key);
    return;
  }
  if (!isRecord(value)) return;
  if (
    key &&
    /(?:original|real)path|sessions?|app.?configs?|credentials?|tokens?|secrets?/i.test(key)
  ) {
    throw new GitBackupError(
      "corrupt-data",
      "Portable Git backup contains private configuration metadata.",
    );
  }
  for (const [childKey, childValue] of Object.entries(value))
    assertNoPrivateValues(childValue, childKey);
}

function parsePortableManifest(bytes: Buffer): PortableManifestSummary {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new GitBackupError("corrupt-data", "Portable Git backup manifest is not valid JSON.");
  }
  assertNoPrivateValues(value);
  if (
    !isRecord(value) ||
    value.schema !== "koyori.skill-backup" ||
    value.version !== 1 ||
    typeof value.id !== "string" ||
    !/^[A-Za-z0-9._-]{1,100}$/.test(value.id) ||
    !Array.isArray(value.entries) ||
    value.entries.length === 0 ||
    value.entries.length > MAX_SNAPSHOT_FILES
  ) {
    throw new GitBackupError("corrupt-data", "Portable Git backup manifest has an invalid shape.");
  }
  const ids = new Set<string>();
  const entries = new Map<string, PortableManifestEntrySummary>();
  for (const entry of value.entries) {
    if (
      !isRecord(entry) ||
      typeof entry.id !== "string" ||
      !/^[A-Za-z0-9._-]{1,100}$/.test(entry.id) ||
      ids.has(entry.id) ||
      (entry.directoryName !== undefined &&
        (typeof entry.directoryName !== "string" || !isSafeDirectoryName(entry.directoryName)))
    ) {
      throw new GitBackupError(
        "corrupt-data",
        "Portable Git backup manifest contains an invalid entry.",
      );
    }
    if (!isRecord(entry.manifest) || !Array.isArray(entry.manifest.entries)) {
      throw new GitBackupError(
        "corrupt-data",
        "Portable Git backup entry has no directory manifest.",
      );
    }
    const fileModes = new Map<string, number>();
    const directoryModes = new Map<string, number>();
    for (const manifestEntry of entry.manifest.entries) {
      if (
        !isRecord(manifestEntry) ||
        typeof manifestEntry.path !== "string" ||
        manifestEntry.path === "" ||
        manifestEntry.path.includes("\\") ||
        hasUnsafeControlCharacter(manifestEntry.path) ||
        manifestEntry.path.startsWith("/") ||
        manifestEntry.path
          .split("/")
          .some((part) => part === "" || part === "." || part === ".." || part === ".git") ||
        (manifestEntry.kind !== "file" && manifestEntry.kind !== "directory") ||
        manifestEntry.sourceKind !== manifestEntry.kind ||
        typeof manifestEntry.mode !== "number" ||
        !Number.isInteger(manifestEntry.mode) ||
        manifestEntry.mode < 0 ||
        manifestEntry.mode > 0o777
      ) {
        throw new GitBackupError(
          "corrupt-data",
          "Portable Git backup directory manifest contains an unsafe entry.",
        );
      }
      if (manifestEntry.kind === "file") {
        if (fileModes.has(manifestEntry.path))
          throw new GitBackupError(
            "corrupt-data",
            "Portable Git backup manifest contains duplicate files.",
          );
        fileModes.set(manifestEntry.path, manifestEntry.mode);
      } else {
        if (directoryModes.has(manifestEntry.path))
          throw new GitBackupError(
            "corrupt-data",
            "Portable Git backup manifest contains duplicate directories.",
          );
        directoryModes.set(manifestEntry.path, manifestEntry.mode);
      }
    }
    ids.add(entry.id);
    entries.set(entry.id, { fileModes, directoryModes });
  }
  return { ids, entries };
}

async function readRegularFile(
  path: string,
  label: string,
  signal?: AbortSignal,
): Promise<SnapshotFile> {
  checkAbort(signal);
  const entry = await lstat(path);
  if (entry.isSymbolicLink() || !entry.isFile()) {
    throw new GitBackupError("corrupt-data", `Portable Git backup contains an unsafe ${label}.`);
  }
  if (entry.size > MAX_SNAPSHOT_FILE_BYTES) {
    throw new GitBackupError("limit", "Portable Git backup file exceeds its size limit.");
  }
  const bytes = await readFile(path);
  if (bytes.byteLength > MAX_SNAPSHOT_FILE_BYTES) {
    throw new GitBackupError("limit", "Portable Git backup file exceeds its size limit.");
  }
  return { relativePath: label, bytes, mode: entry.mode & 0o777 };
}

async function collectDirectoryFiles(
  root: string,
  directory: string,
  prefix: string,
  files: SnapshotFile[],
  signal?: AbortSignal,
): Promise<void> {
  checkAbort(signal);
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    checkAbort(signal);
    if (
      entry.name === "" ||
      entry.name === "." ||
      entry.name === ".." ||
      entry.name.includes("\0") ||
      entry.name.includes("\\")
    ) {
      throw new GitBackupError("corrupt-data", "Portable Git backup contains an unsafe path.");
    }
    const filePath = join(directory, entry.name);
    const relativePath = `${prefix}/${entry.name}`;
    assertSafeRelativePath(relativePath, "portable path");
    if (!isWithin(root, filePath))
      throw new GitBackupError("corrupt-data", "Portable Git backup escaped its directory.");
    const stats = await lstat(filePath);
    if (stats.isSymbolicLink())
      throw new GitBackupError(
        "corrupt-data",
        "Portable Git backup cannot contain symbolic links.",
      );
    if (stats.isDirectory()) {
      await collectDirectoryFiles(root, filePath, relativePath, files, signal);
      continue;
    }
    if (!stats.isFile())
      throw new GitBackupError(
        "corrupt-data",
        "Portable Git backup contains an unsupported entry.",
      );
    if (files.length >= MAX_SNAPSHOT_FILES)
      throw new GitBackupError("limit", "Portable Git backup contains too many files.");
    const file = await readRegularFile(filePath, relativePath, signal);
    files.push(file);
  }
}

async function collectSnapshot(
  snapshotDirectory: string,
  signal?: AbortSignal,
): Promise<SnapshotFile[]> {
  checkAbort(signal);
  const root = resolve(snapshotDirectory);
  if (!isAbsolute(snapshotDirectory))
    throw new GitBackupError("invalid-input", "Snapshot directory must be absolute.");
  const rootStats = await lstat(root).catch((error) => {
    throw toGitBackupError(error, {
      dataDirectory: root,
      stateDirectory: root,
      repositoryDirectory: root,
      fetchedDirectory: root,
      settingsFile: root,
      statusFile: root,
      emptyGlobalConfig: root,
      hooksDirectory: root,
    });
  });
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory())
    throw new GitBackupError("invalid-input", "Snapshot path must be a directory.");
  const topLevel = await readdir(root, { withFileTypes: true });
  const names = topLevel.map((entry) => entry.name).sort();
  if (JSON.stringify(names) !== JSON.stringify(["backup.json", "entries"])) {
    throw new GitBackupError(
      "corrupt-data",
      "Portable Git backup contains unexpected top-level entries.",
    );
  }
  const manifestFile = await readRegularFile(join(root, "backup.json"), "backup.json", signal);
  const manifest = parsePortableManifest(manifestFile.bytes);
  const entriesDirectory = join(root, "entries");
  const entriesStats = await lstat(entriesDirectory);
  if (entriesStats.isSymbolicLink() || !entriesStats.isDirectory()) {
    throw new GitBackupError("corrupt-data", "Portable Git backup entries directory is unsafe.");
  }
  const entryDirectories = await readdir(entriesDirectory, { withFileTypes: true });
  const actualIds = entryDirectories.map((entry) => entry.name).sort();
  const expectedIds = [...manifest.ids].sort();
  if (JSON.stringify(actualIds) !== JSON.stringify(expectedIds)) {
    throw new GitBackupError(
      "corrupt-data",
      "Portable Git backup entries do not match its manifest.",
    );
  }
  for (const entry of entryDirectories) {
    if (!entry.isDirectory() || entry.isSymbolicLink())
      throw new GitBackupError("corrupt-data", "Portable Git backup entry directory is unsafe.");
  }
  const files: SnapshotFile[] = [manifestFile];
  for (const entry of entryDirectories.sort((left, right) => left.name.localeCompare(right.name))) {
    await collectDirectoryFiles(
      root,
      join(entriesDirectory, entry.name),
      `entries/${entry.name}`,
      files,
      signal,
    );
  }
  const totalBytes = files.reduce((total, file) => total + file.bytes.byteLength, 0);
  if (totalBytes > MAX_SNAPSHOT_TOTAL_BYTES)
    throw new GitBackupError("limit", "Portable Git backup exceeds its total size limit.");
  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

async function replaceRepositorySnapshot(
  context: GitContext,
  files: SnapshotFile[],
  signal?: AbortSignal,
): Promise<void> {
  checkAbort(signal);
  await runGit(context, ["rm", "-r", "--cached", "--ignore-unmatch", "--", SNAPSHOT_DIRECTORY], {
    signal,
  });
  const snapshotRoot = join(context.repositoryDirectory, SNAPSHOT_DIRECTORY);
  await rm(snapshotRoot, { recursive: true, force: true });
  await mkdir(snapshotRoot, { recursive: true });
  for (const file of files) {
    checkAbort(signal);
    const destination = join(snapshotRoot, ...file.relativePath.split("/"));
    if (!isWithin(snapshotRoot, destination))
      throw new GitBackupError(
        "corrupt-data",
        "Portable Git backup escaped its staging directory.",
      );
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, file.bytes, { flag: "wx", mode: file.mode || 0o644 });
  }
  for (const file of files) {
    checkAbort(signal);
    const source = join(snapshotRoot, ...file.relativePath.split("/"));
    const blob = await runGit(context, ["hash-object", "-w", "--no-filters", "--", source], {
      signal,
    });
    const object = blob.stdout.trim();
    if (!/^[0-9a-f]{40}$/.test(object))
      throw new GitBackupError("git", "Git backup blob could not be created.");
    const mode = file.mode & 0o111 ? "100755" : "100644";
    await runGit(
      context,
      [
        "update-index",
        "--add",
        "--cacheinfo",
        `${mode},${object},${SNAPSHOT_DIRECTORY}/${file.relativePath}`,
      ],
      { signal },
    );
  }
}

async function hasStagedChanges(context: GitContext, signal?: AbortSignal): Promise<boolean> {
  try {
    await runGit(
      context,
      ["diff", "--cached", "--quiet", "--exit-code", "--", SNAPSHOT_DIRECTORY],
      { signal },
    );
    return false;
  } catch (error) {
    const backupError = toGitBackupError(error, context);
    if (backupError.code === "git") return true;
    throw backupError;
  }
}

async function commitStagedSnapshot(context: GitContext, signal?: AbortSignal): Promise<string> {
  checkAbort(signal);
  if (await hasStagedChanges(context, signal)) {
    await runGit(context, ["commit", "--quiet", "-m", "Koyori backup"], {
      signal,
      env: {
        GIT_AUTHOR_NAME: "Koyori",
        GIT_AUTHOR_EMAIL: "koyori@local",
        GIT_COMMITTER_NAME: "Koyori",
        GIT_COMMITTER_EMAIL: "koyori@local",
      },
    });
  }
  const commit = await localCommit(context);
  if (!commit) throw new GitBackupError("git", "Git backup commit was not created.");
  return commit;
}

async function treeFiles(
  context: GitContext,
  commit: string,
  signal?: AbortSignal,
): Promise<TreeFile[]> {
  const result = await runGit(context, ["ls-tree", "-r", "-z", "--long", commit], { signal });
  const files: TreeFile[] = [];
  const seen = new Set<string>();
  for (const record of result.stdout.split("\0")) {
    if (!record) continue;
    const separator = record.indexOf("\t");
    if (separator < 0)
      throw new GitBackupError("corrupt-data", "Git backup tree has an invalid entry.");
    const fields = record.slice(0, separator).split(/\s+/);
    const path = record.slice(separator + 1);
    const [modeText, type, object, sizeText] = fields;
    if (
      !modeText ||
      !type ||
      !object ||
      !sizeText ||
      !/^[0-9a-f]{40}$/.test(object) ||
      !/^[0-9]+$/.test(sizeText)
    ) {
      throw new GitBackupError("corrupt-data", "Git backup tree has an invalid entry.");
    }
    const mode = Number.parseInt(modeText, 8);
    if (type !== "blob" || (mode !== 0o100644 && mode !== 0o100755)) {
      throw new GitBackupError(
        "corrupt-data",
        "Git backup tree contains an unsupported or symbolic-link entry.",
      );
    }
    if (!path.startsWith(`${SNAPSHOT_DIRECTORY}/`)) {
      throw new GitBackupError(
        "corrupt-data",
        "Git backup tree contains files outside its snapshot payload.",
      );
    }
    const relativePath = path.slice(`${SNAPSHOT_DIRECTORY}/`.length);
    assertSafeRelativePath(relativePath, "Git backup path");
    if (seen.has(relativePath))
      throw new GitBackupError("corrupt-data", "Git backup tree contains duplicate paths.");
    seen.add(relativePath);
    if (relativePath !== "backup.json" && !relativePath.startsWith("entries/")) {
      throw new GitBackupError(
        "corrupt-data",
        "Git backup tree contains an unexpected snapshot path.",
      );
    }
    if (relativePath.startsWith("entries/")) {
      const parts = relativePath.split("/");
      if (parts.length < 3 || !/^[A-Za-z0-9._-]{1,100}$/.test(parts[1] ?? "")) {
        throw new GitBackupError("corrupt-data", "Git backup tree contains an unsafe entry path.");
      }
    }
    const size = Number(sizeText);
    if (!Number.isSafeInteger(size) || size > MAX_SNAPSHOT_FILE_BYTES)
      throw new GitBackupError("limit", "Git backup file exceeds its size limit.");
    files.push({ gitPath: path, relativePath, mode: mode & 0o777, size });
    if (files.length > MAX_SNAPSHOT_FILES)
      throw new GitBackupError("limit", "Git backup contains too many files.");
  }
  const manifest = files.find((file) => file.relativePath === "backup.json");
  if (!manifest)
    throw new GitBackupError("corrupt-data", "Git backup tree has no portable manifest.");
  const entries = new Set(
    files
      .filter((file) => file.relativePath.startsWith("entries/"))
      .map((file) => file.relativePath.split("/")[1])
      .filter((entry): entry is string => typeof entry === "string"),
  );
  if (entries.size === 0)
    throw new GitBackupError("corrupt-data", "Git backup tree has no entries.");
  return files;
}

async function writeFetchedSnapshot(
  context: GitContext,
  commit: string,
  files: TreeFile[],
  signal?: AbortSignal,
): Promise<GitBackupFetchedSnapshot> {
  await mkdir(context.fetchedDirectory, { recursive: true });
  const output = await mkdtemp(join(context.fetchedDirectory, ".snapshot-"));
  let totalBytes = 0;
  try {
    let manifestSummary: PortableManifestSummary | undefined;
    const fetchedFiles: Array<{ file: TreeFile; bytes: Buffer; outputMode: number }> = [];
    for (const file of files) {
      checkAbort(signal);
      const content = await runGit(context, ["show", `${commit}:${file.gitPath}`], { signal });
      const bytes = content.stdoutBytes;
      if (bytes.byteLength !== file.size) {
        throw new GitBackupError("corrupt-data", "Git backup blob size could not be verified.");
      }
      totalBytes += bytes.byteLength;
      if (totalBytes > MAX_SNAPSHOT_TOTAL_BYTES)
        throw new GitBackupError("limit", "Git backup exceeds its total size limit.");
      if (file.relativePath === "backup.json") manifestSummary = parsePortableManifest(bytes);
      fetchedFiles.push({ file, bytes, outputMode: file.mode });
    }
    if (!manifestSummary)
      throw new GitBackupError("corrupt-data", "Git backup has no portable manifest.");
    const expectedFiles = new Map<string, number>();
    const expectedDirectories = new Map<string, number>();
    for (const [id, entry] of manifestSummary.entries) {
      const rootPath = `entries/${id}`;
      expectedDirectories.set(rootPath, 0o755);
      for (const [path, mode] of entry.fileModes) expectedFiles.set(`${rootPath}/${path}`, mode);
      for (const [path, mode] of entry.directoryModes)
        expectedDirectories.set(`${rootPath}/${path}`, mode);
    }
    const actualFiles = new Set(
      fetchedFiles.map(({ file }) => file.relativePath).filter((path) => path !== "backup.json"),
    );
    if (
      JSON.stringify([...manifestSummary.ids].sort()) !==
        JSON.stringify([...manifestSummary.entries.keys()].sort()) ||
      JSON.stringify([...expectedFiles.keys()].sort()) !== JSON.stringify([...actualFiles].sort())
    ) {
      throw new GitBackupError("corrupt-data", "Git backup entries do not match its manifest.");
    }
    for (const item of fetchedFiles) {
      const expectedMode =
        item.file.relativePath === "backup.json"
          ? item.file.mode
          : expectedFiles.get(item.file.relativePath);
      if (expectedMode === undefined && item.file.relativePath !== "backup.json") {
        throw new GitBackupError(
          "corrupt-data",
          "Git backup file is missing from its portable manifest.",
        );
      }
      item.outputMode = expectedMode ?? item.file.mode;
    }
    await mkdir(join(output, "entries"), { recursive: true });
    for (const item of fetchedFiles) {
      checkAbort(signal);
      const destination = join(output, ...item.file.relativePath.split("/"));
      if (!isWithin(output, destination))
        throw new GitBackupError("corrupt-data", "Git backup path escaped its output directory.");
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, item.bytes, { flag: "wx", mode: item.outputMode || 0o644 });
      await chmod(destination, item.outputMode || 0o644);
    }
    const directories = [...expectedDirectories.entries()].sort(
      ([left], [right]) => right.length - left.length,
    );
    for (const [path, mode] of directories) {
      const destination = join(output, ...path.split("/"));
      if (!isWithin(output, destination))
        throw new GitBackupError(
          "corrupt-data",
          "Git backup directory escaped its output directory.",
        );
      await mkdir(destination, { recursive: true });
      await chmod(destination, mode || 0o755);
    }
    return { commit, directory: output, files: files.length, bytes: totalBytes };
  } catch (error) {
    await rm(output, { recursive: true, force: true });
    throw error;
  }
}

async function historyFromRepository(
  context: GitContext,
  signal?: AbortSignal,
): Promise<GitBackupHistoryEntry[]> {
  const local = await localCommit(context);
  if (!local) return [];
  const result = await runGit(
    context,
    [
      "log",
      `--max-count=${MAX_HISTORY_ENTRIES}`,
      "--format=%H%x00%P%x00%at%x00%an%x00%s%x00",
      `refs/heads/${GIT_BACKUP_BRANCH}`,
    ],
    { signal },
  );
  const fields = result.stdout.split("\0");
  const history: GitBackupHistoryEntry[] = [];
  for (
    let index = 0;
    index + 4 < fields.length && history.length < MAX_HISTORY_ENTRIES;
    index += 5
  ) {
    const [rawCommit, rawParentText, rawTimestamp, rawAuthor, message] = fields.slice(
      index,
      index + 5,
    );
    const commit = rawCommit?.trim();
    const parentText = rawParentText?.trim() ?? "";
    const timestamp = rawTimestamp?.trim();
    const author = rawAuthor?.trim();
    if (!commit || !/^[0-9a-f]{40}$/.test(commit) || !timestamp || !author || message === undefined)
      continue;
    const seconds = Number(timestamp);
    if (!Number.isFinite(seconds)) continue;
    history.push({
      commit,
      parents: parentText
        ? parentText.split(" ").filter((parent) => /^[0-9a-f]{40}$/.test(parent))
        : [],
      message: message.slice(0, 500),
      author: author.slice(0, 200),
      committedAt: new Date(seconds * 1_000).toISOString(),
    });
  }
  return history;
}

export async function createGitBackupStore(dataDirectory: string): Promise<GitBackupStore> {
  if (!isAbsolute(dataDirectory))
    throw new GitBackupError("invalid-input", "Git backup data directory must be absolute.");
  const dataPath = resolve(dataDirectory);
  const stateDirectory = dataPath;
  const context: GitContext = {
    dataDirectory: dataPath,
    stateDirectory,
    repositoryDirectory: join(stateDirectory, REPOSITORY_DIRECTORY),
    fetchedDirectory: join(stateDirectory, FETCHED_DIRECTORY),
    settingsFile: join(stateDirectory, SETTINGS_FILE),
    statusFile: join(stateDirectory, STATUS_FILE),
    emptyGlobalConfig: join(stateDirectory, EMPTY_GLOBAL_CONFIG),
    hooksDirectory: join(stateDirectory, HOOKS_DIRECTORY),
  };
  await mkdir(context.stateDirectory, { recursive: true, mode: 0o700 });
  await mkdir(context.hooksDirectory, { recursive: true, mode: 0o700 });
  try {
    const globalConfig = await readFile(context.emptyGlobalConfig);
    if (globalConfig.byteLength !== 0) {
      throw new GitBackupError(
        "corrupt-data",
        "The private Git backup global config is not empty.",
      );
    }
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      await writeFile(context.emptyGlobalConfig, "", { flag: "wx", mode: 0o600 });
    } else {
      throw toGitBackupError(error, context);
    }
  }
  await readSettings(context);
  await readStatus(context);

  return {
    async status(): Promise<GitBackupStatus> {
      const settings = await readSettings(context);
      return statusWithCurrentCommit(context, settings);
    },

    async connect(remoteInput: string): Promise<GitBackupStatus> {
      const remote = validateRemote(remoteInput);
      const existingSettings = await readSettings(context);
      await ensureRepository(context);
      const existingCommit = await localCommit(context);
      if (existingCommit && existingSettings.lastRemote && existingSettings.lastRemote !== remote) {
        throw new GitBackupError(
          "conflict",
          "This store is bound to a different Git backup remote; create a new store before changing it.",
        );
      }
      await configureOrigin(context, remote);
      const settings: PersistedSettings = {
        version: STORE_VERSION,
        remote,
        lastRemote: remote,
        branch: GIT_BACKUP_BRANCH,
      };
      await atomicWriteJson(context.settingsFile, settings, context);
      try {
        const remoteCommit = await fetchRemote(context, remote);
        await reconcileRemote(context, remoteCommit);
        const local = await localCommit(context);
        const previous = await readStatus(context);
        const nextStatus: GitBackupStatus = {
          version: STORE_VERSION,
          configured: true,
          remote,
          branch: GIT_BACKUP_BRANCH,
          localCommit: local,
          remoteCommit,
          state: remoteCommit !== null && local === remoteCommit ? "verified" : "pending",
          lastPublishedAt: previous.lastPublishedAt,
          lastError: null,
        };
        await persistStatus(context, nextStatus);
        return nextStatus;
      } catch (error) {
        const backupError = toGitBackupError(error, context, remote);
        const previous = await readStatus(context);
        await persistStatus(context, {
          ...previous,
          configured: true,
          remote,
          localCommit: await localCommit(context),
          remoteCommit: null,
          state: classifyConflict(backupError) ? "failed" : "unknown",
          lastError: errorMessage(backupError, context, remote),
        });
        throw backupError;
      }
    },

    async disconnect(): Promise<void> {
      const settings = await readSettings(context);
      if (
        await lstat(context.repositoryDirectory)
          .then(() => true)
          .catch(() => false)
      ) {
        await tryGit(context, ["remote", "remove", "origin"]);
      }
      await atomicWriteJson(context.settingsFile, { ...settings, remote: null }, context);
      const previous = await readStatus(context);
      await persistStatus(context, {
        ...previous,
        configured: false,
        remote: null,
        localCommit: await localCommit(context),
        remoteCommit: null,
        state: "local-only",
        lastError: null,
      });
    },

    async publish(snapshotDirectory: string, options = {}): Promise<GitBackupPublishResult> {
      const signal = options.signal;
      checkAbort(signal);
      const files = await collectSnapshot(snapshotDirectory, signal);
      await ensureRepository(context);
      const settings = await readSettings(context);
      let coordinationError: GitBackupError | null = null;
      let knownRemoteCommit: string | null = null;
      if (settings.remote) {
        try {
          knownRemoteCommit = await fetchRemote(context, settings.remote, signal);
          await reconcileRemote(context, knownRemoteCommit);
        } catch (error) {
          const backupError = toGitBackupError(error, context, settings.remote);
          if (classifyConflict(backupError)) throw backupError;
          coordinationError = backupError;
        }
      }
      await replaceRepositorySnapshot(context, files, signal);
      const commit = await commitStagedSnapshot(context, signal);
      const now = new Date().toISOString();
      if (!settings.remote) {
        await persistStatus(context, {
          version: STORE_VERSION,
          configured: false,
          remote: null,
          branch: GIT_BACKUP_BRANCH,
          localCommit: commit,
          remoteCommit: null,
          state: "local-only",
          lastPublishedAt: now,
          lastError: null,
        });
        return { commit, state: "local-only", remoteCommit: null, verified: false, error: null };
      }

      if (coordinationError && !classifyTransportFailure(coordinationError)) {
        const message = errorMessage(coordinationError, context, settings.remote);
        await persistStatus(context, {
          version: STORE_VERSION,
          configured: true,
          remote: settings.remote,
          branch: GIT_BACKUP_BRANCH,
          localCommit: commit,
          remoteCommit: knownRemoteCommit,
          state: "failed",
          lastPublishedAt: now,
          lastError: message,
        });
        return {
          commit,
          state: "failed",
          remoteCommit: knownRemoteCommit,
          verified: false,
          error: message,
        };
      }

      try {
        await runGit(context, ["push", "--porcelain", "origin", `${commit}:${REMOTE_BRANCH}`], {
          signal,
        });
      } catch (error) {
        const backupError = toGitBackupError(error, context, settings.remote);
        const state: GitBackupState = classifyConflict(backupError) ? "failed" : "pending";
        const message = errorMessage(backupError, context, settings.remote);
        await persistStatus(context, {
          version: STORE_VERSION,
          configured: true,
          remote: settings.remote,
          branch: GIT_BACKUP_BRANCH,
          localCommit: commit,
          remoteCommit: knownRemoteCommit,
          state,
          lastPublishedAt: now,
          lastError: message,
        });
        return { commit, state, remoteCommit: knownRemoteCommit, verified: false, error: message };
      }

      let verifiedRemote: string | null;
      try {
        verifiedRemote = await remoteHead(context, settings.remote, signal);
      } catch (error) {
        const backupError = toGitBackupError(error, context, settings.remote);
        const message = errorMessage(backupError, context, settings.remote);
        await persistStatus(context, {
          version: STORE_VERSION,
          configured: true,
          remote: settings.remote,
          branch: GIT_BACKUP_BRANCH,
          localCommit: commit,
          remoteCommit: null,
          state: "unknown",
          lastPublishedAt: now,
          lastError: message,
        });
        return { commit, state: "unknown", remoteCommit: null, verified: false, error: message };
      }
      if (verifiedRemote !== commit) {
        const message = "Remote Git backup commit did not match the published commit.";
        await persistStatus(context, {
          version: STORE_VERSION,
          configured: true,
          remote: settings.remote,
          branch: GIT_BACKUP_BRANCH,
          localCommit: commit,
          remoteCommit: verifiedRemote,
          state: "unknown",
          lastPublishedAt: now,
          lastError: message,
        });
        return {
          commit,
          state: "unknown",
          remoteCommit: verifiedRemote,
          verified: false,
          error: message,
        };
      }
      await persistStatus(context, {
        version: STORE_VERSION,
        configured: true,
        remote: settings.remote,
        branch: GIT_BACKUP_BRANCH,
        localCommit: commit,
        remoteCommit: verifiedRemote,
        state: "verified",
        lastPublishedAt: now,
        lastError: null,
      });
      return {
        commit,
        state: "verified",
        remoteCommit: verifiedRemote,
        verified: true,
        error: null,
      };
    },

    async history(options = {}): Promise<GitBackupHistoryEntry[]> {
      const signal = options.signal;
      checkAbort(signal);
      await ensureRepository(context).catch((error) => {
        throw toGitBackupError(error, context);
      });
      const settings = await readSettings(context);
      if (options.refresh && settings.remote) {
        try {
          const remoteCommit = await fetchRemote(context, settings.remote, signal);
          await reconcileRemote(context, remoteCommit);
        } catch (error) {
          const backupError = toGitBackupError(error, context, settings.remote);
          const previous = await readStatus(context);
          await persistStatus(context, {
            ...previous,
            configured: true,
            remote: settings.remote,
            localCommit: await localCommit(context),
            state: classifyConflict(backupError) ? "failed" : "unknown",
            lastError: errorMessage(backupError, context, settings.remote),
          });
          throw backupError;
        }
      }
      return historyFromRepository(context, signal);
    },

    async fetchSnapshot(commit: string, options = {}): Promise<GitBackupFetchedSnapshot> {
      const signal = options.signal;
      checkAbort(signal);
      if (!/^[0-9a-f]{40}$/.test(commit))
        throw new GitBackupError("invalid-input", "Snapshot commit must be a full Git object id.");
      await ensureRepository(context);
      const settings = await readSettings(context);
      let local = await localCommit(context);
      const known = await tryGit(context, ["cat-file", "-e", `${commit}^{commit}`], { signal });
      if (!known && settings.remote) {
        const remoteCommit = await fetchRemote(context, settings.remote, signal);
        await reconcileRemote(context, remoteCommit);
        local = await localCommit(context);
      }
      if (
        !known &&
        !(await tryGit(context, ["cat-file", "-e", `${commit}^{commit}`], { signal }))
      ) {
        throw new GitBackupError("missing", "Requested Git backup commit is unavailable locally.");
      }
      if (!local || !(await isAncestor(context, commit, local))) {
        throw new GitBackupError(
          "missing",
          "Requested Git backup commit is not part of the backup history.",
        );
      }
      const files = await treeFiles(context, commit, signal);
      return writeFetchedSnapshot(context, commit, files, signal);
    },
  };
}
