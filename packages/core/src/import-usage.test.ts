import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { importUsage, importUsageIncremental } from "./import-usage.ts";
import { isUsageImportCache } from "./usage-cache.ts";
import { createUsageState, mergeUsageImport } from "./usage-report.ts";
import type { HistorySource } from "./usage-types.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "koyori-usage-test-"));
  temporaryDirectories.push(path);
  return path;
}

function source(path: string, overrides: Partial<HistorySource> = {}): HistorySource {
  return {
    id: "history",
    rootId: "claude",
    client: "claude-code",
    path,
    label: "Synthetic Claude history",
    enabled: true,
    ...overrides,
  };
}

function skillCall(
  options: {
    id?: string;
    skill?: string;
    sessionId?: string;
    agentId?: string;
    timestamp?: string;
    uuid?: string;
    blockIndexPrefix?: boolean;
  } = {},
): Record<string, unknown> {
  const block: Record<string, unknown> = {
    type: "tool_use",
    name: "Skill",
    input: { skill: options.skill ?? "sample-skill", args: "must not escape" },
  };
  if (options.id !== undefined) {
    block.id = options.id;
  }
  const content = options.blockIndexPrefix ? [{ type: "text", text: "ignored" }, block] : [block];
  return {
    type: "assistant",
    uuid: options.uuid ?? "assistant-row",
    sessionId: options.sessionId ?? "session-a",
    ...(options.agentId ? { agentId: options.agentId, isSidechain: true } : {}),
    timestamp: options.timestamp ?? "2026-09-20T10:00:00.000Z",
    version: "2.1.278",
    message: { role: "assistant", content },
  };
}

function toolResult(
  id: string,
  options: { failed?: boolean; sessionId?: string; agentId?: string; timestamp?: string } = {},
): Record<string, unknown> {
  return {
    type: "user",
    uuid: `result-${id}`,
    sessionId: options.sessionId ?? "session-a",
    ...(options.agentId ? { agentId: options.agentId, isSidechain: true } : {}),
    timestamp: options.timestamp ?? "2026-09-20T10:00:01.000Z",
    version: "2.1.278",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: id,
          ...(options.failed === undefined ? {} : { is_error: options.failed }),
          content: "must not escape",
        },
      ],
    },
  };
}

function command(
  name: string,
  options: { uuid?: string; isMeta?: boolean; includeMessage?: boolean } = {},
): Record<string, unknown> {
  return {
    type: "user",
    uuid: options.uuid ?? `command-${name}`,
    sessionId: "session-command",
    timestamp: "2026-09-20T11:00:00.000Z",
    ...(options.isMeta ? { isMeta: true } : {}),
    message: {
      role: "user",
      content: `${options.includeMessage === false ? "" : `<command-message>${name}</command-message>\n`}<command-name>/${name}</command-name>\n<command-args>private body</command-args>`,
    },
  };
}

async function writeJsonl(
  root: string,
  relative: string,
  rows: Array<Record<string, unknown> | string>,
  terminate = true,
): Promise<string> {
  const path = join(root, relative);
  await mkdir(join(path, ".."), { recursive: true });
  const body = rows.map((row) => (typeof row === "string" ? row : JSON.stringify(row))).join("\n");
  await writeFile(path, terminate ? `${body}\n` : body, "utf8");
  return path;
}

