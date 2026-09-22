export const GIT_BACKUP_BRANCH = "koyori-backups";

export type GitBackupState = "local-only" | "pending" | "verified" | "failed" | "unknown";

export type GitBackupErrorCode =
  | "aborted"
  | "conflict"
  | "corrupt-data"
  | "git"
  | "invalid-input"
  | "io"
  | "limit"
  | "missing"
  | "timeout";

export class GitBackupError extends Error {
  readonly code: GitBackupErrorCode;

  constructor(code: GitBackupErrorCode, message: string) {
    super(message);
    this.name = "GitBackupError";
    this.code = code;
  }
}

export interface GitBackupStatus {
  version: 1;
  configured: boolean;
  remote: string | null;
  branch: typeof GIT_BACKUP_BRANCH;
  localCommit: string | null;
  remoteCommit: string | null;
  state: GitBackupState;
  lastPublishedAt: string | null;
  lastError: string | null;
}

export interface GitBackupPublishResult {
  commit: string;
  state: GitBackupState;
  remoteCommit: string | null;
  verified: boolean;
  error: string | null;
}

export interface GitBackupHistoryEntry {
  commit: string;
  parents: string[];
  message: string;
  author: string;
  committedAt: string;
}

export interface GitBackupFetchedSnapshot {
  commit: string;
  directory: string;
  files: number;
  bytes: number;
}

export interface GitBackupStore {
  status(): Promise<GitBackupStatus>;
  connect(remote: string): Promise<GitBackupStatus>;
  disconnect(): Promise<void>;
  publish(
    snapshotDirectory: string,
    options?: { signal?: AbortSignal },
  ): Promise<GitBackupPublishResult>;
  history(options?: { refresh?: boolean; signal?: AbortSignal }): Promise<GitBackupHistoryEntry[]>;
  fetchSnapshot(
    commit: string,
    options?: { signal?: AbortSignal },
  ): Promise<GitBackupFetchedSnapshot>;
}
