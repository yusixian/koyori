import type { SkillInventory, SkillRecord } from "./types.ts";
import type {
  HistoryCoverage,
  HistorySource,
  SkillUsage,
  UnattributedUsage,
  UsageCounts,
  UsageEvent,
  UsageImport,
  UsageIssue,
  UsageReport,
  UsageState,
  UsageSuggestion,
} from "./usage-types.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const EVIDENCE_LIMIT = 10;
const COVERAGE_FRESHNESS_DAYS = 7;
const RESULT_CONFLICT_MARKER = "存在 loaded 与 failed 结果冲突";

type ReportOptions = {
  now: string;
  windowDays: 30 | 90;
};

type Attribution =
  | { kind: "skill"; skillId: string }
  | { kind: "unattributed"; reason: "not-found" | "ambiguous"; candidateIds: string[] };

export function createUsageState(): UsageState {
  return {
    version: 1,
    sources: [],
    events: [],
    coverage: [],
    issues: [],
    preferences: {},
    rules: {
      idleDays: 90,
      lowUseThreshold: 2,
      graceDays: 30,
    },
    lastImportedAt: null,
    lastReviewedAt: null,
  };
}

export function mergeUsageImport(state: UsageState, batch: UsageImport, now: string): UsageState {
  const eventsById = new Map(state.events.map((event) => [event.id, cloneEvent(event)]));
  const mergeIssues: UsageIssue[] = [];

  for (const event of batch.events) {
    const existing = eventsById.get(event.id);
    if (!existing) {
      const cloned = cloneEvent(event);
      if (cloned.resultConflict === true) cloned.status = "unresolved";
      eventsById.set(event.id, cloned);
      continue;
    }

    const statusConflict =
      (existing.status === "loaded" && event.status === "failed") ||
      (existing.status === "failed" && event.status === "loaded");
    const resultConflict =
      existing.resultConflict === true || event.resultConflict === true || statusConflict;
    const sessionConflict =
      existing.sessionKey !== event.sessionKey &&
      existing.sessionKey !== null &&
      event.sessionKey !== null;
    const identityConflict =
      existing.client !== event.client ||
      existing.skillName !== event.skillName ||
      existing.kind !== event.kind ||
      existing.at !== event.at;

    eventsById.set(event.id, {
      ...existing,
      at: earlierIso(existing.at, event.at),
      sessionKey: existing.sessionKey === event.sessionKey ? existing.sessionKey : null,
      status: mergeEventStatus(existing.status, event.status, resultConflict),
      resultConflict: resultConflict || undefined,
      evidence: mergeEvidence(existing.evidence, event.evidence),
    });

    if (statusConflict || sessionConflict || identityConflict) {
      mergeIssues.push({
        sourceId: existing.evidence[0]?.sourceId ?? event.evidence[0]?.sourceId ?? "usage-ledger",
        code: "identity",
        message: describeMergeConflict(event.id, {
          identity: identityConflict,
          session: sessionConflict,
          status: statusConflict,
        }),
      });
    }
  }

  const coverageBySource = new Map(
    state.coverage.map((entry) => [entry.sourceId, cloneCoverage(entry)]),
  );
  for (const incoming of batch.coverage) {
    const existing = coverageBySource.get(incoming.sourceId);
    if (!existing || compareIso(incoming.scannedAt, existing.scannedAt) > 0) {
      coverageBySource.set(incoming.sourceId, cloneCoverage(incoming));
      continue;
    }
    if (compareIso(incoming.scannedAt, existing.scannedAt) === 0) {
      coverageBySource.set(incoming.sourceId, mergeSameScanCoverage(existing, incoming));
    }
  }

  return {
    ...state,
    sources: state.sources.map((source) => ({ ...source })),
    events: [...eventsById.values()],
    coverage: [...coverageBySource.values()],
    issues: deduplicateIssues([...state.issues, ...batch.issues, ...mergeIssues]),
    preferences: Object.fromEntries(
      Object.entries(state.preferences).map(([id, preference]) => [id, { ...preference }]),
    ),
    rules: { ...state.rules },
    lastImportedAt: now,
  };
}

