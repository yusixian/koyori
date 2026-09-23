import type { ClientId } from "./types.ts";

export type ManagementErrorCode =
  | "aborted"
  | "busy"
  | "conflict"
  | "corrupt-data"
  | "expired-plan"
  | "invalid-input"
  | "limit"
  | "missing"
  | "outside-authorized-roots"
  | "plan-consumed"
  | "unsafe-link"
  | "unsupported-entry";

export interface ManagementLimits {
  maxFileBytes: number;
  maxTotalBytes: number;
  maxEntries: number;
  planTtlMs: number;
}

export interface ManagementStoreOptions {
  /** Read at every plan and execution boundary so revoked roots invalidate old plans. */
  authorizedRoots: () => readonly string[];
  limits?: Partial<ManagementLimits>;
}

export interface SourceLink {
  target: string;
  resolvedKind: "file" | "directory";
}

export interface DirectoryManifestEntry {
  path: string;
  kind: "file" | "directory";
  sourceKind: "file" | "directory" | "symlink";
  mode: number;
  bytes?: number;
  hash?: string;
  link?: SourceLink;
}

export interface DirectoryManifest {
  algorithm: "sha256";
  hash: string;
  files: number;
  directories: number;
  bytes: number;
  entries: DirectoryManifestEntry[];
}

export type DirectoryRevision =
  | {
      kind: "absent";
      nearestAncestorPath: string;
      nearestAncestorRealPath: string;
    }
  | {
      kind: "directory";
      realPath: string;
      manifestHash: string;
      files: number;
      bytes: number;
    }
  | { kind: "symlink"; realPath: string }
  | { kind: "other"; realPath: string };

export interface CompatibilityWarning {
  code: "client-specific-field";
  field: string;
  message: string;
}

export interface PlanConflict {
  code: "different-content" | "target-not-skill" | "target-symlink" | "target-unsupported";
  message: string;
}

export type SyncAction = "copy" | "replace" | "skip" | "conflict" | "revoke";

export interface SyncPlanInput {
  source: string;
  target: string;
  sourceClient?: ClientId;
  targetClient?: ClientId;
  allowReplace: boolean;
  signal?: AbortSignal;
}

export interface SyncPlan {
  id: string;
  kind: "sync";
  createdAt: string;
  expiresAt: string;
  allowReplace: boolean;
  source: {
    path: string;
    realPath: string;
    revision: DirectoryRevision;
    manifest: DirectoryManifest;
  };
  target: { path: string; revision: DirectoryRevision };
  action: SyncAction;
  executable: boolean;
  conflict?: PlanConflict;
  compatibilityWarnings: CompatibilityWarning[];
}

export interface BackupEntryInput {
  id?: string;
  name: string;
  path: string;
  client?: ClientId;
}

export type BackupReason = "manual" | "write-before" | "restore-before" | "import";

export interface BackupEntrySummary {
  id: string;
  name: string;
  directoryName: string;
  client?: ClientId;
  originalPath?: string;
  revision: DirectoryRevision;
  files: number;
  bytes: number;
}

export interface BackupSummary {
  id: string;
  createdAt: string;
  reason: BackupReason;
  entries: BackupEntrySummary[];
}

export interface CreateBackupOptions {
  reason?: BackupReason;
  signal?: AbortSignal;
}

export interface PortableBackupEntry {
  id: string;
  name: string;
  directoryName: string;
  client?: ClientId;
  files: number;
  bytes: number;
  manifest: DirectoryManifest;
}

export interface PortableBackupManifest {
  schema: "koyori.skill-backup";
  version: 1;
  id: string;
  createdAt: string;
  entries: PortableBackupEntry[];
}

export interface PortableBackupResult {
  path: string;
  manifest: PortableBackupManifest;
}

export interface TransferBackupOptions {
  signal?: AbortSignal;
}

export interface RestoreTargetInput {
  entryId: string;
  target: string;
}

export interface PlanRestoreOptions {
  allowReplace: boolean;
  signal?: AbortSignal;
}

