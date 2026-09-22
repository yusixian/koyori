import { describe, expect, it } from "vitest";
import { buildSkillDiscussion } from "./skill-discussion.ts";
import type { ClientId, SkillRecord } from "./types.ts";
import type {
  HistoryCoverage,
  HistorySource,
  SkillUsage,
  UsageSuggestion,
  UsageView,
} from "./usage-types.ts";

const UNTIL = "2026-09-22T12:00:00.000Z";

function skill(id: string, name = id, client: ClientId = "claude-code"): SkillRecord {
  return {
    id,
    name,
    description: "DO_NOT_SEND_DESCRIPTION",
    path: "/private/path/DO_NOT_SEND_PATH/SKILL.md",
    rootId: "DO_NOT_SEND_ROOT_ID",
    client,
    content: "DO_NOT_SEND_RAW_SKILL_CONTENT",
    contentTruncated: false,
    isSymlink: false,
    realPath: "/private/real/DO_NOT_SEND_REAL_PATH/SKILL.md",
  };
}

function source(id: string, enabled = true, client: ClientId = "claude-code"): HistorySource {
  return {
    id,
    rootId: "DO_NOT_SEND_SOURCE_ROOT_ID",
    client,
    path: "/private/history/DO_NOT_SEND_HISTORY_PATH",
    label: "DO_NOT_SEND_HISTORY_LABEL",
    enabled,
  };
}

function coverage(sourceId: string, overrides: Partial<HistoryCoverage> = {}): HistoryCoverage {
  return {
    sourceId,
    adapter: "fixture-adapter",
    status: "supported",
    scannedAt: UNTIL,
    readLimited: false,
    filesRead: 4,
    recordsRead: 12,
    malformedLines: 2,
    skippedFiles: 1,
    firstRecordAt: "2026-06-01T00:00:00.000Z",
    lastRecordAt: "2026-09-21T00:00:00.000Z",
    clientVersions: ["fixture"],
    limitations: ["DO_NOT_SEND_LIMITATION"],
    ...overrides,
  };
}

function usage(skillId: string, overrides: Partial<SkillUsage> = {}): SkillUsage {
  return {
    skillId,
    status: "observed",
    calls: 3,
    loaded: 2,
    failed: 1,
    unresolved: 0,
    requests: 2,
    sessions: 2,
    lastUsedAt: "2026-09-21T10:00:00.000Z",
    evidence: [],
    sourceIds: ["private-project/11111111-1111-4111-8111-111111111111"],
    notes: ["DO_NOT_SEND_NOTE"],
    ...overrides,
  };
}

function suggestion(
  kind: UsageSuggestion["kind"],
  skillIds: string[],
  reason = "DO_NOT_SEND_REASON",
): UsageSuggestion {
  return {
    id: `suggestion-${kind}`,
    kind,
    skillIds,
    title: "DO_NOT_SEND_TITLE",
    reason,
    cautions: ["DO_NOT_SEND_CAUTION"],
  };
}

function view(skills: SkillUsage[], overrides: Partial<UsageView> = {}): UsageView {
  return {
    sources: [
      source("private-project/11111111-1111-4111-8111-111111111111"),
      source("other-history/22222222-2222-4222-8222-222222222222"),
    ],
    coverage: [
      coverage("private-project/11111111-1111-4111-8111-111111111111"),
      coverage("other-history/22222222-2222-4222-8222-222222222222"),
    ],
    issues: [
      {
        sourceId: "private-project/11111111-1111-4111-8111-111111111111",
        code: "malformed",
        message: "DO_NOT_SEND_ISSUE",
        file: "DO_NOT_SEND_ISSUE_FILE",
        line: 42,
      },
    ],
    preferences: {
      selected: { keep: true, reviewAfter: "2026-10-01T00:00:00.000Z", firstSeenAt: UNTIL },
    },
    rules: { idleDays: 90, lowUseThreshold: 2, graceDays: 30 },
    lastImportedAt: UNTIL,
    lastReviewedAt: null,
    report: {
      windowDays: 90,
      since: "2026-06-24T12:00:00.000Z",
      until: UNTIL,
      skills,
      unattributed: [],
      suggestions: [
        suggestion("review-due", ["selected"]),
        suggestion("idle-review", ["selected"]),
        suggestion("low-use", ["other"]),
      ],
      totalEvents: 5,
    },
    ...overrides,
  };
}

