import type { ClientId } from "./types.ts";

export interface HistorySource {
  id: string;
  rootId: string;
  client: ClientId;
  path: string;
  label: string;
  enabled: boolean;
}

export interface UsageEvidence {
  sourceId: string;
  file: string;
  line: number;
}

export interface UsageEvent {
  id: string;
  client: ClientId;
  skillName: string;
  sessionKey: string | null;
  at: string;
  kind: "invocation" | "request";
  status: "loaded" | "failed" | "unresolved";
  resultConflict?: true;
  evidence: UsageEvidence[];
}

export interface HistoryCoverage {
  sourceId: string;
  adapter: string;
  status: "supported" | "unsupported" | "empty" | "unreadable";
  scannedAt: string;
  readLimited: boolean;
  filesRead: number;
  recordsRead: number;
  malformedLines: number;
  skippedFiles: number;
  firstRecordAt: string | null;
  lastRecordAt: string | null;
  clientVersions: string[];
  limitations: string[];
}

export interface UsageIssue {
  sourceId: string;
  file?: string;
  line?: number;
  code: "unreadable" | "malformed" | "unsupported" | "limit" | "link" | "identity";
  message: string;
}

export interface UsageImport {
  events: UsageEvent[];
  coverage: HistoryCoverage[];
  issues: UsageIssue[];
}

export interface UsageImportOptions {
  signal?: AbortSignal;
  now?: string;
}

export interface SkillPreference {
  keep: boolean;
  reviewAfter: string | null;
  firstSeenAt: string;
}

export interface UsageRules {
  idleDays: number;
  lowUseThreshold: number;
  graceDays: number;
}

export interface UsageState {
  version: 1;
  sources: HistorySource[];
  events: UsageEvent[];
  coverage: HistoryCoverage[];
  issues: UsageIssue[];
  preferences: Record<string, SkillPreference>;
  rules: UsageRules;
  lastImportedAt: string | null;
  lastReviewedAt: string | null;
}

export interface UsageCounts {
  calls: number;
  loaded: number;
  failed: number;
  unresolved: number;
  requests: number;
  sessions: number;
  lastUsedAt: string | null;
}

export interface SkillUsage extends UsageCounts {
  skillId: string;
  status: "not-connected" | "unknown" | "observed" | "ambiguous";
  evidence: UsageEvent[];
  sourceIds: string[];
  notes: string[];
}

export interface UsageSuggestion {
  id: string;
  kind: "review-due" | "identical-content" | "idle-review" | "low-use";
  skillIds: string[];
  title: string;
  reason: string;
  cautions: string[];
}

export interface UnattributedUsage extends UsageCounts {
  skillName: string;
  client: ClientId;
  reason: "not-found" | "ambiguous";
}

export interface UsageReport {
  windowDays: number;
  since: string;
  until: string;
  skills: SkillUsage[];
  unattributed: UnattributedUsage[];
  suggestions: UsageSuggestion[];
  totalEvents: number;
}

export interface UsageView {
  sources: HistorySource[];
  coverage: HistoryCoverage[];
  issues: UsageIssue[];
  preferences: Record<string, SkillPreference>;
  rules: UsageRules;
  lastImportedAt: string | null;
  lastReviewedAt: string | null;
  report: UsageReport;
}