export function observeSkills(
  state: UsageState,
  inventory: SkillInventory,
  now: string,
): UsageState {
  let preferences: UsageState["preferences"] | undefined;

  for (const skill of inventory.skills) {
    if (state.preferences[skill.id]) continue;
    preferences ??= { ...state.preferences };
    preferences[skill.id] = {
      keep: false,
      reviewAfter: null,
      firstSeenAt: now,
    };
  }

  if (!preferences) return state;
  return {
    ...state,
    preferences,
  };
}

export function buildUsageReport(
  inventory: SkillInventory,
  state: UsageState,
  options: ReportOptions,
): UsageReport {
  const nowMs = requireDate(options.now, "now");
  const sinceMs = nowMs - options.windowDays * DAY_MS;
  const since = new Date(sinceMs).toISOString();
  const until = new Date(nowMs).toISOString();
  const skillsById = new Map(inventory.skills.map((skill) => [skill.id, skill]));
  const sourcesById = new Map(state.sources.map((source) => [source.id, source]));
  const attributionByEvent = new Map<string, Attribution>();

  for (const event of state.events) {
    attributionByEvent.set(event.id, attributeEvent(event, inventory.skills, sourcesById));
  }

  const windowEvents = state.events.filter((event) => isWithin(event.at, sinceMs, nowMs));
  const attributedWindowEvents = new Map<string, UsageEvent[]>();
  const ambiguousSkillIds = new Set<string>();
  const unattributedEvents = new Map<
    string,
    { event: UsageEvent; reason: "not-found" | "ambiguous" }[]
  >();

  for (const event of windowEvents) {
    const attribution = attributionByEvent.get(event.id);
    if (!attribution || attribution.kind === "unattributed") {
      const reason = attribution?.reason ?? "not-found";
      if (attribution?.reason === "ambiguous") {
        for (const skillId of attribution.candidateIds) ambiguousSkillIds.add(skillId);
      }
      const key = `${event.client}\u0000${event.skillName}\u0000${reason}`;
      const entries = unattributedEvents.get(key) ?? [];
      entries.push({ event, reason });
      unattributedEvents.set(key, entries);
      continue;
    }
    const entries = attributedWindowEvents.get(attribution.skillId) ?? [];
    entries.push(event);
    attributedWindowEvents.set(attribution.skillId, entries);
  }

  const skills = inventory.skills.map((skill) => {
    const events = attributedWindowEvents.get(skill.id) ?? [];
    return buildSkillUsage(skill, events, ambiguousSkillIds.has(skill.id), state, sinceMs, nowMs);
  });

  const unattributed = [...unattributedEvents.values()]
    .map((entries): UnattributedUsage => {
      const first = entries[0];
      if (!first) throw new Error("Unattributed usage group cannot be empty");
      return {
        skillName: first.event.skillName,
        client: first.event.client,
        reason: first.reason,
        ...countEvents(entries.map((entry) => entry.event)),
      };
    })
    .sort(compareUnattributed);

  return {
    windowDays: options.windowDays,
    since,
    until,
    skills,
    unattributed,
    suggestions: buildSuggestions(inventory.skills, skillsById, state, attributionByEvent, nowMs),
    totalEvents: windowEvents.length,
  };
}