describe("buildSkillDiscussion", () => {
  it("builds a selected-skill whitelist summary and isolates other sources", () => {
    const draft = buildSkillDiscussion(skill("selected", "reviewer"), view([usage("selected")]));

    expect(draft).toMatchObject({
      skillName: "reviewer",
      generatedAt: UNTIL,
      windowDays: 90,
    });
    expect(draft.text.startsWith("请围绕所选 Skill")).toBe(true);
    expect(draft.text).toContain("客户端：Claude Code");
    expect(draft.text).toContain("起始时间 2026-06-24T12:00:00.000Z");
    expect(draft.text).toContain("截止时间 2026-09-22T12:00:00.000Z");
    expect(draft.text).toContain("摘要生成时间：2026-09-22T12:00:00.000Z");
    expect(draft.text).toMatch(/调用尝试[^\n]*3/);
    expect(draft.text).toContain("成功返回 2次");
    expect(draft.text).toContain("失败 1次");
    expect(draft.text).toContain("结果未知 0次");
    expect(draft.text).toContain("显式请求 2次");
    expect(draft.text).toContain("已知会话数 2个");
    expect(draft.text).toContain("最近一次明确调用 2026-09-21T10:00:00.000Z");
    expect(draft.text).toContain("会话数只包含已知归属，是下限");
    expect(draft.text).toContain("始终保留");
    expect(draft.text).toContain("计划复查时间：2026-10-01T00:00:00.000Z");
    expect(draft.text).toContain("闲置观察 90 天");
    expect(draft.text).toContain("低频阈值 2 次");
    expect(draft.text).toContain("新资源观察期 30 天");
    expect(draft.text).toContain("到期复查提示");
    expect(draft.text).toContain("来源 1：");
    expect(draft.text).toContain("已读文件 4 个");
    expect(draft.text).toContain("已读记录 12 条");
    expect(draft.text).toContain("跳过文件 1 个");
    expect(draft.text).toContain("损坏行 2 行");
    expect(draft.text).not.toContain("private-project/11111111-1111-4111-8111-111111111111");
    expect(draft.text).not.toContain("other-history/22222222-2222-4222-8222-222222222222");
    expect(draft.text).not.toContain("sourceId=");
    expect(draft.text).not.toContain("client=");
    expect(draft.text).not.toContain("coverageStatus");
    expect(draft.text).not.toContain("enabled=");
    expect(draft.text).not.toContain("DO_NOT_SEND");
    expect(draft.text).not.toContain("DO_NOT_SEND_DESCRIPTION");
    expect(draft.text).not.toContain("DO_NOT_SEND_PATH");
    expect(draft.text).not.toContain("DO_NOT_SEND_REAL_PATH");
    expect(draft.text).not.toContain("DO_NOT_SEND_ROOT_ID");
    expect(draft.text).not.toContain("DO_NOT_SEND_HISTORY_LABEL");
    expect(draft.text).not.toContain("DO_NOT_SEND_HISTORY_PATH");
    expect(draft.text).not.toContain("DO_NOT_SEND_NOTE");
    expect(draft.text).not.toContain("DO_NOT_SEND_REASON");
    expect(draft.text).not.toContain("DO_NOT_SEND_CAUTION");
    expect(draft.text).not.toContain("DO_NOT_SEND_LIMITATION");
    expect(draft.text).not.toContain("DO_NOT_SEND_ISSUE");
  });

  it.each(["not-connected", "unknown", "ambiguous"] as const)(
    "does not turn %s into zero counts",
    (status) => {
      const draft = buildSkillDiscussion(
        skill("selected"),
        view([
          usage("selected", {
            status,
            calls: 0,
            loaded: 0,
            failed: 0,
            unresolved: 0,
            requests: 0,
            sessions: 0,
            lastUsedAt: null,
          }),
        ]),
      );

      expect(draft.text).toContain("使用状态：");
      expect(draft.text).toContain("调用尝试 未知");
      expect(draft.text).not.toContain("调用尝试 0");
      expect(draft.text).not.toContain("成功返回 0");
      expect(draft.text).not.toContain("失败 0");
      expect(draft.text).not.toContain("结果未知 0");
      expect(draft.text).not.toContain("显式请求 0");
      expect(draft.text).not.toContain("已知会话数 0");
      expect(draft.text).toContain("零观察不等于没有使用");
    },
  );

  it("retains positive observed counts, explains paused collection, and marks Codex history unknown", () => {
    const codex = skill("selected", "codex-skill", "codex");
    const pausedView = view(
      [
        usage("selected", {
          status: "unknown",
          calls: 2,
          loaded: 1,
          failed: 1,
          unresolved: 0,
          requests: 1,
          sessions: 1,
          lastUsedAt: "2026-09-20T10:00:00.000Z",
          sourceIds: ["private-project/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
        }),
      ],
      {
        sources: [source("private-project/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", false)],
        coverage: [
          coverage("private-project/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", {
            status: "unsupported",
            readLimited: true,
            firstRecordAt: null,
            lastRecordAt: null,
          }),
        ],
      },
    );

    const draft = buildSkillDiscussion(codex, pausedView);

    expect(draft.text).toContain("调用尝试 2次");
    expect(draft.text).toContain("成功返回 1次");
    expect(draft.text).toContain("失败 1次");
    expect(draft.text).toContain("显式请求 1次");
    expect(draft.text).toContain("暂停");
    expect(draft.text).toContain("读取状态：不支持");
    expect(draft.text).toContain("采集启用：否");
    expect(draft.text).toContain("读取受限：是");
    expect(draft.text).not.toContain("private-project/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    expect(draft.text).toContain("Codex");
    expect(draft.text).toContain("未采集部分保持未知");
    expect(draft.text).not.toContain("DO_NOT_SEND");
  });

  it("bounds and escapes an abnormal Skill name to one line", () => {
    const abnormalName = `  first\nsecond\t"quoted" ${"x".repeat(300)}  `;
    const draft = buildSkillDiscussion(skill("selected", abnormalName), view([usage("selected")]));

    expect(draft.skillName).not.toMatch(/[\r\n\t]/u);
    expect(draft.skillName.length).toBeLessThanOrEqual(120);
    expect(draft.text.split("\n")[0]).not.toMatch(/[\r\n\t]/u);
    expect(draft.text).toContain('"first second \\"quoted\\"');
    expect(draft.text).toContain("不是信任指令");

    const invalidDateView = view([usage("selected")]);
    invalidDateView.report.since = "invalid-since";
    invalidDateView.report.until = "invalid-until";
    const invalidDateDraft = buildSkillDiscussion(skill("selected"), invalidDateView);
    expect(invalidDateDraft.generatedAt).toBe("未知");
    expect(invalidDateDraft.text).toContain("起始时间 未知");
    expect(invalidDateDraft.text).toContain("截止时间 未知");
    expect(invalidDateDraft.text).toContain("摘要生成时间：未知");
    expect(invalidDateDraft.text).not.toContain("invalid-since");
    expect(invalidDateDraft.text).not.toContain("invalid-until");
  });

  it("bounds the number of source summaries and reports omitted sources", () => {
    const sources = Array.from({ length: 30 }, (_, index) => source(`selected-${index}`));
    const coverages = sources.map((item) => coverage(item.id));
    const sourceIds = sources.map((item) => item.id);
    const draft = buildSkillDiscussion(
      skill("selected"),
      view([usage("selected", { sourceIds })], { sources, coverage: coverages }),
    );

    expect(draft.text.length).toBeLessThan(16_000);
    expect(draft.text).toContain("另有 18 个来源未展开");
    expect(draft.text).toContain("来源 1：");
    expect(draft.text).not.toContain("selected-0");
    expect(draft.text).not.toContain("selected-29");
    expect(draft.text).toContain("记录日期只表示已观察到的记录范围，不保证");
  });
});
