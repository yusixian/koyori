import type {
  ResourceRoot,
  SkillInventory,
  UsageEvent,
  UsageImport,
  UsageImportCache,
  UsageState,
  UsageView,
} from "@koyori/core";
import { createUsageState } from "@koyori/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type IpcHandler = (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown;
type WorkerListener = (...args: unknown[]) => void;

interface WorkerDouble {
  workerData: unknown;
  emit(event: string, ...args: unknown[]): void;
  terminate(): Promise<number>;
}

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
  workers: [] as WorkerDouble[],
  readUsageState: vi.fn(),
  writeUsageState: vi.fn(),
  readUsageCache: vi.fn(),
  writeUsageCache: vi.fn(),
  readCollectionState: vi.fn(),
  writeCollectionState: vi.fn(),
  showOpenDialog: vi.fn(),
}));

vi.mock("electron", () => ({
  dialog: { showOpenDialog: mocks.showOpenDialog },
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      mocks.handlers.set(channel, handler);
    }),
  },
}));

vi.mock("node:worker_threads", () => ({
  Worker: class implements WorkerDouble {
    readonly listeners = new Map<string, WorkerListener>();
    readonly workerData: unknown;

    constructor(_filename: URL, options: { workerData?: unknown }) {
      this.workerData = options.workerData;
      mocks.workers.push(this);
    }

    once(event: string, listener: WorkerListener) {
      this.listeners.set(event, listener);
      return this;
    }

    emit(event: string, ...args: unknown[]) {
      this.listeners.get(event)?.(...args);
    }

    async terminate() {
      return 0;
    }
  },
}));

vi.mock("./usage-store", () => ({
  isPreferencePatch: vi.fn(() => true),
  isUsageRules: vi.fn(() => true),
  readUsageState: mocks.readUsageState,
  writeUsageState: mocks.writeUsageState,
  readUsageCache: mocks.readUsageCache,
  writeUsageCache: mocks.writeUsageCache,
  readCollectionState: mocks.readCollectionState,
  writeCollectionState: mocks.writeCollectionState,
  createCollectionState: () => ({
    version: 1,
    enabled: false,
    candidateIds: [],
    lastAttemptAt: null,
    error: null,
  }),
}));

import { createUsageController } from "./usage-controller";

const now = "2026-09-22T12:00:00.000Z";
const root: ResourceRoot = {
  id: "root-claude",
  client: "claude-code",
  path: "/fixtures/skills",
  label: "Claude Skills",
};
const inventory: SkillInventory = {
  scannedAt: now,
  issues: [],
  skills: [
    {
      id: "skill-writer",
      name: "writer",
      description: "Writes fixture text",
      path: "/fixtures/skills/writer/SKILL.md",
      rootId: root.id,
      client: "claude-code",
      content: "# Writer",
      contentTruncated: false,
      isSymlink: false,
    },
  ],
};
const source = {
  id: "history-claude",
  rootId: root.id,
  client: "claude-code" as const,
  path: "/fixtures/history",
  label: "Claude history",
  enabled: true,
};

function usageEvent(id: string): UsageEvent {
  return {
    id,
    client: "claude-code",
    skillName: "writer",
    sessionKey: `session-${id}`,
    at: "2026-09-21T10:00:00.000Z",
    kind: "invocation",
    status: "loaded",
    evidence: [{ sourceId: source.id, file: "project/session.jsonl", line: 3 }],
  };
}

function state(overrides: Partial<UsageState> = {}): UsageState {
  return {
    ...createUsageState(),
    sources: [source],
    ...overrides,
  };
}

function ipc(channel: string): IpcHandler {
  const handler = mocks.handlers.get(channel);
  if (!handler) throw new Error(`Missing IPC handler: ${channel}`);
  return handler;
}

function event(): Electron.IpcMainInvokeEvent {
  return {} as Electron.IpcMainInvokeEvent;
}

async function nextWorker(): Promise<WorkerDouble> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const worker = mocks.workers[0];
    if (worker) return worker;
    await Promise.resolve();
  }
  throw new Error("Usage worker was not created");
}

function dependencies(
  getRoots: () => ResourceRoot[],
  trusted = vi.fn(),
  getCandidates = () =>
    [] as Array<{
      id: string;
      client: "claude-code" | "codex";
      path: string;
      label: string;
      rootIds: string[];
      capability: "invocations" | "unsupported";
    }>,
) {
  return {
    path: "/fixtures/user-data/usage.json",
    getRoots,
    getInventory: () => inventory,
    getWindow: () => undefined,
    getCandidates,
    changed: vi.fn(),
    resourceBusy: () => false,
    trusted,
  };
}