function buildSkillUsage(
  skill: SkillRecord,
  events: UsageEvent[],
  ambiguous: boolean,
  state: UsageState,
  sinceMs: number,
  nowMs: number,
): SkillUsage {
  const relatedSources = sourcesForSkill(state.sources, skill);
  const enabledSources = relatedSources.filter((source) => source.enabled);
  const counts = countEvents(events);
  const relevantCoverage = enabledSources
    .map((source) => state.coverage.find((entry) => entry.sourceId === source.id))
    .filter((entry): entry is HistoryCoverage => entry !== undefined);
  const hasReadableRecords = relevantCoverage.some((entry) =>
    coverageOverlaps(entry, sinceMs, nowMs),
  );
  const status: SkillUsage["status"] = ambiguous
    ? "ambiguous"
    : events.length > 0
      ? "observed"
      : enabledSources.length === 0
        ? "not-connected"
        : hasReadableRecords
          ? "observed"
          : "unknown";
  const notes = ["统计仅覆盖已选择且可读取的记录，不代表客户端、设备或时间范围内的完整使用历史。"];

  if (status === "not-connected") {
    notes.push("当前资源没有已连接的历史来源，不能把缺少证据解释为零次使用。");
  } else if (status === "unknown") {
    notes.push("所选来源没有可用于该窗口的受支持记录范围，使用次数未知。");
  } else if (status === "ambiguous") {
    notes.push("同一证据可关联到多个当前资源，未把次数分配给任何一个同名资源。");
  } else if (events.length === 0) {
    notes.push("零次仅表示所选可读记录中未找到调用，不表示完整历史中从未使用。");
  }

  const unknownSessions = events.filter(
    (event) => event.kind === "invocation" && event.sessionKey === null,
  ).length;
  if (unknownSessions > 0) {
    notes.push(`${unknownSessions} 次调用缺少可确认的会话归属；会话数只统计已知键，是下限。`);
  }
  if (state.preferences[skill.id]) {
    notes.push("首次观察日期仅表示 Koyori 首次发现该资源，不是安装日期。");
  }

  return {
    skillId: skill.id,
    status,
    ...counts,
    evidence: [...events].sort(compareEventsNewestFirst).slice(0, EVIDENCE_LIMIT),
    sourceIds: relatedSources.map((source) => source.id).sort(),
    notes,
  };
}

function buildSuggestions(
  skills: SkillRecord[],
  skillsById: Map<string, SkillRecord>,
  state: UsageState,
  attributionByEvent: Map<string, Attribution>,
  nowMs: number,
): UsageSuggestion[] {
  const suggestions: UsageSuggestion[] = [];

  for (const skill of skills) {
    const preference = state.preferences[skill.id];
    const reviewAfterMs = preference?.reviewAfter ? Date.parse(preference.reviewAfter) : Number.NaN;
    if (Number.isFinite(reviewAfterMs) && reviewAfterMs <= nowMs) {
      suggestions.push({
        id: `review-due:${skill.id}`,
        kind: "review-due",
        skillIds: [skill.id],
        title: `复查 ${skill.name}`,
        reason: `计划复查日期 ${preference?.reviewAfter} 已到。`,
        cautions: suggestionCautions([skill.id], skillsById, state),
      });
    }
  }

  const identicalGroups = new Map<string, SkillRecord[]>();
  for (const skill of skills) {
    if (skill.contentTruncated || state.preferences[skill.id]?.keep) continue;
    const group = identicalGroups.get(skill.content) ?? [];
    group.push(skill);
    identicalGroups.set(skill.content, group);
  }
  for (const group of identicalGroups.values()) {
    const distinctFiles = new Map<string, SkillRecord>();
    for (const skill of group) {
      distinctFiles.set(
        skill.realPath ?? skill.path,
        distinctFiles.get(skill.realPath ?? skill.path) ?? skill,
      );
    }
    const candidates = [...distinctFiles.values()].sort((left, right) =>
      left.id.localeCompare(right.id),
    );
    if (candidates.length < 2) continue;
    const skillIds = candidates.map((skill) => skill.id);
    suggestions.push({
      id: `identical-content:${skillIds.join(":")}`,
      kind: "identical-content",
      skillIds,
      title: "检查内容相同的 Skills",
      reason: "这些完整且未截断的当前文件内容完全相同；共享同一 realPath 的引用已跳过。",
      cautions: suggestionCautions(skillIds, skillsById, state),
    });
  }

  const ruleSinceMs = nowMs - state.rules.idleDays * DAY_MS;
  const ruleEventsBySkill = new Map<string, UsageEvent[]>();
  const ambiguousRuleSkills = new Set<string>();
  for (const event of state.events) {
    if (!isWithin(event.at, ruleSinceMs, nowMs)) continue;
    const attribution = attributionByEvent.get(event.id);
    if (attribution?.kind === "skill") {
      const events = ruleEventsBySkill.get(attribution.skillId) ?? [];
      events.push(event);
      ruleEventsBySkill.set(attribution.skillId, events);
    } else if (attribution?.reason === "ambiguous") {
      for (const skillId of attribution.candidateIds) ambiguousRuleSkills.add(skillId);
    }
  }

  for (const skill of skills) {
    const preference = state.preferences[skill.id];
    if (
      preference?.keep ||
      ambiguousRuleSkills.has(skill.id) ||
      !isPastGrace(preference?.firstSeenAt, nowMs, state.rules.graceDays) ||
      !hasAssessableCoverage(skill, state, state.rules.idleDays, nowMs)
    ) {
      continue;
    }
    const counts = countEvents(ruleEventsBySkill.get(skill.id) ?? []);
    const cautions = suggestionCautions([skill.id], skillsById, state);
    if (counts.calls === 0) {
      suggestions.push({
        id: `idle-review:${skill.id}`,
        kind: "idle-review",
        skillIds: [skill.id],
        title: `复查闲置候选 ${skill.name}`,
        reason: `可评估记录跨度达到 ${state.rules.idleDays} 天，期间未观察到明确调用。`,
        cautions,
      });
    } else if (counts.calls <= state.rules.lowUseThreshold) {
      suggestions.push({
        id: `low-use:${skill.id}`,
        kind: "low-use",
        skillIds: [skill.id],
        title: `复查低频候选 ${skill.name}`,
        reason: `近 ${state.rules.idleDays} 天的所选记录中观察到 ${counts.calls} 次调用，不超过阈值 ${state.rules.lowUseThreshold}。`,
        cautions,
      });
    }
  }

  return suggestions;
}