describe("importUsage", () => {
  it("deduplicates copied invocations, links cross-file results, and drops conflicting sessions", async () => {
    const root = await temporaryDirectory();
    await writeJsonl(root, "first.jsonl", [
      skillCall({ id: "tool-copy", sessionId: "session-original", uuid: "same-row" }),
    ]);
    await writeJsonl(root, "fork/second.jsonl", [
      skillCall({ id: "tool-copy", sessionId: "session-fork", uuid: "same-row" }),
      toolResult("tool-copy", { sessionId: "session-fork" }),
    ]);

    const imported = await importUsage([source(root)], { now: "2026-09-22T00:00:00.000Z" });

    expect(imported.events).toHaveLength(1);
    expect(imported.events[0]).toEqual(
      expect.objectContaining({
        kind: "invocation",
        skillName: "sample-skill",
        status: "loaded",
        sessionKey: null,
      }),
    );
    expect(imported.events[0]?.evidence).toHaveLength(3);
    expect(imported.issues).toContainEqual(
      expect.objectContaining({ code: "identity", message: expect.stringContaining("session") }),
    );
    expect(imported.coverage[0]).toEqual(
      expect.objectContaining({
        status: "supported",
        readLimited: false,
        filesRead: 2,
        recordsRead: 3,
        firstRecordAt: "2026-09-20T10:00:00.000Z",
        lastRecordAt: "2026-09-20T10:00:01.000Z",
        clientVersions: ["2.1.278"],
      }),
    );
  });

  it("keeps subagent identity while distinguishing failed and unresolved calls", async () => {
    const root = await temporaryDirectory();
    await writeJsonl(root, "session/subagents/agent-a.jsonl", [
      skillCall({ id: "tool-failed", skill: "failed-skill", agentId: "agent-a" }),
      toolResult("tool-failed", { failed: true, agentId: "agent-a" }),
      skillCall({ id: "tool-pending", skill: "pending-skill", agentId: "agent-a" }),
      {
        ...skillCall({ id: "tool-orphan", skill: "orphan-sidechain" }),
        isSidechain: true,
      },
    ]);

    const imported = await importUsage([source(root)]);

    expect(imported.events).toHaveLength(3);
    expect(imported.events.find((event) => event.skillName === "failed-skill")).toEqual(
      expect.objectContaining({ status: "failed", sessionKey: expect.any(String) }),
    );
    expect(imported.events.find((event) => event.skillName === "pending-skill")).toEqual(
      expect.objectContaining({ status: "unresolved", sessionKey: expect.any(String) }),
    );
    expect(imported.events.find((event) => event.skillName === "orphan-sidechain")).toEqual(
      expect.objectContaining({ status: "unresolved", sessionKey: null }),
    );
  });

  it("keeps conflicting loaded and failed results unresolved", async () => {
    const root = await temporaryDirectory();
    await writeJsonl(root, "conflict.jsonl", [
      skillCall({ id: "tool-conflict", skill: "conflicted-skill" }),
      toolResult("tool-conflict", { failed: true }),
      toolResult("tool-conflict", { failed: false, timestamp: "2026-09-20T10:00:02.000Z" }),
    ]);

    const imported = await importUsage([source(root)]);

    expect(imported.events).toEqual([
      expect.objectContaining({
        skillName: "conflicted-skill",
        status: "unresolved",
        resultConflict: true,
      }),
    ]);
  });

  it("uses a fallback identity without treating it as a successful load", async () => {
    const root = await temporaryDirectory();
    await writeJsonl(root, "fallback.jsonl", [
      skillCall({ id: undefined, uuid: "fallback-row", blockIndexPrefix: true }),
    ]);

    const imported = await importUsage([source(root)]);

    expect(imported.events).toEqual([
      expect.objectContaining({ kind: "invocation", status: "unresolved" }),
    ]);
    expect(imported.issues).toContainEqual(
      expect.objectContaining({ code: "identity", message: expect.stringContaining("fallback") }),
    );
  });

  it("records strict command requests but ignores built-ins, meta injection, mentions, and reads", async () => {
    const root = await temporaryDirectory();
    await writeJsonl(root, "commands.jsonl", [
      command("custom-skill"),
      command("help"),
      command("meta-skill", { isMeta: true }),
      command("missing-envelope", { includeMessage: false }),
      {
        ...command("quoted-skill", { uuid: "quoted" }),
        message: {
          role: "user",
          content:
            "Example only: <command-message>quoted-skill</command-message><command-name>/quoted-skill</command-name>",
        },
      },
      {
        ...command("fenced-skill", { uuid: "fenced" }),
        message: {
          role: "user",
          content:
            "```\n<command-message>fenced-skill</command-message>\n<command-name>/fenced-skill</command-name>\n```",
        },
      },
      {
        type: "assistant",
        uuid: "mention-row",
        sessionId: "session-command",
        timestamp: "2026-09-20T11:01:00.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "custom-skill was mentioned" },
            { type: "tool_use", name: "Read", id: "read-1", input: { file_path: "SKILL.md" } },
          ],
        },
      },
    ]);

    const imported = await importUsage([source(root)]);

    expect(imported.events).toEqual([
      expect.objectContaining({
        skillName: "custom-skill",
        kind: "request",
        status: "unresolved",
      }),
    ]);
  });

  it("reports malformed and oversized records, continues after them, and ignores an incomplete tail", async () => {
    const root = await temporaryDirectory();
    const validCall = skillCall({ id: "tool-after-errors" });
    const validResult = toolResult("tool-after-errors");
    await writeJsonl(
      root,
      "bounded.jsonl",
      ["{bad-json}", "x".repeat(2 * 1024 * 1024 + 1), validCall, validResult, "{partial"],
      false,
    );

    const imported = await importUsage([source(root)]);

    expect(imported.events).toEqual([
      expect.objectContaining({ skillName: "sample-skill", status: "loaded" }),
    ]);
    expect(imported.coverage[0]?.malformedLines).toBe(1);
    expect(imported.coverage[0]?.readLimited).toBe(true);
    expect(imported.coverage[0]?.limitations).toEqual(
      expect.arrayContaining([
        "At least one oversized history record was skipped.",
        "An incomplete trailing history record was ignored.",
      ]),
    );
    expect(imported.issues.map((entry) => entry.code)).toEqual(
      expect.arrayContaining(["malformed", "limit"]),
    );
    expect(JSON.stringify(imported)).not.toContain("must not escape");
  });

  it("does not follow file or directory symlinks outside the selected root", async () => {
    const workspace = await temporaryDirectory();
    const root = join(workspace, "selected");
    const outside = join(workspace, "outside");
    await mkdir(root);
    await mkdir(outside);
    const outsideFile = await writeJsonl(outside, "private.jsonl", [
      skillCall({ id: "outside-call" }),
      toolResult("outside-call"),
    ]);
    await symlink(outsideFile, join(root, "file-link.jsonl"));
    await symlink(outside, join(root, "directory-link"));

    const before = await readFile(outsideFile, "utf8");
    const imported = await importUsage([source(root)]);
    const after = await readFile(outsideFile, "utf8");

    expect(imported.events).toEqual([]);
    expect(imported.issues.filter((entry) => entry.code === "link")).toHaveLength(2);
    expect(imported.coverage[0]?.readLimited).toBe(true);
    expect(after).toBe(before);
  });

  it("skips disabled sources and reports unsupported clients without claiming zero coverage", async () => {
    const root = await temporaryDirectory();
    const imported = await importUsage([
      source(join(root, "missing"), { id: "disabled", enabled: false }),
      source(root, { id: "codex", client: "codex" }),
    ]);

    expect(imported.events).toEqual([]);
    expect(imported.coverage).toEqual([
      expect.objectContaining({ sourceId: "codex", status: "unsupported" }),
    ]);
    expect(imported.issues).toEqual([
      expect.objectContaining({ sourceId: "codex", code: "unsupported" }),
    ]);
  });

  it("throws AbortError when cancelled", async () => {
    const root = await temporaryDirectory();
    const controller = new AbortController();
    controller.abort();

    await expect(importUsage([source(root)], { signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  it("bounds diagnostics from many malformed records", async () => {
    const root = await temporaryDirectory();
    await writeJsonl(
      root,
      "many-bad-lines.jsonl",
      Array.from({ length: 1_100 }, () => "{bad}"),
    );

    const imported = await importUsage([source(root)]);

    expect(imported.issues).toHaveLength(1_000);
    expect(imported.issues.at(-1)).toEqual(
      expect.objectContaining({
        code: "limit",
        message: "History import diagnostic limit was reached.",
      }),
    );
    expect(imported.coverage[0]).toEqual(
      expect.objectContaining({ readLimited: true, malformedLines: 1_000 }),
    );
  });
});

describe("importUsageIncremental", () => {
  it("reuses unchanged files while retaining their events and coverage", async () => {
    const root = await temporaryDirectory();
    await writeJsonl(root, "session.jsonl", [skillCall({ id: "cached-call" })]);

    const first = await importUsageIncremental([source(root)]);
    const second = await importUsageIncremental([source(root)], first.cache);

    expect(first.imported.events).toEqual([
      expect.objectContaining({ skillName: "sample-skill", status: "unresolved" }),
    ]);
    expect(second.imported.events).toEqual(first.imported.events);
    expect(second.imported.coverage[0]).toEqual(
      expect.objectContaining({ filesRead: 1, recordsRead: 1, cachedFiles: 1 }),
    );
    expect(isUsageImportCache(second.cache)).toBe(true);
    expect(JSON.stringify(second.cache)).not.toContain("must not escape");
  });

  it("reparses an append so a late tool result upgrades the cached invocation", async () => {
    const root = await temporaryDirectory();
    const path = await writeJsonl(root, "session.jsonl", [skillCall({ id: "late-result" })]);
    const first = await importUsageIncremental([source(root)]);

    await appendFile(path, `${JSON.stringify(toolResult("late-result"))}\n`, "utf8");
    const second = await importUsageIncremental([source(root)], first.cache);
    const third = await importUsageIncremental([source(root)], second.cache);

    expect(second.imported.events).toEqual([
      expect.objectContaining({ skillName: "sample-skill", status: "loaded" }),
    ]);
    expect(second.imported.coverage[0]).toEqual(expect.objectContaining({ recordsRead: 2 }));
    expect(second.imported.coverage[0]?.cachedFiles).toBeUndefined();
    expect(third.imported.events).toEqual(second.imported.events);
    expect(third.imported.coverage[0]).toEqual(expect.objectContaining({ cachedFiles: 1 }));
  });

  it("handles truncation and rotation without dropping earlier ledger events", async () => {
    const root = await temporaryDirectory();
    const path = await writeJsonl(root, "session.jsonl", [
      skillCall({ id: "before-rotate", skill: "older-skill" }),
      toolResult("before-rotate"),
    ]);
    const first = await importUsageIncremental([source(root)]);
    let ledger = mergeUsageImport(createUsageState(), first.imported, "2026-09-21T00:00:00.000Z");

    await writeJsonl(root, "session.jsonl", [
      skillCall({ id: "after-truncate", skill: "newer-skill" }),
    ]);
    const truncated = await importUsageIncremental([source(root)], first.cache);
    ledger = mergeUsageImport(ledger, truncated.imported, "2026-09-22T00:00:00.000Z");
    expect(ledger.events.map((event) => event.skillName).sort()).toEqual([
      "newer-skill",
      "older-skill",
    ]);

    await rename(path, join(root, "rotated.jsonl"));
    await writeJsonl(root, "session.jsonl", [
      skillCall({ id: "after-rotate", skill: "rotated-skill" }),
    ]);
    const rotated = await importUsageIncremental([source(root)], truncated.cache);
    ledger = mergeUsageImport(ledger, rotated.imported, "2026-09-23T00:00:00.000Z");
    expect(ledger.events.map((event) => event.skillName).sort()).toEqual([
      "newer-skill",
      "older-skill",
      "rotated-skill",
    ]);
  });

  it("replays cached malformed diagnostics without retaining line content", async () => {
    const root = await temporaryDirectory();
    await writeJsonl(root, "bad.jsonl", ["{private-bad-line}", skillCall({ id: "valid" })]);
    const first = await importUsageIncremental([source(root)]);
    const second = await importUsageIncremental([source(root)], first.cache);

    expect(second.imported.events).toHaveLength(1);
    expect(second.imported.issues).toEqual(first.imported.issues);
    expect(second.imported.coverage[0]).toEqual(
      expect.objectContaining({ malformedLines: 1, readLimited: true, cachedFiles: 1 }),
    );
    expect(JSON.stringify(second.cache)).not.toContain("private-bad-line");
  });

  it("does not mutate or replace the previous cache when cancelled", async () => {
    const root = await temporaryDirectory();
    await writeJsonl(root, "session.jsonl", [skillCall({ id: "cancelled" })]);
    const first = await importUsageIncremental([source(root)]);
    const before = JSON.stringify(first.cache);
    const controller = new AbortController();
    controller.abort();

    await expect(
      importUsageIncremental([source(root)], first.cache, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(JSON.stringify(first.cache)).toBe(before);
  });
});
