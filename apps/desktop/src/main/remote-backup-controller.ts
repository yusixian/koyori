import { createHash, randomUUID } from "node:crypto";
import { type FSWatcher, watch } from "node:fs";
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ResourceRoot, SkillInventory, SkillRecord } from "@koyori/core";
import { ipcMain } from "electron";
import type {
  GitBackupHistoryEntry,
  GitBackupStore,
} from "../../../../packages/core/src/git-backup-types";
import type { ManagementStore } from "../../../../packages/core/src/management-types";
import type { RemoteBackupView } from "../bridge";

interface Settings {
  version: 1;
  enabled: boolean;
  skillIds: string[];
  lastFingerprint: string | null;
  pendingSnapshotId: string | null;
}
interface Dependencies {
  dataDirectory: string;
  git: GitBackupStore;
  management: ManagementStore;
  getRoots(): ResourceRoot[];
  getInventory(): SkillInventory | null;
  resourceBusy(): boolean;
  trusted(event: Electron.IpcMainInvokeEvent): void;
  changed(): void;
}
function isMissing(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
function valid(value: unknown): value is Settings {
  if (!value || typeof value !== "object") return false;
  return (
    "version" in value &&
    value.version === 1 &&
    "enabled" in value &&
    typeof value.enabled === "boolean" &&
    "skillIds" in value &&
    Array.isArray(value.skillIds) &&
    value.skillIds.every((id) => typeof id === "string") &&
    "lastFingerprint" in value &&
    (value.lastFingerprint === null || typeof value.lastFingerprint === "string") &&
    "pendingSnapshotId" in value &&
    (value.pendingSnapshotId === null || typeof value.pendingSnapshotId === "string")
  );
}

export async function createRemoteBackupController(deps: Dependencies) {
  const settingsPath = join(deps.dataDirectory, "automatic-backup.json");
  let settings: Settings = {
    version: 1,
    enabled: false,
    skillIds: [],
    lastFingerprint: null,
    pendingSnapshotId: null,
  };
  try {
    const saved: unknown = JSON.parse(await readFile(settingsPath, "utf8"));
    if (!valid(saved)) throw new Error("无效的自动备份设置，原文件已保留。");
    settings = saved;
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  let history: GitBackupHistoryEntry[] = [];
  let busy = false,
    stopped = false;
  let error: string | null = null;
  let active: AbortController | undefined;
  let dueAt: number | null = settings.enabled ? Date.now() + 120_000 : null;
  let retryMs = 120_000;
  const watchers = new Map<string, FSWatcher>();

  async function persist(next: Settings) {
    await mkdir(deps.dataDirectory, { recursive: true });
    const temporary = `${settingsPath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(next)}\n`, { mode: 0o600, flag: "wx" });
      await copyFile(settingsPath, `${settingsPath}.bak`).catch((reason: unknown) => {
        if (!isMissing(reason)) throw reason;
      });
      await rename(temporary, settingsPath);
      settings = next;
    } finally {
      await rm(temporary, { force: true });
    }
  }
  async function view(): Promise<RemoteBackupView> {
    const status = await deps.git.status();
    return {
      configured: status.configured,
      remote: status.remote,
      state: status.state,
      commit: status.remoteCommit,
      lastError: error ?? status.lastError,
      busy,
      automatic: settings.enabled,
      selectedCount: settings.skillIds.length,
      nextAttemptAt: dueAt ? new Date(dueAt).toISOString() : null,
      history,
    };
  }
  function skills(ids: unknown): SkillRecord[] {
    if (
      !Array.isArray(ids) ||
      ids.length === 0 ||
      ids.length > 500 ||
      !ids.every((id) => typeof id === "string")
    )
      throw new Error("请选择要自动备份的 Skills。");
    return [...new Set(ids)].map((id) => {
      const skill = deps.getInventory()?.skills.find((item) => item.id === id);
      if (!skill || !deps.getRoots().some((root) => root.id === skill.rootId))
        throw new Error("所选来源已断开或资源不可用，备份已停止。");
      return skill;
    });
  }
  async function operation<T>(action: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (stopped || busy || deps.resourceBusy()) throw new Error("另一个操作正在进行，请稍后重试。");
    busy = true;
    error = null;
    active = new AbortController();
    deps.changed();
    try {
      return await action(active.signal);
    } catch (reason) {
      error = reason instanceof Error ? reason.message : "远端操作失败，本地备份仍保留。";
      throw reason;
    } finally {
      busy = false;
      active = undefined;
      deps.changed();
    }
  }
  async function publish(id: string, signal: AbortSignal) {
    const path = join(deps.dataDirectory, "exports", randomUUID());
    try {
      await deps.management.exportBackup(id, path, { signal });
      const result = await deps.git.publish(path, { signal });
      if (!result.verified)
        throw new Error(result.error ?? "本地已保存，但尚未核验远端备份。请重试上传。");
    } finally {
      await rm(path, { recursive: true, force: true });
    }
    history = await deps.git.history();
  }
  function closeWatchers() {
    for (const watcher of watchers.values()) watcher.close();
    watchers.clear();
  }
  function reconcileWatchers(selected: SkillRecord[]) {
    const paths = new Set(selected.map((skill) => dirname(skill.path)));
    for (const [path, watcher] of watchers)
      if (!paths.has(path)) {
        watcher.close();
        watchers.delete(path);
      }
    for (const path of paths)
      if (!watchers.has(path)) {
        const watcher = watch(path, { recursive: true }, () => {
          if (!stopped && settings.enabled) {
            dueAt = Date.now() + 120_000;
            deps.changed();
          }
        });
        watcher.on("error", () => {
          watcher.close();
          watchers.delete(path);
          error = "目录监听中断，将在下一次检查时重连。";
          dueAt = Date.now() + 120_000;
          deps.changed();
        });
        watchers.set(path, watcher);
      }
  }
  async function tick() {
    if (stopped || !settings.enabled || busy || deps.resourceBusy()) return;
    let selected: SkillRecord[];
    try {
      selected = skills(settings.skillIds);
      reconcileWatchers(selected);
    } catch (reason) {
      closeWatchers();
      error = reason instanceof Error ? reason.message : "自动备份来源不可用。";
      deps.changed();
      return;
    }
    if (!dueAt || Date.now() < dueAt) return;
    dueAt = null;
    try {
      await operation(async (signal) => {
        if (!(await deps.git.status()).configured) throw new Error("请先连接备份远端。");
        if (settings.pendingSnapshotId) {
          const pending = (await deps.management.listBackups()).find(
            (item) => item.id === settings.pendingSnapshotId,
          );
          if (!pending) throw new Error("等待上传的本地快照不可用，请先检查备份目录。");
          await publish(pending.id, signal);
          const previousFingerprint = createHash("sha256")
            .update(
              JSON.stringify(
                pending.entries.map((entry) => [entry.directoryName, entry.client, entry.revision]),
              ),
            )
            .digest("hex");
          await persist({
            ...settings,
            pendingSnapshotId: null,
            lastFingerprint: previousFingerprint,
          });
        }
        const snapshot = await deps.management.createBackup(
          selected.map((skill) => ({
            name: skill.name,
            path: dirname(skill.path),
            client: skill.client,
          })),
          { signal },
        );
        const fingerprint = createHash("sha256")
          .update(
            JSON.stringify(
              snapshot.entries.map((entry) => [entry.directoryName, entry.client, entry.revision]),
            ),
          )
          .digest("hex");
        if (fingerprint === settings.lastFingerprint) return;
        await persist({ ...settings, pendingSnapshotId: snapshot.id });
        await publish(snapshot.id, signal);
        await persist({ ...settings, pendingSnapshotId: null, lastFingerprint: fingerprint });
      });
      retryMs = 120_000;
    } catch {
      dueAt = Date.now() + retryMs;
      retryMs = Math.min(retryMs * 2, 3_600_000);
      deps.changed();
    }
  }
  ipcMain.handle("backup:remote:get", (event) => {
    deps.trusted(event);
    return view();
  });
  ipcMain.handle("backup:remote:connect", async (event, remote: unknown) => {
    deps.trusted(event);
    if (typeof remote !== "string" || remote.length > 4096) throw new Error("无效的远端地址。");
    await operation(async () => {
      await persist({ ...settings, enabled: false, pendingSnapshotId: null });
      closeWatchers();
      dueAt = null;
      await deps.git.connect(remote);
      history = await deps.git.history();
    });
    return view();
  });
  ipcMain.handle("backup:remote:disconnect", async (event) => {
    deps.trusted(event);
    await operation(async () => {
      await persist({ ...settings, enabled: false });
      closeWatchers();
      dueAt = null;
      await deps.git.disconnect();
    });
    return view();
  });
  ipcMain.handle("backup:remote:publish", async (event, id: unknown) => {
    deps.trusted(event);
    if (
      typeof id !== "string" ||
      !(await deps.management.listBackups()).some((snapshot) => snapshot.id === id)
    )
      throw new Error("快照不存在，请先创建本地备份。");
    await operation((signal) => publish(id, signal));
    return view();
  });
  ipcMain.handle("backup:remote:history", async (event) => {
    deps.trusted(event);
    await operation(async (signal) => {
      history = await deps.git.history({ refresh: true, signal });
    });
    return view();
  });
  ipcMain.handle("backup:remote:fetch", async (event, commit: unknown) => {
    deps.trusted(event);
    if (typeof commit !== "string" || !history.some((entry) => entry.commit === commit))
      throw new Error("请先刷新并选择远端历史。");
    await operation(async (signal) => {
      const snapshot = await deps.git.fetchSnapshot(commit, { signal });
      await deps.management.importBackup(snapshot.directory, { signal });
    });
    return view();
  });
  ipcMain.handle("backup:remote:automatic", async (event, enabled: unknown, ids: unknown) => {
    deps.trusted(event);
    if (typeof enabled !== "boolean") throw new Error("无效的自动备份设置。");
    await operation(async () => {
      const selected = enabled ? skills(ids) : [];
      if (enabled && !(await deps.git.status()).configured) throw new Error("请先连接远端。");
      await persist({
        ...settings,
        enabled,
        skillIds: enabled ? selected.map((skill) => skill.id) : settings.skillIds,
        lastFingerprint: enabled ? null : settings.lastFingerprint,
        pendingSnapshotId: null,
      });
      closeWatchers();
      dueAt = enabled ? Date.now() + 120_000 : null;
      if (enabled) reconcileWatchers(selected);
    });
    return view();
  });
  ipcMain.handle("backup:remote:cancel", (event) => {
    deps.trusted(event);
    active?.abort();
  });
  return {
    tick,
    isBusy: () => busy,
    stop() {
      stopped = true;
      active?.abort();
      closeWatchers();
    },
    cancel: () => active?.abort(),
  };
}