function attributeEvent(
  event: UsageEvent,
  skills: SkillRecord[],
  sourcesById: Map<string, HistorySource>,
): Attribution {
  const sourceIds = [...new Set(event.evidence.map((entry) => entry.sourceId))];
  if (sourceIds.length === 0) {
    return { kind: "unattributed", reason: "not-found", candidateIds: [] };
  }
  const sources = sourceIds.map((sourceId) => sourcesById.get(sourceId));
  if (sources.some((source) => source === undefined)) {
    return { kind: "unattributed", reason: "not-found", candidateIds: [] };
  }
  if (sources.some((source) => source?.client !== event.client)) {
    return { kind: "unattributed", reason: "not-found", candidateIds: [] };
  }
  const roots = new Set(
    sources
      .filter((source): source is HistorySource => source !== undefined)
      .filter((source) => source.client === event.client)
      .map((source) => source.rootId),
  );
  if (roots.size === 0) {
    return { kind: "unattributed", reason: "not-found", candidateIds: [] };
  }
  const candidateIds = [
    ...new Set(
      skills
        .filter(
          (skill) =>
            skill.client === event.client &&
            roots.has(skill.rootId) &&
            skill.name === event.skillName,
        )
        .map((skill) => skill.id),
    ),
  ];
  const onlyCandidate = candidateIds[0];
  if (candidateIds.length === 1 && onlyCandidate) {
    return { kind: "skill", skillId: onlyCandidate };
  }
  return {
    kind: "unattributed",
    reason: candidateIds.length > 1 ? "ambiguous" : "not-found",
    candidateIds,
  };
}

function countEvents(events: UsageEvent[]): UsageCounts {
  const invocations = events.filter((event) => event.kind === "invocation");
  const knownSessions = new Set(
    invocations
      .map((event) => event.sessionKey)
      .filter((sessionKey): sessionKey is string => sessionKey !== null),
  );
  const lastUsedAt = invocations.reduce<string | null>((latest, event) => {
    if (latest === null || compareIso(event.at, latest) > 0) return event.at;
    return latest;
  }, null);
  return {
    calls: invocations.length,
    loaded: invocations.filter((event) => event.status === "loaded").length,
    failed: invocations.filter((event) => event.status === "failed").length,
    unresolved: invocations.filter((event) => event.status === "unresolved").length,
    requests: events.filter((event) => event.kind === "request").length,
    sessions: knownSessions.size,
    lastUsedAt,
  };
}

