import type {
  ClientId,
  DiscoveryIssue,
  HistorySource,
  OperationRecord,
  ResourceRoot,
  SkillDiscussionDraft,
  SkillInventory,
  SkillPreferenceAction,
  SkillPreferenceCard,
  UsageRules,
  UsageView,
} from "@koyori/core";
import type { AgentConnectionInput, AgentView } from "./agent-types";

export interface SourceTarget {
  id: string;
  client: ClientId;
  path: string;
  label: string;
  shared: boolean;
  scope?: "user" | "project" | "system";
}
export interface WorkspaceView {
  roots: ResourceRoot[];
  targets: SourceTarget[];
  inventory: SkillInventory | null;
  automaticDiscovery: boolean;
  discoveryIssues: DiscoveryIssue[];
  busy: boolean;
  error: string | null;
}
export interface HistoryCandidate {
  capability: "invocations" | "unsupported";
  id: string;
  client: ClientId;
  path: string;
  label: string;
  rootIds: string[];
}
export interface CollectionView {
  enabled: boolean;
  selectedCandidateIds: string[];
  candidates: HistoryCandidate[];
  lastAttemptAt: string | null;
  error: string | null;
}
export interface ManagementPlanPreview {
  id: string;
  kind: "sync" | "restore" | "project-deploy" | "project-revoke";
  expiresAt: string;
  items: {
    name: string;
    source: string;
    target: string;
    action: string;
    files: number;
    bytes: number;
  }[];
  warnings: string[];
  canExecute: boolean;
}
export interface BackupItemView {
  id: string;
  createdAt: string;
  reason: string;
  canRestoreOriginal: boolean;
  entries: { name: string; client?: ClientId; path: string; files: number; bytes: number }[];
}
export interface RemoteBackupView {
  configured: boolean;
  remote: string | null;
  state: "local-only" | "pending" | "verified" | "failed" | "unknown";
  commit: string | null;
  lastError: string | null;
  busy: boolean;
  automatic: boolean;
  selectedCount: number;
  nextAttemptAt: string | null;
  history: { commit: string; committedAt: string; message: string }[];
}
export interface ManagementView {
  backups: BackupItemView[];
  operations: OperationRecord[];
  busy: boolean;
  lastResult: string | null;
  projectDeployments: {
    id: string;
    status: "active" | "revoked";
    projectPath: string;
    targetRoot: string;
    targetPath: string;
    sourcePath: string;
    createdAt: string;
    recoveryPath?: string;
  }[];
}

export type UpdateStatus =
  | "idle"
  | "checking"
  | "current"
  | "available"
  | "downloading"
  | "cancelling"
  | "cancelled"
  | "ready"
  | "installing"
  | "download-error"
  | "install-error"
  | "unsupported"
  | "error";

export interface UpdateView {
  status: UpdateStatus;
  currentVersion: string;
  channel: "preview" | "stable";
  checkedAt: string | null;
  latestVersion: string | null;
  publishedAt: string | null;
  progress: {
    percent: number;
    transferred: number;
    total: number;
    bytesPerSecond: number;
  } | null;
  message: string | null;
}

export interface KoyoriBridge {
  getUpdate(): Promise<UpdateView>;
  checkForUpdate(): Promise<UpdateView>;
  downloadUpdate(): Promise<UpdateView>;
  cancelUpdateDownload(): Promise<UpdateView>;
  installUpdate(): Promise<UpdateView>;
  onUpdateChanged(listener: () => void): () => void;
  getAgent(): Promise<AgentView>;
  saveAgentConnection(input: AgentConnectionInput): Promise<AgentView>;
  disconnectAgent(): Promise<AgentView>;
  createAgentSession(): Promise<AgentView>;
  selectAgentSession(id: string): Promise<AgentView>;
  renameAgentSession(id: string, title: string): Promise<AgentView>;
  deleteAgentSession(id: string): Promise<AgentView>;
  sendAgentMessage(sessionId: string, text: string): Promise<AgentView>;
  cancelAgentRun(): Promise<AgentView>;
  onAgentChanged(listener: () => void): () => void;
  getWorkspace(): Promise<WorkspaceView>;
  discoverSources(resetIgnored?: boolean): Promise<WorkspaceView>;
  setAutomaticDiscovery(enabled: boolean): Promise<WorkspaceView>;
  addProject(): Promise<WorkspaceView>;
  onWorkspaceChanged(listener: () => void): () => void;
  getRoots(): Promise<ResourceRoot[]>;
  addRoot(client: ClientId): Promise<ResourceRoot | null>;
  removeRoot(id: string): Promise<ResourceRoot[]>;
  scan(): Promise<SkillInventory>;
  cancelScan(): Promise<void>;
  openProject(): Promise<void>;
  getUsage(windowDays?: 30 | 90): Promise<UsageView>;
  prepareSkillDiscussion(skillId: string, windowDays?: 30 | 90): Promise<SkillDiscussionDraft>;
  planSkillPreference(skillId: string, action: SkillPreferenceAction): Promise<SkillPreferenceCard>;
  confirmSkillPreference(cardId: string): Promise<UsageView>;
  addHistorySource(rootId: string): Promise<HistorySource | null>;
  disconnectHistorySource(id: string): Promise<void>;
  importUsage(windowDays?: 30 | 90): Promise<UsageView>;
  cancelUsageImport(): Promise<void>;
  setSkillPreference(
    skillId: string,
    patch: { keep?: boolean; reviewAfter?: string | null },
    windowDays?: 30 | 90,
  ): Promise<UsageView>;
  setUsageRules(rules: UsageRules, windowDays?: 30 | 90): Promise<UsageView>;
  markUsageReviewed(windowDays?: 30 | 90): Promise<UsageView>;
  getCollection(): Promise<CollectionView>;
  setCollection(enabled: boolean, candidateIds?: string[]): Promise<CollectionView>;
  getManagement(): Promise<ManagementView>;
  planSync(skillIds: string[], targetId: string, replace: boolean): Promise<ManagementPlanPreview>;
  planProjectDeploy(skillId: string, targetId: string): Promise<ManagementPlanPreview>;
  planProjectRevoke(deploymentId: string): Promise<ManagementPlanPreview>;
  planRestore(
    backupId: string,
    targetId: string | null,
    replace: boolean,
  ): Promise<ManagementPlanPreview>;
  executePlan(planId: string): Promise<ManagementView>;
  backupSkills(skillIds: string[]): Promise<ManagementView>;
  cancelManagement(): Promise<void>;
  getRemoteBackup(): Promise<RemoteBackupView>;
  connectRemoteBackup(remote: string): Promise<RemoteBackupView>;
  disconnectRemoteBackup(): Promise<RemoteBackupView>;
  publishBackup(snapshotId: string): Promise<RemoteBackupView>;
  refreshRemoteHistory(): Promise<RemoteBackupView>;
  fetchRemoteBackup(commit: string): Promise<RemoteBackupView>;
  setAutomaticBackup(enabled: boolean, skillIds: string[]): Promise<RemoteBackupView>;
  cancelRemoteBackup(): Promise<void>;
}
declare global {
  const __APP_VERSION__: string;
  interface Window {
    koyori: KoyoriBridge;
  }
}
