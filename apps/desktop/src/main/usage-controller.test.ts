import type {
  ResourceRoot,
  SkillInventory,
  UsageEvent,
  UsageImport,
  UsageState,
  UsageView,
} from "@koyori/core";
import { createUsageState } from "@koyori/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type IpcHandler = (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown;
type WorkerListener = (...args: unknown[]) => void;

interface WorkerDouble {
  emit(event: string, ...args: unknown[]): void;
  terminate(): Promise<number>;
}

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
  workers: [] as WorkerDouble[],
  readUsageState: vi.fn(),
  writeUsageState: vi.fn(),
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

    constructor(_filename: URL, _options: unknown) {
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

function dependencies(getRoots: () => ResourceRoot[], trusted = vi.fn()) {
  return {
    path: "/fixtures/user-data/usage.json",
    getRoots,
    getInventory: () => inventory,
    getWindow: () => undefined,
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
    worker.emit("message", imported);
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
});