function hasAssessableCoverage(
  skill: SkillRecord,
  state: UsageState,
  idleDays: number,
  nowMs: number,
): boolean {
  const enabledSources = sourcesForSkill(state.sources, skill).filter((source) => source.enabled);
  if (enabledSources.length === 0) return false;
  const ranges = enabledSources.map((source) => {
    const coverage = state.coverage.find((entry) => entry.sourceId === source.id);
    if (!coverage) return null;
    if (
      coverage.status !== "supported" ||
      coverage.firstRecordAt === null ||
      coverage.lastRecordAt === null ||
      coverage.readLimited
    ) {
      return null;
    }
    const first = Date.parse(coverage.firstRecordAt);
    const last = Date.parse(coverage.lastRecordAt);
    return Number.isFinite(first) && Number.isFinite(last) && last >= first
      ? { first, last }
      : null;
  });
  if (ranges.some((range) => range === null)) return false;
  const definedRanges = ranges.filter(
    (range): range is { first: number; last: number } => range !== null,
  );
  const commonFirst = Math.max(...definedRanges.map((range) => range.first));
  const commonLast = Math.min(...definedRanges.map((range) => range.last));
  const ruleSinceMs = nowMs - idleDays * DAY_MS;
  const freshnessCutoff = nowMs - Math.min(COVERAGE_FRESHNESS_DAYS, idleDays) * DAY_MS;
  return (
    commonFirst <= ruleSinceMs &&
    commonLast >= freshnessCutoff &&
    commonLast - commonFirst >= idleDays * DAY_MS
  );
}

function suggestionCautions(
  skillIds: string[],
  skillsById: Map<string, SkillRecord>,
  state: UsageState,
): string[] {
  const relatedSourceIds = new Set<string>();
  for (const skillId of skillIds) {
    const skill = skillsById.get(skillId);
    if (!skill) continue;
    for (const source of sourcesForSkill(state.sources, skill)) relatedSourceIds.add(source.id);
  }
  const gaps = [...relatedSourceIds]
    .map((sourceId) => state.coverage.find((entry) => entry.sourceId === sourceId))
    .filter((coverage) => {
      if (!coverage) return true;
      return (
        coverage.status !== "supported" ||
        coverage.firstRecordAt === null ||
        coverage.lastRecordAt === null ||
        coverage.readLimited
      );
    });
  const cautions = [
    "范围仅限当前选择且可读取的历史记录，不代表客户端、设备或时间窗口内的完整使用情况。",
    "历史保留期、解析失败、截断记录和未接入来源都可能形成证据缺口。",
    "首次观察日期不是安装日期；历史中的同名记录也不能证明当前文件当时已经安装。",
    "这是复查候选，不会执行归档、删除或其他清理操作。",
  ];
  if (gaps.length > 0 || relatedSourceIds.size === 0) {
    cautions.push("相关来源存在未连接、未支持、空范围、读取限制或其他覆盖缺口。");
  }
  return cautions;
}

function sourcesForSkill(sources: HistorySource[], skill: SkillRecord): HistorySource[] {
  return sources.filter(
    (source) => source.rootId === skill.rootId && source.client === skill.client,
  );
}

function coverageOverlaps(coverage: HistoryCoverage, sinceMs: number, nowMs: number): boolean {
  if (
    coverage.status !== "supported" ||
    coverage.firstRecordAt === null ||
    coverage.lastRecordAt === null
  ) {
    return false;
  }
  const first = Date.parse(coverage.firstRecordAt);
  const last = Date.parse(coverage.lastRecordAt);
  return Number.isFinite(first) && Number.isFinite(last) && first <= nowMs && last >= sinceMs;
}

function isPastGrace(firstSeenAt: string | undefined, nowMs: number, graceDays: number): boolean {
  if (!firstSeenAt) return false;
  const firstSeenMs = Date.parse(firstSeenAt);
  return Number.isFinite(firstSeenMs) && nowMs - firstSeenMs >= graceDays * DAY_MS;
}

function cloneEvent(event: UsageEvent): UsageEvent {
  return {
    ...event,
    evidence: event.evidence.map((entry) => ({ ...entry })),
  };
}

function cloneCoverage(coverage: HistoryCoverage): HistoryCoverage {
  return {
    ...coverage,
    clientVersions: [...coverage.clientVersions],
    limitations: [...coverage.limitations],
  };
}