export interface RestorePlanItem {
  id: string;
  entryId: string;
  sourceRevision: DirectoryRevision;
  target: string;
  targetRevision: DirectoryRevision;
  action: SyncAction;
  conflict?: PlanConflict;
}

export interface RestorePlan {
  id: string;
  kind: "restore";
  snapshotId: string;
  createdAt: string;
  expiresAt: string;
  allowReplace: boolean;
  executable: boolean;
  items: RestorePlanItem[];
}

export type ManagementPlan = SyncPlan | RestorePlan;

export interface ProjectDeployment {
  id: string;
  status: "active" | "revoked";
  projectPath: string;
  targetRoot: string;
  targetClient: ClientId;
  sourcePath: string;
  targetPath: string;
  installedRevision: DirectoryRevision & { kind: "directory" };
  createdAt: string;
  revokedAt?: string;
  recoveryPath?: string;
}

export interface ProjectDeploymentPlan {
  id: string;
  kind: "project-deploy" | "project-revoke";
  expiresAt: string;
  executable: boolean;
  projectPath: string;
  targetRoot: string;
  targetClient: ClientId;
  targetPath: string;
  sourcePath?: string;
  deploymentId?: string;
  sourceRevision?: DirectoryRevision;
  targetRevision: DirectoryRevision;
  files: number;
  bytes: number;
  conflict?: string;
  compatibilityWarnings: CompatibilityWarning[];
}

export interface ProjectDeployInput {
  source: string;
  sourceClient?: ClientId;
  projectPath: string;
  targetRoot: string;
  targetClient: ClientId;
  signal?: AbortSignal;
}

export type RecoveryMaterialState = "reserved" | "moving" | "preserved" | "restored";

export interface OperationItemRecord {
  id: string;
  target: string;
  action: SyncAction;
  status: "pending" | "skipped" | "succeeded" | "failed" | "cancelled" | "interrupted";
  backupSnapshotId?: string;
  /** Local recovery material retained from the exact directory that was displaced. */
  recoveryPath?: string;
  /** During an atomic move, either path can contain the material after a process interruption. */
  recoveryDestinationPath?: string;
  recoveryState?: RecoveryMaterialState;
  error?: string;
}

export interface OperationRecord {
  id: string;
  planId: string;
  kind: "sync" | "restore" | "project-deploy" | "project-revoke";
  status: "running" | "succeeded" | "partial" | "failed" | "cancelled" | "interrupted";
  startedAt: string;
  completedAt?: string;
  items: OperationItemRecord[];
  error?: string;
}

export interface ExecuteOptions {
  signal?: AbortSignal;
}

export interface ManagementStore {
  planProjectDeploy(input: ProjectDeployInput): Promise<ProjectDeploymentPlan>;
  planProjectRevoke(deploymentId: string, signal?: AbortSignal): Promise<ProjectDeploymentPlan>;
  executeProjectPlan(planId: string, options?: ExecuteOptions): Promise<OperationRecord>;
  listProjectDeployments(): Promise<ProjectDeployment[]>;
  planSync(input: SyncPlanInput): Promise<SyncPlan>;
  execute(planId: string, options?: ExecuteOptions): Promise<OperationRecord>;
  createBackup(
    entries: readonly BackupEntryInput[],
    options?: CreateBackupOptions,
  ): Promise<BackupSummary>;
  listBackups(): Promise<BackupSummary[]>;
  exportBackup(
    snapshotId: string,
    destination: string,
    options?: TransferBackupOptions,
  ): Promise<PortableBackupResult>;
  importBackup(path: string, options?: TransferBackupOptions): Promise<BackupSummary>;
  planRestore(
    snapshotId: string,
    targets: readonly RestoreTargetInput[],
    options: PlanRestoreOptions,
  ): Promise<RestorePlan>;
  getOperation(id: string): Promise<OperationRecord | undefined>;
  listOperations(): Promise<OperationRecord[]>;
}
