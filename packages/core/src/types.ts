export type ClientId = "claude-code" | "codex";

export interface ResourceRoot {
  id: string;
  client: ClientId;
  path: string;
  label: string;
}

export type ScanIssueCode =
  | "missing"
  | "unreadable"
  | "invalid-metadata"
  | "cross-root-link"
  | "symlink-loop"
  | "nonstandard-entry"
  | "limit"
  | "cancel";

export interface ScanIssue {
  path: string;
  code: ScanIssueCode;
  message: string;
  severity: "warning" | "error";
}

export interface SkillRecord {
  id: string;
  name: string;
  description: string;
  path: string;
  rootId: string;
  client: ClientId;
  content: string;
  contentTruncated: boolean;
  isSymlink: boolean;
  realPath?: string;
}

export interface SkillInventory {
  skills: SkillRecord[];
  issues: ScanIssue[];
  scannedAt: string;
}

export interface ScanSkillsOptions {
  signal?: AbortSignal;
}
