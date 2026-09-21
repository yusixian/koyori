import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { Worker } from "node:worker_threads";
import type {
  ResourceRoot,
  SkillInventory,
  UsageImport,
  UsageState,
  UsageView,
} from "@koyori/core";
import { buildUsageReport, createUsageState, mergeUsageImport, observeSkills } from "@koyori/core";
import { type BrowserWindow, dialog, ipcMain } from "electron";
import { isPreferencePatch, isUsageRules, readUsageState, writeUsageState } from "./usage-store";

interface Dependencies {
  path: string;
  getRoots(): ResourceRoot[];
  getInventory(): SkillInventory | null;
  getWindow(): BrowserWindow | undefined;
  resourceBusy(): boolean;
  trusted(event: Electron.IpcMainInvokeEvent): void;
}

function windowDays(value: unknown): 30 | 90 {
  if (value === undefined || value === 90) return 90;
  if (value === 30) return 30;
  throw new Error("Unsupported observation window");
}

export async function createUsageController(deps: Dependencies) {
  let state = await readUsageState(deps.path, createUsageState);
  let busy = false;
  let activeImport: AbortController | undefined;
  const now = () => new Date().toISOString();
  function view(days: 30 | 90 = 90): UsageView {
    const currentRoots = deps.getRoots();
    const effectiveState = {
      ...state,
      sources: state.sources.map((source) => ({
        ...source,
        enabled:
          source.enabled &&
          currentRoots.some((root) => root.id === source.rootId && root.client === source.client),
      })),
    };
    return {
      sources: effectiveState.sources,
      coverage: state.coverage,
      issues: state.issues,
      preferences: state.preferences,
      rules: state.rules,
      lastImportedAt: state.lastImportedAt,
      lastReviewedAt: state.lastReviewedAt,
      report: buildUsageReport(
        deps.getInventory() ?? { skills: [], issues: [], scannedAt: now() },
        effectiveState,
        { now: now(), windowDays: days },
      ),
    };
  }
  async function persist(next: UsageState) {
    await writeUsageState(deps.path, next);
    state = next;
  }
  function requireIdle() {
    if (busy || deps.resourceBusy()) throw new Error("An operation is in progress");
  }
  async function mutate(update: () => UsageState, days: 30 | 90) {
    requireIdle();
    busy = true;
    try {
      await persist(update());
      return view(days);
    } finally {
      busy = false;
    }
  }

  ipcMain.handle("usage:get", (event, days: unknown) => {
    deps.trusted(event);
    return view(windowDays(days));
  });
  ipcMain.handle("usage:source:add", async (event, rootId: unknown) => {
    deps.trusted(event);
    requireIdle();
    const root = deps.getRoots().find((item) => item.id === rootId);
    const window = deps.getWindow();
    if (root?.client !== "claude-code" || !window) throw new Error("Unsupported history source");
    busy = true;
    try {
      const result = await dialog.showOpenDialog(window, {
        title: "选择 Claude Code 会话日志目录（仅在本机读取）",
        properties: ["openDirectory"],
      });
      const path = result.filePaths[0];
      if (result.canceled || !path) return null;
      const previous = state.sources.find((item) => item.rootId === root.id && item.path === path);
      const source = {
        id: previous?.id ?? randomUUID(),
        rootId: root.id,
        client: root.client,
        path,
        label: basename(path) || path,
        enabled: true,
      };
      await persist({
        ...state,
        sources: [...state.sources.filter((item) => item.id !== source.id), source],
      });
      return source;
    } finally {
      busy = false;
    }
  });
  ipcMain.handle("usage:source:disconnect", async (event, id: unknown) => {
    deps.trusted(event);
    if (typeof id !== "string" || !state.sources.some((item) => item.id === id))
      throw new Error("Unknown source");
    await mutate(
      () => ({
        ...state,
        sources: state.sources.map((item) => (item.id === id ? { ...item, enabled: false } : item)),
      }),
      90,
    );
  });
  ipcMain.handle("usage:import", async (event, days: unknown) => {
    deps.trusted(event);
    const selectedDays = windowDays(days);
    requireIdle();
    const sources = state.sources.filter(
      (item) =>
        item.enabled &&
        deps.getRoots().some((root) => root.id === item.rootId && root.client === item.client),
    );
    if (sources.length === 0) throw new Error("Choose an enabled history source first");
    busy = true;
    const controller = new AbortController();
    activeImport = controller;
    try {
      const imported = await new Promise<UsageImport>((resolve, reject) => {
        const worker = new Worker(new URL("./usage-worker.js", import.meta.url), {
          workerData: sources,
        });
        let settled = false;
        const finish = () => {
          settled = true;
          controller.signal.removeEventListener("abort", cancel);
          void worker.terminate();
        };
        const cancel = () => {
          finish();
          reject(new Error("Import cancelled; previous ledger was preserved"));
        };
        controller.signal.addEventListener("abort", cancel, { once: true });
        worker.once("message", (result: UsageImport) => {
          finish();
          resolve(result);
        });
        worker.once("error", () => {
          finish();
          reject(new Error("History import failed"));
        });
        worker.once("exit", () => {
          if (!settled) {
            finish();
            reject(new Error("History import interrupted"));
          }
        });
      });
      controller.signal.throwIfAborted();
      // The atomic commit is no longer cancellable; do not acknowledge a late cancellation.
      activeImport = undefined;
      await persist(mergeUsageImport(state, imported, now()));
      return view(selectedDays);
    } finally {
      activeImport = undefined;
      busy = false;
    }
  });
  ipcMain.handle("usage:cancel", (event) => {
    deps.trusted(event);
    if (busy && !activeImport)
      throw new Error("Records are being saved and can no longer be cancelled");
    activeImport?.abort();
  });
  ipcMain.handle(
    "usage:preference",
    async (event, skillId: unknown, patch: unknown, days: unknown) => {
      deps.trusted(event);
      if (
        typeof skillId !== "string" ||
        !isPreferencePatch(patch) ||
        !deps.getInventory()?.skills.some((skill) => skill.id === skillId)
      )
        throw new Error("Unknown resource or invalid preference");
      return mutate(
        () => ({
          ...state,
          preferences: {
            ...state.preferences,
            [skillId]: {
              keep: false,
              reviewAfter: null,
              firstSeenAt: now(),
              ...state.preferences[skillId],
              ...patch,
            },
          },
        }),
        windowDays(days),
      );
    },
  );
  ipcMain.handle("usage:rules", async (event, rules: unknown, days: unknown) => {
    deps.trusted(event);
    if (!isUsageRules(rules)) throw new Error("Invalid review rules");
    return mutate(() => ({ ...state, rules }), windowDays(days));
  });
  ipcMain.handle("usage:reviewed", async (event, days: unknown) => {
    deps.trusted(event);
    return mutate(() => ({ ...state, lastReviewedAt: now() }), windowDays(days));
  });

  return {
    isBusy: () => busy,
    cancel: () => activeImport?.abort(),
    async observe(inventory: SkillInventory) {
      const next = observeSkills(state, inventory, now());
      if (next !== state) await persist(next);
    },
  };
}
