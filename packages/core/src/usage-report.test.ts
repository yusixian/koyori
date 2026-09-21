import { describe, expect, it } from "vitest";

import type { ClientId, SkillInventory, SkillRecord } from "./types.ts";
import {
  buildUsageReport,
  createUsageState,
  mergeUsageImport,
  observeSkills,
} from "./usage-report.ts";
import type {
  HistoryCoverage,
  HistorySource,
  UsageEvent,
  UsageImport,
  UsageState,
} from "./usage-types.ts";

const NOW = "2026-09-22T12:00:00.000Z";

function skill(
  id: string,
  name = id,
  rootId = "root",
  overrides: Partial<SkillRecord> = {},
): SkillRecord {
  return {
    id,
    name,
    description: `${name} fixture`,
    path: `/fixtures/${id}/SKILL.md`,
    rootId,
    client: "codex",
    content: `# ${name}`,
    contentTruncated: false,
    isSymlink: false,
    ...overrides,
  };
}

function inventory(skills: SkillRecord[]): SkillInventory {
  return { skills, issues: [], scannedAt: NOW };
}

function source(id: string, rootId = "root", client: ClientId = "codex"): HistorySource {
  return {
    id,
    rootId,
    client,
    path: `/history/${id}`,
    label: id,
    enabled: true,
  };
}

function coverage(sourceId: string, overrides: Partial<HistoryCoverage> = {}): HistoryCoverage {
  return {
    sourceId,
    adapter: "fixture-v1",
    status: "supported",
    scannedAt: NOW,
    filesRead: 2,
    recordsRead: 10,
    malformedLines: 0,
    skippedFiles: 0,
    readLimited: false,
    firstRecordAt: "2026-05-01T00:00:00.000Z",
    lastRecordAt: "2026-09-21T00:00:00.000Z",
    clientVersions: ["fixture"],
    limitations: [],
    ...overrides,
  };
}

function event(
  id: string,
  skillName: string,
  sourceId: string,
  overrides: Partial<UsageEvent> = {},
): UsageEvent {
  return {
    id,
    client: "codex",
    skillName,
    sessionKey: `session-${id}`,
    at: "2026-09-20T10:00:00.000Z",
    kind: "invocation",
    status: "loaded",
    evidence: [{ sourceId, file: `${sourceId}.jsonl`, line: 1 }],
    ...overrides,
  };
}

function batch(events: UsageEvent[]): UsageImport {
  return { events, coverage: [], issues: [] };
}

