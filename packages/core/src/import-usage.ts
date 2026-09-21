import { createHash } from "node:crypto";
import { constants, type Dir, type Stats } from "node:fs";
import { lstat, open, opendir, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import type {
  HistoryCoverage,
  HistorySource,
  UsageEvent,
  UsageEvidence,
  UsageImport,
  UsageImportOptions,
  UsageIssue,
} from "./usage-types.ts";

const ADAPTER = "claude-code-jsonl/v1";
const UNSUPPORTED_ADAPTER = "unsupported/v1";
const MAX_FILES = 5_000;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_LINE_BYTES = 2 * 1024 * 1024;
const MAX_EVENTS = 50_000;
const MAX_RECORDS = 250_000;
const MAX_ISSUES = 1_000;
const MAX_DIRECTORY_DEPTH = 24;
const MAX_DISCOVERED_ENTRIES = 100_000;
const READ_CHUNK_BYTES = 64 * 1024;
const MAX_SKILL_NAME_LENGTH = 128;
const MAX_IDENTIFIER_LENGTH = 256;
const MAX_VERSION_LENGTH = 64;
const MAX_COMMAND_ENVELOPE_LENGTH = 64 * 1024;
const SKILL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$/;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$/;

const INHERENT_LIMITATIONS = [
  "Only structured Skill tool calls and recognized strict command envelopes are covered; unknown command layouts are skipped.",
  "Local history retention may be incomplete.",
];

const BUILTIN_COMMANDS = new Set([
  "clear",
  "compact",
  "config",
  "context",
  "cost",
  "doctor",
  "exit",
  "help",
  "hooks",
  "ide",
  "init",
  "login",
  "logout",
  "mcp",
  "memory",
  "model",
  "permissions",
  "plugin",
  "pr-comments",
  "release-notes",
  "resume",
  "review",
  "status",
  "terminal-setup",
  "vim",
]);

interface ImportBudget {
  files: number;
  bytes: number;
  events: number;
  records: number;
  entries: number;
  stopped: boolean;
}

interface CoverageState {
  coverage: HistoryCoverage;
  limitations: Set<string>;
  messageRecords: number;
  firstRecordMs: number | null;
  lastRecordMs: number | null;
  rootRealPath: string | null;
  rootAbsolutePath: string;
  unreadable: boolean;
}

interface EventAggregate {
  id: string;
  client: UsageEvent["client"];
  skillName: string;
  at: string;
  kind: UsageEvent["kind"];
  rawToolUseId: string | null;
  fallbackIdentity: boolean;
  sessionIdentities: Set<string>;
  sessionMissing: boolean;
  evidence: Map<string, UsageEvidence>;
  conflict: boolean;
}

interface ResultAggregate {
  loaded: boolean;
  failed: boolean;
  evidence: Map<string, UsageEvidence>;
}

interface ImportState {
  options: UsageImportOptions;
  budget: ImportBudget;
  issues: UsageIssue[];
  events: Map<string, EventAggregate>;
  results: Map<string, ResultAggregate>;
  conflictIssues: Set<string>;
  identityIssues: Set<string>;
  diagnosticLimitReached: boolean;
}

interface ParsedFile {
  recordsRead: number;
  malformedLines: number;
  messageRecords: number;
  clientVersions: Set<string>;
  firstRecord: { at: string; ms: number } | null;
  lastRecord: { at: string; ms: number } | null;
  calls: Array<{
    skillName: string;
    toolUseId: string | null;
    fallbackUuid: string | null;
    blockIndex: number;
    at: string;
    sessionId: string | null;
    agentId: string | null;
    evidence: UsageEvidence;
  }>;
  requests: Array<{
    skillName: string;
    uuid: string;
    at: string;
    sessionId: string | null;
    agentId: string | null;
    evidence: UsageEvidence;
  }>;
  results: Array<{
    toolUseId: string;
    failed: boolean;
    evidence: UsageEvidence;
  }>;
  limitations: Set<string>;
}

interface ReadSnapshot {
  opened: Stats;
  grew: boolean;
}

function stableHash(...parts: string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(part);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("The operation was aborted.", "AbortError");
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function isWithin(candidate: string, root: string): boolean {
  const difference = relative(root, candidate);
  return (
    difference === "" ||
    (!difference.startsWith(`..${sep}`) && difference !== ".." && !isAbsolute(difference))
  );
}

function portableRelative(root: string, candidate: string): string {
  return relative(root, candidate).split(sep).join("/") || ".";
}

function issue(
  sourceId: string,
  code: UsageIssue["code"],
  message: string,
  file?: string,
  line?: number,
): UsageIssue {
  return {
    sourceId,
    ...(file === undefined ? {} : { file }),
    ...(line === undefined ? {} : { line }),
    code,
    message,
  };
}

function pushIssue(state: ImportState, entry: UsageIssue, coverage?: CoverageState): void {
  if (coverage && entry.code === "unreadable") {
    coverage.unreadable = true;
    coverage.coverage.readLimited = true;
  }
  if (state.diagnosticLimitReached) {
    return;
  }
  if (state.issues.length < MAX_ISSUES - 1) {
    state.issues.push(entry);
    return;
  }
  state.diagnosticLimitReached = true;
  state.budget.stopped = true;
  state.issues.push(
    issue(
      entry.sourceId,
      "limit",
      "History import diagnostic limit was reached.",
      entry.file,
      entry.line,
    ),
  );
  coverage?.limitations.add("The history import stopped at the diagnostic limit.");
  if (coverage) {
    coverage.coverage.readLimited = true;
  }
}

function reserveRecord(
  state: ImportState,
  source: HistorySource,
  coverage: CoverageState,
  file: string,
  line: number,
): boolean {
  if (state.budget.records < MAX_RECORDS) {
    state.budget.records += 1;
    return true;
  }
  if (!state.budget.stopped) {
    state.budget.stopped = true;
    coverage.coverage.readLimited = true;
    coverage.limitations.add("The history import stopped at the record limit.");
    pushIssue(
      state,
      issue(source.id, "limit", "History import record limit was reached.", file, line),
      coverage,
    );
  }
  return false;
}

function addEvidence(target: Map<string, UsageEvidence>, evidence: UsageEvidence): void {
  target.set(`${evidence.sourceId}\0${evidence.file}\0${evidence.line}`, evidence);
}

function firstEvidence(evidence: Map<string, UsageEvidence>): UsageEvidence | undefined {
  for (const entry of evidence.values()) {
    return entry;
  }
  return undefined;
}

function timestamp(value: unknown): { at: string; ms: number } | null {
  if (typeof value !== "string" || value.length > MAX_VERSION_LENGTH) {
    return null;
  }
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? { at: value, ms: milliseconds } : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function boundedIdentifier(value: unknown): string | null {
  const found = nonEmptyString(value);
  return found && found.length <= MAX_IDENTIFIER_LENGTH && IDENTIFIER_PATTERN.test(found)
    ? found
    : null;
}

function boundedSkillName(value: unknown): string | null {
  const found = nonEmptyString(value);
  return found && found.length <= MAX_SKILL_NAME_LENGTH && SKILL_NAME_PATTERN.test(found)
    ? found
    : null;
}

function boundedVersion(value: unknown): string | null {
  const found = nonEmptyString(value);
  return found && found.length <= MAX_VERSION_LENGTH && VERSION_PATTERN.test(found) ? found : null;
}

function recordTimestamp(parsed: ParsedFile, value: unknown): void {
  const found = timestamp(value);
  if (!found) {
    return;
  }
  if (!parsed.firstRecord || found.ms < parsed.firstRecord.ms) {
    parsed.firstRecord = found;
  }
  if (!parsed.lastRecord || found.ms > parsed.lastRecord.ms) {
    parsed.lastRecord = found;
  }
}

function messageText(message: Record<string, unknown>): string | null {
  if (typeof message.content === "string") {
    return message.content.length <= MAX_COMMAND_ENVELOPE_LENGTH ? message.content : null;
  }
  if (!Array.isArray(message.content)) {
    return "";
  }
  const parts: string[] = [];
  let length = 0;
  for (const value of message.content) {
    if (isRecord(value) && value.type === "text" && typeof value.text === "string") {
      length += value.text.length;
      if (length > MAX_COMMAND_ENVELOPE_LENGTH) {
        return null;
      }
      parts.push(value.text);
    }
  }
  return parts.join("\n");
}

function strictCommandName(
  row: Record<string, unknown>,
  message: Record<string, unknown>,
): string | null {
  if (row.isMeta === true) {
    return null;
  }
  const content = messageText(message);
  if (content === null) {
    return null;
  }
  const withMessage =
    /^\s*<command-message>\s*\/?([A-Za-z0-9][A-Za-z0-9:._-]{0,127})\s*<\/command-message>\s*<command-name>\s*\/([A-Za-z0-9][A-Za-z0-9:._-]{0,127})\s*<\/command-name>(?:\s*<command-args>[\s\S]*<\/command-args>)?\s*$/.exec(
      content,
    );
  const attributed =
    /^\s*<command-name>\s*\/([A-Za-z0-9][A-Za-z0-9:._-]{0,127})\s*<\/command-name>(?:\s*<command-args>[\s\S]*<\/command-args>)?\s*$/.exec(
      content,
    );
  const messageName = boundedSkillName(withMessage?.[1]);
  const namedSkill = boundedSkillName(withMessage?.[2] ?? attributed?.[1]);
  if (!namedSkill || (messageName && messageName.toLowerCase() !== namedSkill.toLowerCase())) {
    return null;
  }
  const attribution = boundedSkillName(row.attributionSkill);
  const hasProof = messageName !== null || attribution?.toLowerCase() === namedSkill.toLowerCase();
  if (!hasProof || BUILTIN_COMMANDS.has(namedSkill.toLowerCase())) {
    return null;
  }
  return namedSkill;
}

function emptyParsedFile(): ParsedFile {
  return {
    recordsRead: 0,
    malformedLines: 0,
    messageRecords: 0,
    clientVersions: new Set(),
    firstRecord: null,
    lastRecord: null,
    calls: [],
    requests: [],
    results: [],
    limitations: new Set(),
  };
}

function parseRecord(
  state: ImportState,
  source: HistorySource,
  coverage: CoverageState,
  file: string,
  line: number,
  content: string,
  parsed: ParsedFile,
): void {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    parsed.malformedLines += 1;
    coverage.coverage.readLimited = true;
    pushIssue(
      state,
      issue(source.id, "malformed", "History record is malformed JSON.", file, line),
      coverage,
    );
    return;
  }
  if (!isRecord(value)) {
    parsed.recordsRead += 1;
    return;
  }

  const row = value;
  parsed.recordsRead += 1;
  recordTimestamp(parsed, row.timestamp);
  const version = boundedVersion(row.version);
  if (version) {
    parsed.clientVersions.add(version);
  }

  if (row.type !== "assistant" && row.type !== "user") {
    return;
  }
  if (!isRecord(row.message)) {
    return;
  }
  parsed.messageRecords += 1;
  const message = row.message;
  const rowTimestamp = timestamp(row.timestamp);
  const evidence = { sourceId: source.id, file, line };
  const agentId = boundedIdentifier(row.agentId);
  const sessionId = row.isSidechain === true && !agentId ? null : boundedIdentifier(row.sessionId);

  if (row.type === "user" && rowTimestamp) {
    const skillName = strictCommandName(row, message);
    const uuid = boundedIdentifier(row.uuid);
    if (skillName && uuid) {
      parsed.requests.push({
        skillName,
        uuid,
        at: rowTimestamp.at,
        sessionId,
        agentId,
        evidence,
      });
    } else if (skillName) {
      coverage.coverage.readLimited = true;
      pushIssue(
        state,
        issue(
          source.id,
          "identity",
          "History request lacks a stable identity and was skipped.",
          file,
          line,
        ),
        coverage,
      );
    }
  }

  if (!Array.isArray(message.content)) {
    return;
  }
  for (const [blockIndex, candidate] of message.content.entries()) {
    if (!isRecord(candidate)) {
      continue;
    }
    const block = candidate;
    if (row.type === "assistant" && block.type === "tool_use" && block.name === "Skill") {
      if (!isRecord(block.input)) {
        coverage.coverage.readLimited = true;
        pushIssue(
          state,
          issue(
            source.id,
            "malformed",
            "Structured Skill invocation has unsupported fields and was skipped.",
            file,
            line,
          ),
          coverage,
        );
        continue;
      }
      const skillName = boundedSkillName(block.input.skill);
      if (!skillName || !rowTimestamp) {
        coverage.coverage.readLimited = true;
        pushIssue(
          state,
          issue(
            source.id,
            "malformed",
            "Structured Skill invocation has unsupported fields and was skipped.",
            file,
            line,
          ),
          coverage,
        );
        continue;
      }
      const toolUseId = boundedIdentifier(block.id);
      const fallbackUuid = boundedIdentifier(row.uuid);
      if (!toolUseId && !fallbackUuid) {
        coverage.coverage.readLimited = true;
        pushIssue(
          state,
          issue(
            source.id,
            "identity",
            "History invocation lacks a stable identity and was skipped.",
            file,
            line,
          ),
          coverage,
        );
        continue;
      }
      parsed.calls.push({
        skillName,
        toolUseId,
        fallbackUuid,
        blockIndex,
        at: rowTimestamp.at,
        sessionId,
        agentId,
        evidence,
      });
      continue;
    }
    if (row.type === "user" && block.type === "tool_result") {
      const toolUseId = boundedIdentifier(block.tool_use_id);
      if (toolUseId) {
        parsed.results.push({ toolUseId, failed: block.is_error === true, evidence });
      }
    }
  }
}

async function readLines(
  handle: Awaited<ReturnType<typeof open>>,
  bytes: number,
  state: ImportState,
  source: HistorySource,
  coverage: CoverageState,
  file: string,
  parsed: ParsedFile,
  signal?: AbortSignal,
): Promise<void> {
  const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
  let position = 0;
  let line = 1;
  let parts: Buffer[] = [];
  let partBytes = 0;
  let oversized = false;

  const finishLine = (terminated: boolean): void => {
    if (!oversized && partBytes === 0) {
      line += 1;
      return;
    }
    if (!reserveRecord(state, source, coverage, file, line)) {
      return;
    }
    if (oversized) {
      coverage.coverage.readLimited = true;
      pushIssue(
        state,
        issue(source.id, "limit", "History record exceeds the per-line size limit.", file, line),
        coverage,
      );
      parsed.limitations.add("At least one oversized history record was skipped.");
    } else if (partBytes > 0) {
      const buffer = parts.length === 1 ? parts[0] : Buffer.concat(parts, partBytes);
      if (buffer) {
        const end = buffer.at(-1) === 13 ? buffer.length - 1 : buffer.length;
        let decoded: string;
        try {
          decoded = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, end));
        } catch {
          if (terminated) {
            parsed.malformedLines += 1;
            coverage.coverage.readLimited = true;
            pushIssue(
              state,
              issue(source.id, "malformed", "History record is not valid UTF-8.", file, line),
              coverage,
            );
          } else {
            parsed.limitations.add("An incomplete trailing history record was ignored.");
          }
          decoded = "";
        }
        if (decoded !== "") {
          if (!terminated) {
            try {
              JSON.parse(decoded);
            } catch {
              coverage.coverage.readLimited = true;
              parsed.limitations.add("An incomplete trailing history record was ignored.");
              decoded = "";
            }
          }
          if (decoded !== "") {
            parseRecord(state, source, coverage, file, line, decoded, parsed);
          }
        }
      }
    }
    parts = [];
    partBytes = 0;
    oversized = false;
    line += 1;
  };

  while (position < bytes) {
    throwIfAborted(signal);
    const length = Math.min(chunk.byteLength, bytes - position);
    const result = await handle.read(chunk, 0, length, position);
    throwIfAborted(signal);
    if (result.bytesRead === 0) {
      break;
    }
    position += result.bytesRead;
    let start = 0;
    for (let index = 0; index < result.bytesRead; index += 1) {
      if (chunk[index] !== 10) {
        continue;
      }
      if (!oversized && index > start) {
        const segment = Buffer.from(chunk.subarray(start, index));
        if (partBytes + segment.byteLength > MAX_LINE_BYTES) {
          oversized = true;
          parts = [];
          partBytes = 0;
        } else {
          parts.push(segment);
          partBytes += segment.byteLength;
        }
      }
      finishLine(true);
      if (state.budget.stopped) {
        return;
      }
      start = index + 1;
    }
    if (start < result.bytesRead && !oversized) {
      const segment = Buffer.from(chunk.subarray(start, result.bytesRead));
      if (partBytes + segment.byteLength > MAX_LINE_BYTES) {
        oversized = true;
        parts = [];
        partBytes = 0;
      } else {
        parts.push(segment);
        partBytes += segment.byteLength;
      }
    }
  }
  if (oversized || partBytes > 0) {
    finishLine(false);
  }
}