beforeEach(() => {
  mocks.handlers.clear();
  mocks.workers.length = 0;
  mocks.readUsageState.mockReset();
  mocks.writeUsageState.mockReset();
  mocks.writeUsageState.mockResolvedValue(undefined);
  mocks.readUsageCache.mockReset();
  mocks.readUsageCache.mockResolvedValue({ version: 1, files: {} });
  mocks.writeUsageCache.mockReset();
  mocks.writeUsageCache.mockResolvedValue(undefined);
  mocks.readCollectionState.mockReset();
  mocks.readCollectionState.mockResolvedValue({
    version: 1,
    enabled: false,
    candidateIds: [],
    lastAttemptAt: null,
    error: null,
  });
  mocks.writeCollectionState.mockReset();
  mocks.writeCollectionState.mockResolvedValue(undefined);
  mocks.showOpenDialog.mockReset();
  vi.useFakeTimers();
  vi.setSystemTime(now);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("usage controller boundaries", () => {
  it("masks a revoked resource root immediately while retaining collected events", async () => {
    let roots = [root];
    mocks.readUsageState.mockResolvedValue(
      state({ events: [usageEvent("observed")], lastImportedAt: now }),
    );
    await createUsageController(dependencies(() => roots));

    const connected = ipc("usage:get")(event(), 30) as UsageView;
    expect(connected.sources[0]?.enabled).toBe(true);
    expect(connected.report.skills[0]).toMatchObject({ calls: 1, status: "observed" });

    roots = [];
    const revoked = ipc("usage:get")(event(), 30) as UsageView;
    expect(revoked.sources[0]?.enabled).toBe(false);
    expect(revoked.report.totalEvents).toBe(1);
    expect(revoked.report.skills[0]).toMatchObject({ calls: 1, status: "observed" });
    await expect(ipc("usage:import")(event(), 30)).rejects.toThrow(
      "Choose an enabled history source first",
    );
    expect(mocks.workers).toHaveLength(0);
    expect(mocks.writeUsageState).not.toHaveBeenCalled();
  });

  it("rejects late cancellation during persistence without publishing state early", async () => {
    let finishWrite: (() => void) | undefined;
    const pendingWrite = new Promise<void>((resolve) => {
      finishWrite = resolve;
    });
    mocks.readUsageState.mockResolvedValue(state());
    mocks.writeUsageState.mockReturnValueOnce(pendingWrite);
    await createUsageController(dependencies(() => [root]));

    const importing = ipc("usage:import")(event(), 30) as Promise<UsageView>;
    const imported: UsageImport = {
      events: [usageEvent("new-event")],
      coverage: [],
      issues: [],
    };
    const worker = mocks.workers[0];
    if (!worker) throw new Error("Usage worker was not created");
    worker.emit("message", { imported, cache: { version: 1, files: {} } });
    await Promise.resolve();

    expect(mocks.writeUsageState).toHaveBeenCalledTimes(1);
    expect(() => ipc("usage:cancel")(event())).toThrow(
      "Records are being saved and can no longer be cancelled",
    );
    const whileSaving = ipc("usage:get")(event(), 30) as UsageView;
    expect(whileSaving.lastImportedAt).toBeNull();
    expect(whileSaving.report.totalEvents).toBe(0);

    finishWrite?.();
    const completed = await importing;
    expect(completed.lastImportedAt).toBe(now);
    expect(completed.report.totalEvents).toBe(1);
  });

  it("rejects IPC calls that fail the host trust check", async () => {
    const trusted = vi.fn(() => {
      throw new Error("Unauthorized window");
    });
    mocks.readUsageState.mockResolvedValue(state());
    await createUsageController(dependencies(() => [root], trusted));

    expect(() => ipc("usage:get")(event(), 30)).toThrow("Unauthorized window");
    expect(trusted).toHaveBeenCalledOnce();
    expect(mocks.writeUsageState).not.toHaveBeenCalled();
  });

  it("filters revoked roots from a multi-root history source without duplicating it", async () => {
    const secondRoot = { ...root, id: "root-second", path: "/fixtures/skills-second" };
    let roots = [root, secondRoot];
    mocks.readUsageState.mockResolvedValue(
      state({
        sources: [{ ...source, rootIds: [root.id, secondRoot.id] }],
      }),
    );
    await createUsageController(dependencies(() => roots));

    roots = [secondRoot];
    const oneRemaining = ipc("usage:get")(event(), 30) as UsageView;
    expect(oneRemaining.sources).toEqual([
      expect.objectContaining({ enabled: true, rootId: secondRoot.id, rootIds: [secondRoot.id] }),
    ]);

    roots = [];
    const noneRemaining = ipc("usage:get")(event(), 30) as UsageView;
    expect(noneRemaining.sources[0]).toEqual(
      expect.objectContaining({ enabled: false, rootIds: [] }),
    );
  });

  it("opts into one automatic candidate, persists ledger before cache, and exposes success", async () => {
    const candidate = {
      id: "claude-projects",
      client: "claude-code" as const,
      path: "/fixtures/automatic-history",
      label: "Claude projects",
      rootIds: [root.id],
      capability: "invocations" as const,
    };
    mocks.readUsageState.mockResolvedValue(state({ sources: [] }));
    await createUsageController(
      dependencies(
        () => [root],
        vi.fn(),
        () => [candidate],
      ),
    );

    const enabling = ipc("collection:set")(event(), true, [candidate.id]) as Promise<{
      enabled: boolean;
      error: string | null;
    }>;
    const worker = await nextWorker();
    expect(worker.workerData).toEqual(
      expect.objectContaining({
        sources: [
          expect.objectContaining({
            id: `automatic:${candidate.id}`,
            rootIds: [root.id],
            path: candidate.path,
          }),
        ],
      }),
    );
    const imported: UsageImport = {
      events: [
        {
          ...usageEvent("automatic-event"),
          evidence: [
            {
              sourceId: `automatic:${candidate.id}`,
              file: "session.jsonl",
              line: 1,
            },
          ],
        },
      ],
      coverage: [],
      issues: [],
    };
    const nextCache: UsageImportCache = { version: 1, files: {} };
    worker.emit("message", { imported, cache: nextCache });

    const result = await enabling;
    expect(result).toMatchObject({ enabled: true, error: null });
    expect(mocks.writeUsageState).toHaveBeenCalledTimes(1);
    expect(mocks.writeUsageCache).toHaveBeenCalledWith(
      "/fixtures/user-data/usage.json.cache",
      nextCache,
    );
    expect(mocks.writeUsageState.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.writeUsageCache.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(mocks.writeCollectionState).toHaveBeenLastCalledWith(
      "/fixtures/user-data/usage.json.collection",
      expect.objectContaining({ enabled: true, lastAttemptAt: now, error: null }),
    );
  });

  it("records automatic collection cancellation as a failed attempt without publishing import time", async () => {
    const candidate = {
      id: "claude-projects",
      client: "claude-code" as const,
      path: "/fixtures/automatic-history",
      label: "Claude projects",
      rootIds: [root.id],
      capability: "invocations" as const,
    };
    mocks.readUsageState.mockResolvedValue(state({ sources: [] }));
    await createUsageController(
      dependencies(
        () => [root],
        vi.fn(),
        () => [candidate],
      ),
    );

    const enabling = ipc("collection:set")(event(), true, [candidate.id]) as Promise<{
      error: string | null;
    }>;
    await nextWorker();
    ipc("usage:cancel")(event());
    const result = await enabling;

    expect(result.error).toContain("cancelled");
    expect(mocks.writeUsageState).not.toHaveBeenCalled();
    expect(mocks.writeUsageCache).not.toHaveBeenCalled();
    const current = ipc("usage:get")(event(), 30) as UsageView;
    expect(current.lastImportedAt).toBeNull();
    expect(mocks.writeCollectionState).toHaveBeenLastCalledWith(
      "/fixtures/user-data/usage.json.collection",
      expect.objectContaining({ lastAttemptAt: now, error: expect.stringContaining("cancelled") }),
    );
  });

  it("does not opt an unsupported Codex history candidate into automatic collection", async () => {
    const candidate = {
      id: "codex-sessions",
      client: "codex" as const,
      path: "/fixtures/codex-sessions",
      label: "Codex sessions",
      rootIds: ["root-codex"],
      capability: "unsupported" as const,
    };
    mocks.readUsageState.mockResolvedValue(state({ sources: [] }));
    await createUsageController(
      dependencies(
        () => [{ ...root, id: "root-codex", client: "codex" }],
        vi.fn(),
        () => [candidate],
      ),
    );

    await expect(ipc("collection:set")(event(), true, [candidate.id])).rejects.toThrow(
      "Choose a history candidate first",
    );
    expect(mocks.workers).toHaveLength(0);
    expect(mocks.writeCollectionState).not.toHaveBeenCalled();
  });

  it("returns the persisted collection selection and preserves it when pausing", async () => {
    mocks.readCollectionState.mockResolvedValue({
      version: 1,
      enabled: false,
      candidateIds: ["claude-projects"],
      lastAttemptAt: null,
      error: null,
    });
    await createUsageController(
      dependencies(
        () => [root],
        vi.fn(),
        () => [
          {
            id: "claude-projects",
            client: "claude-code",
            path: "/fixtures/automatic-history",
            label: "Claude projects",
            rootIds: [root.id],
            capability: "invocations",
          },
        ],
      ),
    );

    expect(ipc("collection:get")(event())).toMatchObject({
      enabled: false,
      selectedCandidateIds: ["claude-projects"],
    });
    const paused = await ipc("collection:set")(event(), false);
    expect(paused).toMatchObject({ selectedCandidateIds: ["claude-projects"] });
    expect(mocks.writeCollectionState).toHaveBeenLastCalledWith(
      "/fixtures/user-data/usage.json.collection",
      expect.objectContaining({ enabled: false, candidateIds: ["claude-projects"] }),
    );
  });

  it("serializes collection setting writes", async () => {
    let finishWrite: (() => void) | undefined;
    mocks.writeCollectionState.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishWrite = resolve;
      }),
    );
    mocks.readUsageState.mockResolvedValue(state({ sources: [] }));
    await createUsageController(dependencies(() => [root]));

    const first = ipc("collection:set")(event(), false, []) as Promise<unknown>;
    await Promise.resolve();
    await expect(ipc("collection:set")(event(), false, [])).rejects.toThrow(
      "An operation is in progress",
    );

    finishWrite?.();
    await first;
    expect(mocks.writeCollectionState).toHaveBeenCalledTimes(1);
  });
});