describe("usage ledger aggregation", () => {
  it("creates the documented conservative defaults", () => {
    expect(createUsageState()).toEqual({
      version: 1,
      sources: [],
      events: [],
      coverage: [],
      issues: [],
      preferences: {},
      rules: { idleDays: 90, lowUseThreshold: 2, graceDays: 30 },
      lastImportedAt: null,
      lastReviewedAt: null,
    });
  });

  it("deduplicates copied events across files and treats conflicting sessions as unknown", () => {
    const base: UsageState = {
      ...createUsageState(),
      sources: [source("history-a"), source("history-b")],
      coverage: [coverage("history-a"), coverage("history-b")],
    };
    const first = mergeUsageImport(
      base,
      batch([event("tool-1", "writer", "history-a", { sessionKey: "session-a" })]),
      "2026-09-21T00:00:00.000Z",
    );
    const merged = mergeUsageImport(
      first,
      batch([
        event("tool-1", "writer", "history-b", {
          sessionKey: "session-b",
          evidence: [{ sourceId: "history-b", file: "copy.jsonl", line: 8 }],
        }),
      ]),
      NOW,
    );

    expect(merged.events).toHaveLength(1);
    expect(merged.events[0]).toMatchObject({ id: "tool-1", sessionKey: null, status: "loaded" });
    expect(merged.events[0]?.evidence).toHaveLength(2);
    expect(merged.lastImportedAt).toBe(NOW);

    const report = buildUsageReport(inventory([skill("writer")]), merged, {
      now: NOW,
      windowDays: 30,
    });
    expect(report.totalEvents).toBe(1);
    expect(report.skills[0]).toMatchObject({ calls: 1, loaded: 1, sessions: 0 });
    expect(report.skills[0]?.notes.join(" ")).toContain("会话数只统计已知键，是下限");
  });

  it("keeps requests separate and preserves a real loaded-versus-failed conflict", () => {
    const base: UsageState = {
      ...createUsageState(),
      sources: [source("history")],
      coverage: [coverage("history")],
    };
    const failed = mergeUsageImport(
      base,
      batch([event("same", "reviewer", "history", { status: "failed" })]),
      NOW,
    );
    const merged = mergeUsageImport(
      failed,
      batch([
        event("same", "reviewer", "history", { status: "loaded" }),
        event("request", "reviewer", "history", {
          kind: "request",
          status: "unresolved",
        }),
      ]),
      NOW,
    );
    const reimported = mergeUsageImport(
      merged,
      batch([event("same", "reviewer", "history", { status: "loaded" })]),
      NOW,
    );

    expect(reimported.events.find((entry) => entry.id === "same")?.status).toBe("unresolved");
    expect(reimported.issues).toContainEqual(
      expect.objectContaining({ code: "identity", message: expect.stringContaining("unresolved") }),
    );
    const usage = buildUsageReport(inventory([skill("reviewer")]), reimported, {
      now: NOW,
      windowDays: 30,
    }).skills[0];
    expect(usage).toMatchObject({
      calls: 1,
      loaded: 0,
      failed: 0,
      unresolved: 1,
      requests: 1,
      sessions: 1,
    });
  });

  it("fills an unresolved result incrementally without letting weaker evidence erase it", () => {
    const unresolved = mergeUsageImport(
      createUsageState(),
      batch([event("incremental", "writer", "history", { status: "unresolved" })]),
      "2026-09-20T00:00:00.000Z",
    );
    const loaded = mergeUsageImport(
      unresolved,
      batch([event("incremental", "writer", "history", { status: "loaded" })]),
      "2026-09-21T00:00:00.000Z",
    );
    const weaker = mergeUsageImport(
      loaded,
      batch([event("incremental", "writer", "history", { status: "unresolved" })]),
      NOW,
    );

    expect(unresolved.events[0]?.status).toBe("unresolved");
    expect(loaded.events[0]?.status).toBe("loaded");
    expect(weaker.events[0]?.status).toBe("loaded");
  });

  it("preserves an importer-declared result conflict across later one-sided imports", () => {
    const conflicted = mergeUsageImport(
      createUsageState(),
      batch([
        event("importer-conflict", "writer", "history", {
          status: "unresolved",
          resultConflict: true,
        }),
      ]),
      "2026-09-21T00:00:00.000Z",
    );
    const reimported = mergeUsageImport(
      conflicted,
      batch([event("importer-conflict", "writer", "history", { status: "loaded" })]),
      NOW,
    );

    expect(reimported.events[0]).toMatchObject({
      status: "unresolved",
      resultConflict: true,
    });
  });

  it("does not assign a copied event when its exact name matches multiple linked roots", () => {
    const state: UsageState = {
      ...createUsageState(),
      sources: [source("source-a", "root-a"), source("source-b", "root-b")],
      coverage: [coverage("source-a"), coverage("source-b")],
      events: [
        event("shared-call", "shared", "source-a", {
          evidence: [
            { sourceId: "source-a", file: "a.jsonl", line: 1 },
            { sourceId: "source-b", file: "b.jsonl", line: 2 },
          ],
        }),
      ],
    };
    const report = buildUsageReport(
      inventory([skill("a", "shared", "root-a"), skill("b", "shared", "root-b")]),
      state,
      { now: NOW, windowDays: 30 },
    );

    expect(report.skills).toEqual([
      expect.objectContaining({ skillId: "a", status: "ambiguous", calls: 0 }),
      expect.objectContaining({ skillId: "b", status: "ambiguous", calls: 0 }),
    ]);
    expect(report.unattributed).toEqual([
      expect.objectContaining({
        skillName: "shared",
        reason: "ambiguous",
        calls: 1,
        loaded: 1,
      }),
    ]);
  });

  it("distinguishes selected-record zero from unsupported or null coverage", () => {
    const state: UsageState = {
      ...createUsageState(),
      sources: [
        source("readable", "zero-root"),
        source("unsupported", "unknown-root"),
        source("null-range", "null-root"),
      ],
      coverage: [
        coverage("readable"),
        coverage("unsupported", {
          status: "unsupported",
          firstRecordAt: null,
          lastRecordAt: null,
        }),
        coverage("null-range", { firstRecordAt: null, lastRecordAt: null }),
      ],
    };
    const report = buildUsageReport(
      inventory([
        skill("zero", "zero", "zero-root"),
        skill("unknown", "unknown", "unknown-root"),
        skill("null", "null", "null-root"),
      ]),
      state,
      { now: NOW, windowDays: 90 },
    );

    expect(report.skills[0]).toMatchObject({ status: "observed", calls: 0 });
    expect(report.skills[0]?.notes.join(" ")).toContain("所选可读记录");
    expect(report.skills[1]).toMatchObject({ status: "unknown", calls: 0 });
    expect(report.skills[2]).toMatchObject({ status: "unknown", calls: 0 });
  });

  it("preserves the first observation time without presenting it as installation time", () => {
    const resource = skill("observed");
    const first = observeSkills(createUsageState(), inventory([resource]), "2026-09-01T00:00:00Z");
    const second = observeSkills(first, inventory([resource]), NOW);

    expect(second.preferences.observed?.firstSeenAt).toBe("2026-09-01T00:00:00Z");
    expect(second.preferences.observed).toMatchObject({ keep: false, reviewAfter: null });
    expect(observeSkills(second, inventory([resource]), NOW)).toBe(second);
  });
});

