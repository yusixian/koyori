import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import type { SkillInventory } from "@koyori/core";
import { type BrowserWindow, dialog, ipcMain } from "electron";
import {
  type DiscoverSourcesResult,
  discoverSources,
} from "../../../../packages/core/src/discover-sources";
import type { HistoryCandidate, SourceTarget, WorkspaceView } from "../bridge";
import {
  mergeDiscoveredRoots,
  readSourceSettings,
  type StoredResourceRoot,
  writeSourceSettings,
} from "./source-store";

interface Dependencies {
  path: string;
  home: string;
  codexHome?: string;
  claudeConfigDir?: string;
  getWindow(): BrowserWindow | undefined;
  resourceBusy(): boolean;
  observe(inventory: SkillInventory): Promise<void>;
  trusted(event: Electron.IpcMainInvokeEvent): void;
  changed(): void;
}

export async function createWorkspaceController(deps: Dependencies) {
  let settings = await readSourceSettings(deps.path);
  let discovered: DiscoverSourcesResult = { roots: [], histories: [], targets: [], issues: [] };
  let inventory: SkillInventory | null = null;
  let busy = false;
  let activeScan: AbortController | undefined;
  let error: string | null = null;

  function targets(): SourceTarget[] {
    const known = settings.roots.filter(
      (root) =>
        ![...discovered.roots, ...discovered.targets].some(
          (item) => item.path === root.path && item.readOnly,
        ),
    );
    return [
      ...known.map((root) => ({
        ...root,
        shared: discovered.roots.some((item) => item.path === root.path && item.kind === "shared"),
        scope:
          discovered.roots.find((item) => item.path === root.path)?.scope ??
          discovered.targets.find((item) => item.path === root.path)?.scope,
      })),
      ...discovered.targets
        .filter(
          (target) =>
            !target.readOnly &&
            target.writable &&
            !settings.ignoredPaths.includes(target.canonicalPath) &&
            !known.some((root) => root.path === target.path),
        )
        .map((target) => ({ ...target, shared: target.kind === "shared" })),
    ];
  }
  function view(): WorkspaceView {
    return {
      roots: settings.roots,
      targets: targets(),
      inventory,
      automaticDiscovery: settings.automaticDiscovery,
      discoveryIssues: discovered.issues.filter((issue) => issue.code !== "missing"),
      busy,
      error,
    };
  }
  function candidates(): HistoryCandidate[] {
    return discovered.histories.map((source) => ({
      id: source.id,
      capability: source.client === "claude-code" ? "invocations" : "unsupported",
      client: source.client,
      path: source.path,
      label: source.label,
      rootIds: settings.roots
        .filter((root) => root.client === source.client)
        .map((root) => root.id),
    }));
  }
  async function persist(next: typeof settings) {
    await writeSourceSettings(deps.path, next);
    settings = next;
  }
  function requireIdle() {
    if (busy || deps.resourceBusy()) throw new Error("另一个操作正在进行，请稍后重试。");
  }
  async function scan() {
    const controller = new AbortController();
    activeScan = controller;
    try {
      const next = await new Promise<SkillInventory>((resolveScan, reject) => {
        const worker = new Worker(new URL("./scan-worker.js", import.meta.url), {
          workerData: settings.roots,
        });
        let settled = false;
        const finish = () => {
          settled = true;
          controller.signal.removeEventListener("abort", cancel);
          void worker.terminate();
        };
        const cancel = () => {
          finish();
          reject(new Error("已取消扫描，保留上一次清单。"));
        };
        controller.signal.addEventListener("abort", cancel, { once: true });
        worker.once("message", (result: SkillInventory) => {
          finish();
          resolveScan(result);
        });
        worker.once("error", () => {
          finish();
          reject(new Error("资源扫描失败。"));
        });
        worker.once("exit", () => {
          if (!settled) {
            finish();
            reject(new Error("资源扫描中断。"));
          }
        });
      });
      controller.signal.throwIfAborted();
      await deps.observe(next);
      inventory = next;
      return next;
    } finally {
      activeScan = undefined;
    }
  }
  async function discover(resetIgnored = false) {
    discovered = await discoverSources({
      home: deps.home,
      codexHome: deps.codexHome,
      claudeConfigDir: deps.claudeConfigDir,
      projects: settings.projects,
    });
    const next = mergeDiscoveredRoots(
      resetIgnored ? { ...settings, ignoredPaths: [] } : settings,
      discovered.roots,
    );
    if (JSON.stringify(next) !== JSON.stringify(settings)) await persist(next);
  }
  async function operation<T>(action: () => Promise<T>): Promise<T> {
    requireIdle();
    busy = true;
    error = null;
    deps.changed();
    try {
      return await action();
    } catch (reason) {
      error = reason instanceof Error ? reason.message : "操作未完成。";
      throw reason;
    } finally {
      busy = false;
      deps.changed();
    }
  }
  async function refresh() {
    return operation(async () => {
      if (settings.automaticDiscovery) await discover();
      await scan();
    }).then(view);
  }
  ipcMain.handle("workspace:get", (event) => {
    deps.trusted(event);
    return view();
  });
  ipcMain.handle("roots:list", (event) => {
    deps.trusted(event);
    return settings.roots;
  });
  ipcMain.handle("workspace:discover", (event, reset: unknown) => {
    deps.trusted(event);
    if (reset !== undefined && typeof reset !== "boolean") throw new Error("无效的重新发现选项。");
    return operation(async () => {
      await discover(reset === true);
      await scan();
    }).then(view);
  });
  ipcMain.handle("workspace:automatic", (event, enabled: unknown) => {
    deps.trusted(event);
    if (typeof enabled !== "boolean") throw new Error("无效的自动发现设置。");
    return operation(async () => {
      await persist({ ...settings, automaticDiscovery: enabled });
      if (enabled) {
        await discover();
        await scan();
      }
    }).then(view);
  });
  ipcMain.handle("workspace:project:add", (event) => {
    deps.trusted(event);
    return operation(async () => {
      const window = deps.getWindow();
      if (!window) throw new Error("窗口不可用。");
      const result = await dialog.showOpenDialog(window, {
        title: "关联项目的 Skills 目录",
        properties: ["openDirectory"],
      });
      const path = result.filePaths[0];
      if (!result.canceled && path) {
        await persist({
          ...settings,
          projects: [...new Set([...settings.projects, await realpath(path)])],
        });
        await discover();
        await scan();
      }
    }).then(view);
  });
  ipcMain.handle("roots:add", (event, client: unknown) => {
    deps.trusted(event);
    if (client !== "claude-code" && client !== "codex") throw new Error("不支持的客户端。");
    return operation(async () => {
      const window = deps.getWindow();
      if (!window) throw new Error("窗口不可用。");
      const result = await dialog.showOpenDialog(window, {
        title: "选择要读取的 Skills 目录",
        properties: ["openDirectory"],
      });
      const path = result.filePaths[0];
      if (result.canceled || !path) return null;
      const canonical = await realpath(path);
      const existing = settings.roots.find(
        (root) =>
          root.client === client && (root.canonicalPath ?? resolve(root.path)) === canonical,
      );
      if (existing) return existing;
      const root: StoredResourceRoot = {
        id: randomUUID(),
        client,
        path: resolve(path),
        canonicalPath: canonical,
        label: basename(path) || path,
      };
      await persist({
        ...settings,
        roots: [...settings.roots, root],
        ignoredPaths: settings.ignoredPaths.filter((item) => item !== canonical),
      });
      await scan();
      return root;
    });
  });
  ipcMain.handle("roots:remove", (event, id: unknown) => {
    deps.trusted(event);
    if (typeof id !== "string") throw new Error("无效的来源。");
    return operation(async () => {
      const root = settings.roots.find((item) => item.id === id);
      if (!root) throw new Error("来源已断开。");
      const canonical = await realpath(root.path).catch(() => resolve(root.path));
      await persist({
        ...settings,
        roots: settings.roots.filter((item) => item.id !== id),
        ignoredPaths: [...new Set([...settings.ignoredPaths, canonical])],
      });
      inventory = null;
      await scan();
      return settings.roots;
    });
  });
  ipcMain.handle("skills:scan", (event) => {
    deps.trusted(event);
    return operation(scan);
  });
  ipcMain.handle("skills:cancel", (event) => {
    deps.trusted(event);
    activeScan?.abort();
  });
  // Candidates are only paths. Reading history contents still requires collection opt-in.
  await discoverSources({
    home: deps.home,
    codexHome: deps.codexHome,
    claudeConfigDir: deps.claudeConfigDir,
    projects: settings.projects,
  }).then((value) => {
    discovered = value;
  });
  return {
    getRoots: () => settings.roots,
    getProjects: () => settings.projects,
    getInventory: () => inventory,
    getTargets: targets,
    getCandidates: candidates,
    isBusy: () => busy,
    cancel: () => activeScan?.abort(),
    refresh,
  };
}