async function openAndReadFile(
  state: ImportState,
  source: HistorySource,
  coverage: CoverageState,
  logicalPath: string,
): Promise<{ parsed: ParsedFile; snapshot: ReadSnapshot } | null> {
  const file = portableRelative(coverage.rootAbsolutePath, logicalPath);
  throwIfAborted(state.options.signal);
  let beforeReal: string;
  let beforeStats: Stats;
  try {
    const logicalStats = await lstat(logicalPath);
    if (logicalStats.isSymbolicLink()) {
      coverage.coverage.readLimited = true;
      pushIssue(
        state,
        issue(source.id, "link", "Symbolic links are not followed while importing history.", file),
        coverage,
      );
      coverage.coverage.skippedFiles += 1;
      return null;
    }
    beforeReal = await realpath(logicalPath);
    if (!coverage.rootRealPath || !isWithin(beforeReal, coverage.rootRealPath)) {
      coverage.coverage.readLimited = true;
      pushIssue(
        state,
        issue(source.id, "link", "History file resolves outside the authorized root.", file),
        coverage,
      );
      coverage.coverage.skippedFiles += 1;
      return null;
    }
    beforeStats = await stat(beforeReal);
    if (!beforeStats.isFile()) {
      return null;
    }
  } catch {
    coverage.coverage.readLimited = true;
    pushIssue(
      state,
      issue(source.id, "unreadable", "History file could not be read safely.", file),
      coverage,
    );
    coverage.coverage.skippedFiles += 1;
    return null;
  }

  if (beforeStats.size > MAX_FILE_BYTES) {
    coverage.coverage.readLimited = true;
    pushIssue(
      state,
      issue(source.id, "limit", "History file exceeds the per-file size limit.", file),
      coverage,
    );
    coverage.limitations.add("At least one oversized history file was skipped.");
    coverage.coverage.skippedFiles += 1;
    return null;
  }
  if (state.budget.files >= MAX_FILES) {
    state.budget.stopped = true;
    coverage.coverage.readLimited = true;
    pushIssue(
      state,
      issue(source.id, "limit", "History import file limit was reached.", file),
      coverage,
    );
    coverage.limitations.add("The history import stopped at the file limit.");
    coverage.coverage.skippedFiles += 1;
    return null;
  }
  if (state.budget.bytes + beforeStats.size > MAX_TOTAL_BYTES) {
    state.budget.stopped = true;
    coverage.coverage.readLimited = true;
    pushIssue(
      state,
      issue(source.id, "limit", "History import byte limit was reached.", file),
      coverage,
    );
    coverage.limitations.add("The history import stopped at the byte limit.");
    coverage.coverage.skippedFiles += 1;
    return null;
  }

  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(logicalPath, constants.O_RDONLY | constants.O_NONBLOCK | noFollow);
    const opened = await handle.stat();
    const afterOpenReal = await realpath(logicalPath);
    const afterOpenStats = await stat(afterOpenReal);
    if (
      !opened.isFile() ||
      !coverage.rootRealPath ||
      !isWithin(afterOpenReal, coverage.rootRealPath) ||
      beforeReal !== afterOpenReal ||
      !sameFile(beforeStats, opened) ||
      !sameFile(opened, afterOpenStats) ||
      beforeStats.size !== opened.size ||
      opened.size !== afterOpenStats.size
    ) {
      coverage.coverage.readLimited = true;
      pushIssue(
        state,
        issue(source.id, "unreadable", "History file changed before it could be read.", file),
        coverage,
      );
      coverage.coverage.skippedFiles += 1;
      return null;
    }

    state.budget.files += 1;
    state.budget.bytes += opened.size;
    const parsed = emptyParsedFile();
    await readLines(
      handle,
      opened.size,
      state,
      source,
      coverage,
      file,
      parsed,
      state.options.signal,
    );

    const afterReadHandle = await handle.stat();
    const afterReadReal = await realpath(logicalPath);
    const afterReadStats = await stat(afterReadReal);
    if (
      beforeReal !== afterReadReal ||
      !coverage.rootRealPath ||
      !isWithin(afterReadReal, coverage.rootRealPath) ||
      !sameFile(opened, afterReadHandle) ||
      !sameFile(afterReadHandle, afterReadStats) ||
      afterReadHandle.size < opened.size ||
      afterReadStats.size < opened.size
    ) {
      coverage.coverage.readLimited = true;
      pushIssue(
        state,
        issue(source.id, "unreadable", "History file changed while it was being read.", file),
        coverage,
      );
      coverage.coverage.skippedFiles += 1;
      return null;
    }
    return { parsed, snapshot: { opened, grew: afterReadHandle.size > opened.size } };
  } catch (error) {
    throwIfAborted(state.options.signal);
    const code = errorCode(error);
    coverage.coverage.readLimited = true;
    pushIssue(
      state,
      issue(
        source.id,
        code === "ELOOP" ? "link" : "unreadable",
        code === "ELOOP"
          ? "Symbolic links are not followed while importing history."
          : "History file could not be read safely.",
        file,
      ),
      coverage,
    );
    coverage.coverage.skippedFiles += 1;
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function mergeParsedFile(
  state: ImportState,
  source: HistorySource,
  coverage: CoverageState,
  parsed: ParsedFile,
): void {
  coverage.coverage.filesRead += 1;
  coverage.coverage.recordsRead += parsed.recordsRead;
  coverage.coverage.malformedLines += parsed.malformedLines;
  coverage.messageRecords += parsed.messageRecords;
  for (const version of parsed.clientVersions) {
    coverage.coverage.clientVersions.push(version);
  }
  for (const value of parsed.limitations) {
    coverage.limitations.add(value);
  }
  if (parsed.limitations.size > 0) {
    coverage.coverage.readLimited = true;
  }
  if (
    parsed.firstRecord &&
    (coverage.firstRecordMs === null || parsed.firstRecord.ms < coverage.firstRecordMs)
  ) {
    coverage.firstRecordMs = parsed.firstRecord.ms;
    coverage.coverage.firstRecordAt = parsed.firstRecord.at;
  }
  if (
    parsed.lastRecord &&
    (coverage.lastRecordMs === null || parsed.lastRecord.ms > coverage.lastRecordMs)
  ) {
    coverage.lastRecordMs = parsed.lastRecord.ms;
    coverage.coverage.lastRecordAt = parsed.lastRecord.at;
  }

  for (const result of parsed.results) {
    const aggregate = state.results.get(result.toolUseId) ?? {
      loaded: false,
      failed: false,
      evidence: new Map(),
    };
    if (result.failed) {
      aggregate.failed = true;
    } else {
      aggregate.loaded = true;
    }
    addEvidence(aggregate.evidence, result.evidence);
    state.results.set(result.toolUseId, aggregate);
  }

  for (const call of parsed.calls) {
    const fallbackIdentity = call.toolUseId === null;
    let id: string;
    if (call.toolUseId) {
      id = stableHash(source.client, call.toolUseId);
    } else if (call.fallbackUuid) {
      id = stableHash(source.client, call.fallbackUuid, String(call.blockIndex));
    } else {
      continue;
    }
    let aggregate = state.events.get(id);
    if (!aggregate) {
      if (state.budget.events >= MAX_EVENTS) {
        state.budget.stopped = true;
        coverage.coverage.readLimited = true;
        pushIssue(
          state,
          issue(source.id, "limit", "History import event limit was reached.", call.evidence.file),
          coverage,
        );
        coverage.limitations.add("The history import stopped at the event limit.");
        break;
      }
      aggregate = {
        id,
        client: source.client,
        skillName: call.skillName,
        at: call.at,
        kind: "invocation",
        rawToolUseId: call.toolUseId,
        fallbackIdentity,
        sessionIdentities: new Set(),
        sessionMissing: call.sessionId === null,
        evidence: new Map(),
        conflict: false,
      };
      state.events.set(id, aggregate);
      state.budget.events += 1;
    } else if (
      aggregate.kind !== "invocation" ||
      aggregate.skillName !== call.skillName ||
      aggregate.at !== call.at
    ) {
      aggregate.conflict = true;
      if (!state.conflictIssues.has(id)) {
        state.conflictIssues.add(id);
        pushIssue(
          state,
          issue(
            source.id,
            "identity",
            "Conflicting copies of the same history event were kept unresolved.",
            call.evidence.file,
            call.evidence.line,
          ),
          coverage,
        );
      }
    }
    if (fallbackIdentity && !state.identityIssues.has(id)) {
      state.identityIssues.add(id);
      pushIssue(
        state,
        issue(
          source.id,
          "identity",
          "History invocation used a fallback identity and remains unresolved.",
          call.evidence.file,
          call.evidence.line,
        ),
        coverage,
      );
    }
    if (call.sessionId) {
      aggregate.sessionIdentities.add(`${call.sessionId}\0${call.agentId ?? ""}`);
    } else {
      aggregate.sessionMissing = true;
    }
    addEvidence(aggregate.evidence, call.evidence);
  }

  for (const request of parsed.requests) {
    const id = stableHash(source.client, "request", request.uuid, request.skillName);
    let aggregate = state.events.get(id);
    if (!aggregate) {
      if (state.budget.events >= MAX_EVENTS) {
        state.budget.stopped = true;
        coverage.coverage.readLimited = true;
        pushIssue(
          state,
          issue(
            source.id,
            "limit",
            "History import event limit was reached.",
            request.evidence.file,
          ),
          coverage,
        );
        coverage.limitations.add("The history import stopped at the event limit.");
        break;
      }
      aggregate = {
        id,
        client: source.client,
        skillName: request.skillName,
        at: request.at,
        kind: "request",
        rawToolUseId: null,
        fallbackIdentity: false,
        sessionIdentities: new Set(),
        sessionMissing: request.sessionId === null,
        evidence: new Map(),
        conflict: false,
      };
      state.events.set(id, aggregate);
      state.budget.events += 1;
    } else if (
      aggregate.kind !== "request" ||
      aggregate.skillName !== request.skillName ||
      aggregate.at !== request.at
    ) {
      aggregate.conflict = true;
    }
    if (request.sessionId) {
      aggregate.sessionIdentities.add(`${request.sessionId}\0${request.agentId ?? ""}`);
    } else {
      aggregate.sessionMissing = true;
    }
    addEvidence(aggregate.evidence, request.evidence);
  }
}

async function walkHistory(
  state: ImportState,
  source: HistorySource,
  coverage: CoverageState,
  logicalDirectory: string,
  depth: number,
): Promise<void> {
  throwIfAborted(state.options.signal);
  if (state.budget.stopped) {
    return;
  }
  let directory: Dir;
  try {
    const resolvedDirectory = await realpath(logicalDirectory);
    if (!coverage.rootRealPath || !isWithin(resolvedDirectory, coverage.rootRealPath)) {
      coverage.coverage.readLimited = true;
      pushIssue(
        state,
        issue(
          source.id,
          "link",
          "History directory resolves outside the authorized root.",
          portableRelative(coverage.rootAbsolutePath, logicalDirectory),
        ),
        coverage,
      );
      return;
    }
    directory = await opendir(logicalDirectory);
  } catch {
    coverage.coverage.readLimited = true;
    pushIssue(
      state,
      issue(
        source.id,
        "unreadable",
        "History directory could not be read.",
        portableRelative(coverage.rootAbsolutePath, logicalDirectory),
      ),
      coverage,
    );
    return;
  }

  try {
    for await (const entry of directory) {
      throwIfAborted(state.options.signal);
      if (state.budget.stopped) {
        break;
      }
      state.budget.entries += 1;
      if (state.budget.entries > MAX_DISCOVERED_ENTRIES) {
        state.budget.stopped = true;
        coverage.coverage.readLimited = true;
        pushIssue(
          state,
          issue(source.id, "limit", "History import discovery limit was reached."),
          coverage,
        );
        coverage.limitations.add("The history import stopped at the discovery limit.");
        break;
      }
      const child = resolve(logicalDirectory, entry.name);
      const childFile = portableRelative(coverage.rootAbsolutePath, child);
      let childStats: Stats;
      try {
        childStats = await lstat(child);
      } catch {
        coverage.coverage.readLimited = true;
        pushIssue(
          state,
          issue(source.id, "unreadable", "History entry could not be inspected.", childFile),
          coverage,
        );
        continue;
      }
      if (childStats.isSymbolicLink()) {
        coverage.coverage.readLimited = true;
        pushIssue(
          state,
          issue(
            source.id,
            "link",
            "Symbolic links are not followed while importing history.",
            childFile,
          ),
          coverage,
        );
        if (entry.name.endsWith(".jsonl")) {
          coverage.coverage.skippedFiles += 1;
        }
        continue;
      }
      if (childStats.isDirectory()) {
        if (depth >= MAX_DIRECTORY_DEPTH) {
          coverage.coverage.readLimited = true;
          pushIssue(
            state,
            issue(source.id, "limit", "History directory depth limit was reached.", childFile),
            coverage,
          );
          coverage.limitations.add("At least one deep history directory was skipped.");
          continue;
        }
        await walkHistory(state, source, coverage, child, depth + 1);
        continue;
      }
      if (!childStats.isFile() || !entry.name.endsWith(".jsonl")) {
        continue;
      }
      const read = await openAndReadFile(state, source, coverage, child);
      if (!read) {
        continue;
      }
      if (read.snapshot.grew) {
        coverage.coverage.readLimited = true;
        read.parsed.limitations.add(
          "A growing history file was imported only through its snapshot size.",
        );
      }
      mergeParsedFile(state, source, coverage, read.parsed);
    }
  } finally {
    await directory.close().catch(() => undefined);
  }
}

function coverageState(source: HistorySource, scannedAt: string, adapter = ADAPTER): CoverageState {
  return {
    coverage: {
      sourceId: source.id,
      adapter,
      status: "empty",
      scannedAt,
      readLimited: false,
      filesRead: 0,
      recordsRead: 0,
      malformedLines: 0,
      skippedFiles: 0,
      firstRecordAt: null,
      lastRecordAt: null,
      clientVersions: [],
      limitations: [],
    },
    limitations: new Set(adapter === ADAPTER ? INHERENT_LIMITATIONS : []),
    messageRecords: 0,
    firstRecordMs: null,
    lastRecordMs: null,
    rootRealPath: null,
    rootAbsolutePath: resolve(source.path),
    unreadable: false,
  };
}

async function scanClaudeSource(
  state: ImportState,
  source: HistorySource,
  scannedAt: string,
): Promise<HistoryCoverage> {
  const current = coverageState(source, scannedAt);
  throwIfAborted(state.options.signal);
  try {
    const rootStats = await lstat(current.rootAbsolutePath);
    const rootRealPath = await realpath(current.rootAbsolutePath);
    const canonicalStats = await stat(rootRealPath);
    if (
      (!rootStats.isDirectory() && !rootStats.isSymbolicLink()) ||
      !canonicalStats.isDirectory()
    ) {
      current.coverage.status = "unreadable";
      current.coverage.readLimited = true;
      pushIssue(
        state,
        issue(source.id, "unreadable", "History source is not a readable directory."),
        current,
      );
      current.coverage.limitations = [...current.limitations].sort();
      return current.coverage;
    }
    current.rootRealPath = rootRealPath;
  } catch {
    current.coverage.status = "unreadable";
    current.coverage.readLimited = true;
    pushIssue(state, issue(source.id, "unreadable", "History source could not be read."), current);
    current.coverage.limitations = [...current.limitations].sort();
    return current.coverage;
  }

  if (state.budget.stopped) {
    current.coverage.readLimited = true;
    current.limitations.add("The shared history import limit was already reached.");
    pushIssue(
      state,
      issue(source.id, "limit", "History source was skipped after a shared limit."),
      current,
    );
  } else {
    await walkHistory(state, source, current, current.rootAbsolutePath, 0);
  }

  current.coverage.clientVersions = [...new Set(current.coverage.clientVersions)].sort();
  if (current.coverage.filesRead === 0 && current.unreadable) {
    current.coverage.status = "unreadable";
  } else if (current.coverage.filesRead === 0) {
    current.coverage.status = "empty";
  } else if (current.coverage.recordsRead > 0 && current.messageRecords === 0) {
    current.coverage.status = "unsupported";
    current.coverage.readLimited = true;
    pushIssue(
      state,
      issue(source.id, "unsupported", "History format is not supported by this adapter."),
      current,
    );
    current.limitations.add("No supported Claude Code message records were recognized.");
  } else if (current.coverage.recordsRead === 0 && current.coverage.malformedLines > 0) {
    current.coverage.status = "unreadable";
  } else {
    current.coverage.status = "supported";
  }
  current.coverage.limitations = [...current.limitations].sort();
  return current.coverage;
}

function unsupportedCoverage(
  state: ImportState,
  source: HistorySource,
  scannedAt: string,
): HistoryCoverage {
  pushIssue(
    state,
    issue(source.id, "unsupported", "History client is not supported by this adapter."),
  );
  return {
    sourceId: source.id,
    adapter: UNSUPPORTED_ADAPTER,
    status: "unsupported",
    scannedAt,
    readLimited: true,
    filesRead: 0,
    recordsRead: 0,
    malformedLines: 0,
    skippedFiles: 0,
    firstRecordAt: null,
    lastRecordAt: null,
    clientVersions: [],
    limitations: ["No history adapter is available for this client."],
  };
}

function finalEvents(state: ImportState): UsageEvent[] {
  const events: UsageEvent[] = [];
  for (const aggregate of state.events.values()) {
    let status: UsageEvent["status"] = "unresolved";
    let resultConflict = false;
    if (aggregate.kind === "invocation" && !aggregate.fallbackIdentity && !aggregate.conflict) {
      const result = aggregate.rawToolUseId ? state.results.get(aggregate.rawToolUseId) : undefined;
      if (result) {
        for (const evidence of result.evidence.values()) {
          addEvidence(aggregate.evidence, evidence);
        }
        if (result.failed && result.loaded) {
          resultConflict = true;
          if (!state.conflictIssues.has(aggregate.id)) {
            state.conflictIssues.add(aggregate.id);
            const evidence = firstEvidence(aggregate.evidence);
            pushIssue(
              state,
              issue(
                evidence?.sourceId ?? "unknown",
                "identity",
                "Conflicting results for the same history event were kept unresolved.",
                evidence?.file,
                evidence?.line,
              ),
            );
          }
        } else if (result.failed) {
          status = "failed";
        } else if (result.loaded) {
          status = "loaded";
        }
      }
    }

    const sessionKey =
      aggregate.sessionMissing || aggregate.sessionIdentities.size !== 1
        ? null
        : stableHash(...aggregate.sessionIdentities);
    if (
      aggregate.sessionIdentities.size > 1 &&
      !state.conflictIssues.has(`session:${aggregate.id}`)
    ) {
      state.conflictIssues.add(`session:${aggregate.id}`);
      const evidence = firstEvidence(aggregate.evidence);
      pushIssue(
        state,
        issue(
          evidence?.sourceId ?? "unknown",
          "identity",
          "Copied history event has conflicting session identities.",
          evidence?.file,
          evidence?.line,
        ),
      );
    }
    const event: UsageEvent = {
      id: aggregate.id,
      client: aggregate.client,
      skillName: aggregate.skillName,
      sessionKey,
      at: aggregate.at,
      kind: aggregate.kind,
      status,
      evidence: [...aggregate.evidence.values()].sort(
        (left, right) =>
          left.sourceId.localeCompare(right.sourceId) ||
          left.file.localeCompare(right.file) ||
          left.line - right.line,
      ),
    };
    if (resultConflict) {
      event.resultConflict = true;
    }
    events.push(event);
  }
  return events.sort(
    (left, right) =>
      left.at.localeCompare(right.at) ||
      left.client.localeCompare(right.client) ||
      left.skillName.localeCompare(right.skillName) ||
      left.id.localeCompare(right.id),
  );
}

export async function importUsage(
  sources: HistorySource[],
  options: UsageImportOptions = {},
): Promise<UsageImport> {
  throwIfAborted(options.signal);
  const scannedAt = options.now ?? new Date().toISOString();
  const state: ImportState = {
    options,
    budget: { files: 0, bytes: 0, events: 0, records: 0, entries: 0, stopped: false },
    issues: [],
    events: new Map(),
    results: new Map(),
    conflictIssues: new Set(),
    identityIssues: new Set(),
    diagnosticLimitReached: false,
  };
  const coverage: HistoryCoverage[] = [];

  for (const source of sources) {
    throwIfAborted(options.signal);
    if (!source.enabled) {
      continue;
    }
    if (source.client !== "claude-code") {
      coverage.push(unsupportedCoverage(state, source, scannedAt));
      continue;
    }
    coverage.push(await scanClaudeSource(state, source, scannedAt));
  }

  const events = finalEvents(state);
  return { events, coverage, issues: state.issues };
}