describe("usage report rules", () => {
  it("protects kept and newly observed resources while reporting due, idle, low-use, and real duplicates", () => {
    const resources = [
      skill("kept"),
      skill("new"),
      skill("due"),
      skill("idle"),
      skill("low"),
      skill("duplicate-a", "duplicate-a", "root", {
        content: "identical complete content",
        realPath: "/real/a/SKILL.md",
      }),
      skill("duplicate-alias", "duplicate-alias", "root", {
        content: "identical complete content",
        realPath: "/real/a/SKILL.md",
        isSymlink: true,
      }),
      skill("duplicate-b", "duplicate-b", "root", {
        content: "identical complete content",
        realPath: "/real/b/SKILL.md",
      }),
    ];
    const old = "2026-05-01T00:00:00.000Z";
    const state: UsageState = {
      ...createUsageState(),
      sources: [source("history")],
      coverage: [coverage("history")],
      events: [event("low-call", "low", "history")],
      preferences: Object.fromEntries(
        resources.map((resource) => [
          resource.id,
          {
            keep: resource.id === "kept",
            reviewAfter: resource.id === "due" ? "2026-09-01T00:00:00.000Z" : null,
            firstSeenAt: resource.id === "new" ? "2026-09-15T00:00:00.000Z" : old,
          },
        ]),
      ),
    };

    const suggestions = buildUsageReport(inventory(resources), state, {
      now: NOW,
      windowDays: 90,
    }).suggestions;

    expect(suggestions).toContainEqual(
      expect.objectContaining({ kind: "review-due", skillIds: ["due"] }),
    );
    expect(suggestions).toContainEqual(
      expect.objectContaining({ kind: "idle-review", skillIds: ["idle"] }),
    );
    expect(suggestions).toContainEqual(
      expect.objectContaining({ kind: "low-use", skillIds: ["low"] }),
    );
    expect(suggestions).toContainEqual(
      expect.objectContaining({
        kind: "identical-content",
        skillIds: ["duplicate-a", "duplicate-b"],
      }),
    );
    expect(suggestions.some((entry) => entry.skillIds.includes("kept"))).toBe(false);
    expect(suggestions.some((entry) => entry.skillIds.includes("new"))).toBe(false);
    const identical = suggestions.find((entry) => entry.kind === "identical-content");
    expect(identical?.skillIds).not.toContain("duplicate-alias");
    for (const suggestion of suggestions) {
      expect(suggestion.cautions.join(" ")).toContain("不代表");
      expect(suggestion.cautions.join(" ")).toContain("不是安装日期");
      expect(suggestion.cautions.join(" ")).toContain("不会执行");
    }
  });

  it("does not issue idle or low-use suggestions for short coverage or ambiguous evidence", () => {
    const short = skill("short", "short", "short-root");
    const ambiguousA = skill("ambiguous-a", "same", "a-root");
    const ambiguousB = skill("ambiguous-b", "same", "b-root");
    const state: UsageState = {
      ...createUsageState(),
      sources: [
        source("short-history", "short-root"),
        source("a-history", "a-root"),
        source("b-history", "b-root"),
      ],
      coverage: [
        coverage("short-history", {
          firstRecordAt: "2026-09-01T00:00:00.000Z",
          lastRecordAt: "2026-09-20T00:00:00.000Z",
        }),
        coverage("a-history"),
        coverage("b-history"),
      ],
      events: [
        event("ambiguous", "same", "a-history", {
          evidence: [
            { sourceId: "a-history", file: "a.jsonl", line: 1 },
            { sourceId: "b-history", file: "b.jsonl", line: 1 },
          ],
        }),
      ],
      preferences: {
        short: { keep: false, reviewAfter: null, firstSeenAt: "2026-05-01T00:00:00Z" },
        "ambiguous-a": { keep: false, reviewAfter: null, firstSeenAt: "2026-05-01T00:00:00Z" },
        "ambiguous-b": { keep: false, reviewAfter: null, firstSeenAt: "2026-05-01T00:00:00Z" },
      },
    };
    const suggestions = buildUsageReport(inventory([short, ambiguousA, ambiguousB]), state, {
      now: NOW,
      windowDays: 90,
    }).suggestions;

    expect(
      suggestions.filter((entry) => entry.kind === "idle-review" || entry.kind === "low-use"),
    ).toEqual([]);
  });

  it.each([
    {
      firstRecordAt: "2024-01-01T00:00:00.000Z",
      lastRecordAt: "2024-06-01T00:00:00.000Z",
      idleDays: 90,
    },
    {
      firstRecordAt: new Date(Date.parse(NOW) - 90 * 86400000).toISOString(),
      lastRecordAt: "2026-09-21T12:00:00.000Z",
      idleDays: 90,
    },
    {
      firstRecordAt: "2026-05-01T00:00:00.000Z",
      lastRecordAt: "2026-09-20T12:00:00.000Z",
      idleDays: 1,
    },
  ])(
    "rejects stale or shorter-than-requested coverage: $idleDays days, $lastRecordAt",
    ({ firstRecordAt, lastRecordAt, idleDays }) => {
      const oldHistory = skill("old-history");
      const state: UsageState = {
        ...createUsageState(),
        sources: [source("history")],
        coverage: [
          coverage("history", {
            firstRecordAt,
            lastRecordAt,
          }),
        ],
        rules: { idleDays, lowUseThreshold: 2, graceDays: 30 },
        preferences: {
          "old-history": {
            keep: false,
            reviewAfter: null,
            firstSeenAt: "2026-05-01T00:00:00.000Z",
          },
        },
      };

      const suggestions = buildUsageReport(inventory([oldHistory]), state, {
        now: NOW,
        windowDays: 90,
      }).suggestions;

      expect(
        suggestions.filter((entry) => entry.kind === "idle-review" || entry.kind === "low-use"),
      ).toEqual([]);
    },
  );

  it("lets a newer complete scan recover from an older limited coverage result", () => {
    const resource = skill("recoverable");
    const limited: UsageState = {
      ...createUsageState(),
      sources: [source("history")],
      coverage: [
        coverage("history", {
          scannedAt: "2026-09-20T00:00:00.000Z",
          readLimited: true,
          limitations: ["The history import stopped at the file limit."],
        }),
      ],
      issues: [
        {
          sourceId: "history",
          code: "limit",
          message: "An older scan reached its file limit.",
        },
      ],
      preferences: {
        recoverable: {
          keep: false,
          reviewAfter: null,
          firstSeenAt: "2026-05-01T00:00:00.000Z",
        },
      },
    };
    const refreshed = mergeUsageImport(
      limited,
      { events: [], coverage: [coverage("history")], issues: [] },
      NOW,
    );

    const suggestions = buildUsageReport(inventory([resource]), refreshed, {
      now: NOW,
      windowDays: 90,
    }).suggestions;

    expect(refreshed.issues).toContainEqual(expect.objectContaining({ code: "limit" }));
    expect(refreshed.coverage[0]?.readLimited).toBe(false);
    expect(suggestions).toContainEqual(
      expect.objectContaining({ kind: "idle-review", skillIds: ["recoverable"] }),
    );
  });

  it("keeps only the ten newest evidence records", () => {
    const usageEvents = Array.from({ length: 12 }, (_, index) =>
      event(`event-${index}`, "bounded", "history", {
        at: `2026-09-${String(index + 1).padStart(2, "0")}T10:00:00.000Z`,
      }),
    );
    const state: UsageState = {
      ...createUsageState(),
      sources: [source("history")],
      coverage: [coverage("history")],
      events: usageEvents,
    };
    const usage = buildUsageReport(inventory([skill("bounded")]), state, {
      now: NOW,
      windowDays: 30,
    }).skills[0];

    expect(usage?.evidence).toHaveLength(10);
    expect(usage?.evidence.map((entry) => entry.id)).toEqual([
      "event-11",
      "event-10",
      "event-9",
      "event-8",
      "event-7",
      "event-6",
      "event-5",
      "event-4",
      "event-3",
      "event-2",
    ]);
  });
});