function mergeEvidence(
  existing: UsageEvent["evidence"],
  incoming: UsageEvent["evidence"],
): UsageEvent["evidence"] {
  const entries = new Map<string, UsageEvent["evidence"][number]>();
  for (const evidence of [...existing, ...incoming]) {
    entries.set(`${evidence.sourceId}\u0000${evidence.file}\u0000${evidence.line}`, {
      ...evidence,
    });
  }
  return [...entries.values()].sort(
    (left, right) =>
      left.sourceId.localeCompare(right.sourceId) ||
      left.file.localeCompare(right.file) ||
      left.line - right.line,
  );
}

function mergeSameScanCoverage(
  existing: HistoryCoverage,
  incoming: HistoryCoverage,
): HistoryCoverage {
  const statusRank: Record<HistoryCoverage["status"], number> = {
    supported: 0,
    empty: 1,
    unsupported: 2,
    unreadable: 3,
  };
  return {
    ...existing,
    status:
      statusRank[incoming.status] > statusRank[existing.status] ? incoming.status : existing.status,
    filesRead: Math.max(existing.filesRead, incoming.filesRead),
    recordsRead: Math.max(existing.recordsRead, incoming.recordsRead),
    malformedLines: Math.max(existing.malformedLines, incoming.malformedLines),
    skippedFiles: Math.max(existing.skippedFiles, incoming.skippedFiles),
    readLimited: existing.readLimited || incoming.readLimited,
    firstRecordAt: earlierNullableIso(existing.firstRecordAt, incoming.firstRecordAt),
    lastRecordAt: laterNullableIso(existing.lastRecordAt, incoming.lastRecordAt),
    clientVersions: [...new Set([...existing.clientVersions, ...incoming.clientVersions])].sort(),
    limitations: [...new Set([...existing.limitations, ...incoming.limitations])].sort(),
  };
}

function deduplicateIssues(issues: UsageIssue[]): UsageIssue[] {
  const entries = new Map<string, UsageIssue>();
  for (const issue of issues) {
    const key = [
      issue.sourceId,
      issue.file ?? "",
      issue.line ?? "",
      issue.code,
      issue.message,
    ].join("\u0000");
    entries.set(key, { ...issue });
  }
  return [...entries.values()];
}

function describeMergeConflict(
  eventId: string,
  conflicts: { identity: boolean; session: boolean; status: boolean },
): string {
  const details: string[] = [];
  if (conflicts.status) details.push(`${RESULT_CONFLICT_MARKER}，按 unresolved 保留`);
  if (conflicts.session) details.push("会话归属冲突，按未知保留");
  if (conflicts.identity) details.push("事件身份字段冲突，保留旧账本身份");
  return `使用事件 ${eventId} 的重复记录存在冲突：${details.join("；")}。`;
}

function mergeEventStatus(
  existing: UsageEvent["status"],
  incoming: UsageEvent["status"],
  resultConflict: boolean,
): UsageEvent["status"] {
  if (resultConflict) return "unresolved";
  if (existing === "unresolved") return incoming;
  if (incoming === "unresolved") return existing;
  return existing === incoming ? existing : "unresolved";
}

function compareUnattributed(left: UnattributedUsage, right: UnattributedUsage): number {
  return (
    right.calls - left.calls ||
    right.requests - left.requests ||
    left.skillName.localeCompare(right.skillName) ||
    left.client.localeCompare(right.client) ||
    left.reason.localeCompare(right.reason)
  );
}

function compareEventsNewestFirst(left: UsageEvent, right: UsageEvent): number {
  return compareIso(right.at, left.at) || left.id.localeCompare(right.id);
}

function isWithin(value: string, sinceMs: number, untilMs: number): boolean {
  const time = Date.parse(value);
  return Number.isFinite(time) && time >= sinceMs && time <= untilMs;
}

function requireDate(value: string, label: string): number {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new Error(`${label} must be a valid date`);
  return time;
}

function compareIso(left: string, right: string): number {
  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) return leftTime - rightTime;
  return left.localeCompare(right);
}

function earlierIso(left: string, right: string): string {
  return compareIso(left, right) <= 0 ? left : right;
}

function earlierNullableIso(left: string | null, right: string | null): string | null {
  if (left === null) return right;
  if (right === null) return left;
  return earlierIso(left, right);
}

function laterNullableIso(left: string | null, right: string | null): string | null {
  if (left === null) return right;
  if (right === null) return left;
  return compareIso(left, right) >= 0 ? left : right;
}
