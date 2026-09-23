import type {
  ProgressInfo,
  UpdateCheckResult,
  UpdateDownloadedEvent,
  UpdateInfo,
} from "electron-updater";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { UpdateView } from "../bridge";
import {
  createUpdateController,
  prepareUpdateInstallation,
  type UpdateDriver,
} from "./update-controller";

type Handler = (event: unknown) => unknown;
const mocks = vi.hoisted(() => ({ handlers: new Map<string, Handler>() }));
vi.mock("electron", () => ({
  ipcMain: { handle: (name: string, handler: Handler) => mocks.handlers.set(name, handler) },
}));
vi.mock("electron-updater", () => ({
  default: {
    autoUpdater: {},
    CancellationToken: class {
      cancelled = false;
      cancel() {
        this.cancelled = true;
      }
    },
  },
}));

function deferred<Value>() {
  let resolve: (value: Value) => void = () => {};
  let reject: (reason?: unknown) => void = () => {};
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const release: UpdateInfo = {
  version: "0.1.0-alpha.2",
  files: [{ url: "Koyori.zip", sha512: "checksum" }],
  path: "Koyori.zip",
  sha512: "checksum",
  releaseDate: "2026-09-22T12:00:00.000Z",
};

class FakeUpdater implements UpdateDriver {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  allowPrerelease = false;
  allowDowngrade = true;
  disableDifferentialDownload = false;
  channel: string | null = null;
  checkCalls = 0;
  downloadCalls = 0;
  installCalls = 0;
  checkResult: Promise<UpdateCheckResult | null> = Promise.resolve(null);
  downloadResult: Promise<string[]> = Promise.resolve([]);
  private listeners: Parameters<UpdateDriver["subscribe"]>[0] | null = null;

  subscribe(listeners: Parameters<UpdateDriver["subscribe"]>[0]) {
    this.listeners = listeners;
    return () => {
      this.listeners = null;
    };
  }
  checkForUpdates() {
    this.checkCalls += 1;
    return this.checkResult;
  }
  downloadUpdate() {
    this.downloadCalls += 1;
    return this.downloadResult;
  }
  quitAndInstall() {
    this.installCalls += 1;
  }
  available(info: UpdateInfo = release) {
    this.listeners?.["update-available"](info);
  }
  progress(info: ProgressInfo) {
    this.listeners?.["download-progress"](info);
  }
  downloaded(info: UpdateDownloadedEvent) {
    this.listeners?.["update-downloaded"](info);
  }
  fail(error: Error) {
    this.listeners?.error(error);
  }
}

beforeEach(() => {
  mocks.handlers.clear();
});
afterEach(() => vi.useRealTimers());

async function invoke(channel: string): Promise<UpdateView> {
  const handler = mocks.handlers.get(channel);
  if (!handler) throw new Error(`Missing handler: ${channel}`);
  const value: unknown = await handler({});
  if (!isUpdateView(value)) throw new Error(`Invalid update view from ${channel}`);
  return value;
}

function isUpdateView(value: unknown): value is UpdateView {
  return (
    value !== null &&
    typeof value === "object" &&
    "status" in value &&
    typeof value.status === "string" &&
    "currentVersion" in value &&
    typeof value.currentVersion === "string"
  );
}

function fixture(
  options: {
    updater?: FakeUpdater;
    automatic?: boolean;
    enabled?: boolean;
    prepareInstall?: () => Promise<{ ready: boolean; message?: string; terminal?: boolean }>;
  } = {},
) {
  const updater = options.updater ?? new FakeUpdater();
  const changed = vi.fn();
  const trusted = vi.fn();
  const prepareInstall = options.prepareInstall ?? vi.fn(async () => ({ ready: true }));
  const controller = createUpdateController({
    currentVersion: "0.1.0-alpha.1",
    enabled: options.enabled ?? true,
    automatic: options.automatic ?? false,
    updater,
    changed,
    trusted,
    prepareInstall,
    clock: { now: () => new Date("2026-09-22T12:30:00.000Z"), setTimeout, clearTimeout },
  });
  return { controller, updater, changed, trusted, prepareInstall };
}

it("configures the alpha updater and merges repeated checks", async () => {
  const updater = new FakeUpdater();
  const pending = deferred<UpdateCheckResult | null>();
  updater.checkResult = pending.promise;
  const setup = fixture({ updater });

  const first = invoke("update:check");
  const second = invoke("update:check");
  expect(updater.checkCalls).toBe(1);
  expect(updater.autoDownload).toBe(false);
  expect(updater.autoInstallOnAppQuit).toBe(false);
  expect(updater.allowPrerelease).toBe(true);
  expect(updater.channel).toBe("alpha");
  expect(updater.allowDowngrade).toBe(false);
  expect(updater.disableDifferentialDownload).toBe(true);

  updater.available();
  pending.resolve({ isUpdateAvailable: true, updateInfo: release, versionInfo: release });
  await expect(first).resolves.toMatchObject({
    status: "available",
    latestVersion: release.version,
  });
  await expect(second).resolves.toMatchObject({ status: "available" });
  expect(setup.trusted).toHaveBeenCalledTimes(2);
  setup.controller.stop();
});

it("reports download progress, cancels once, and permits a later retry", async () => {
  const updater = new FakeUpdater();
  updater.checkResult = Promise.resolve({
    isUpdateAvailable: true,
    updateInfo: release,
    versionInfo: release,
  });
  const firstDownload = deferred<string[]>();
  updater.downloadResult = firstDownload.promise;
  const setup = fixture({ updater });
  await invoke("update:check");

  const first = invoke("update:download");
  const repeated = invoke("update:download");
  expect(updater.downloadCalls).toBe(1);
  updater.progress({ total: 100, delta: 25, transferred: 25, percent: 25, bytesPerSecond: 50 });
  await expect(invoke("update:get")).resolves.toMatchObject({
    status: "downloading",
    progress: { percent: 25, transferred: 25 },
  });
  await expect(invoke("update:download:cancel")).resolves.toMatchObject({ status: "cancelling" });
  updater.progress({ total: 100, delta: 25, transferred: 50, percent: 50, bytesPerSecond: 50 });
  await expect(invoke("update:get")).resolves.toMatchObject({ status: "cancelling" });
  firstDownload.reject(new Error("cancelled"));
  await expect(first).resolves.toMatchObject({ status: "cancelled" });
  await expect(repeated).resolves.toMatchObject({ status: "cancelled" });

  updater.downloadResult = Promise.resolve([]);
  await invoke("update:download");
  expect(updater.downloadCalls).toBe(2);
  setup.controller.stop();
});

it("blocks installation while work is active and merges repeated install clicks", async () => {
  const updater = new FakeUpdater();
  updater.checkResult = Promise.resolve({
    isUpdateAvailable: true,
    updateInfo: release,
    versionInfo: release,
  });
  const preparation = deferred<{ ready: boolean; message?: string }>();
  let preparationAttempts = 0;
  const prepareInstall = vi.fn(() => {
    preparationAttempts += 1;
    return preparationAttempts === 1 ? preparation.promise : Promise.resolve({ ready: true });
  });
  const setup = fixture({ updater, prepareInstall });
  await invoke("update:check");
  updater.downloaded({ ...release, downloadedFile: "/synthetic/Koyori.zip" });

  const installing = invoke("update:install");
  await expect(invoke("update:install")).resolves.toMatchObject({ status: "installing" });
  expect(prepareInstall).toHaveBeenCalledOnce();
  preparation.resolve({ ready: false, message: "请先等待当前任务结束。" });
  await expect(installing).resolves.toMatchObject({
    status: "ready",
    message: "请先等待当前任务结束。",
  });
  expect(updater.installCalls).toBe(0);

  await invoke("update:install");
  expect(prepareInstall).toHaveBeenCalledTimes(2);
  expect(updater.installCalls).toBe(1);
  setup.controller.stop();
});

it("closes the installation gate before waiting for Agent writes", async () => {
  let gate = false;
  const stopping = deferred<void>();
  const markAgentStopped = vi.fn();
  const dependencies = {
    enter: () => {
      if (gate) return false;
      gate = true;
      return true;
    },
    leave: () => {
      gate = false;
    },
    isBusy: () => false,
    stopAgent: () => stopping.promise,
    markAgentStopped,
  };

  const first = prepareUpdateInstallation(dependencies);
  expect(gate).toBe(true);
  await expect(prepareUpdateInstallation(dependencies)).resolves.toMatchObject({ ready: false });
  stopping.resolve();
  await expect(first).resolves.toEqual({ ready: true });
  expect(markAgentStopped).toHaveBeenCalledOnce();
});

it("keeps download failures retryable and stops after a terminal install failure", async () => {
  const updater = new FakeUpdater();
  updater.checkResult = Promise.resolve({
    isUpdateAvailable: true,
    updateInfo: release,
    versionInfo: release,
  });
  updater.downloadResult = Promise.reject(new Error("synthetic download failure"));
  const prepareInstall = vi.fn(async () => ({
    ready: false,
    terminal: true,
    message: "请重新启动 Koyori 后再试。",
  }));
  const setup = fixture({ updater, prepareInstall });
  await invoke("update:check");
  await expect(invoke("update:download")).resolves.toMatchObject({ status: "download-error" });

  updater.downloadResult = Promise.resolve([]);
  await invoke("update:download");
  expect(updater.downloadCalls).toBe(2);
  updater.downloaded({ ...release, downloadedFile: "/synthetic/Koyori.zip" });
  await expect(invoke("update:install")).resolves.toMatchObject({
    status: "install-error",
    message: "请重新启动 Koyori 后再试。",
  });
  expect(updater.installCalls).toBe(0);
  setup.controller.stop();
});

it("waits ten seconds before automatic checks and then schedules six hours", async () => {
  vi.useFakeTimers();
  const updater = new FakeUpdater();
  updater.checkResult = Promise.resolve({
    isUpdateAvailable: false,
    updateInfo: { ...release, version: "0.1.0-alpha.1" },
    versionInfo: { ...release, version: "0.1.0-alpha.1" },
  });
  const setup = fixture({ updater, automatic: true });
  setup.controller.start();
  await vi.advanceTimersByTimeAsync(9_999);
  expect(updater.checkCalls).toBe(0);
  await vi.advanceTimersByTimeAsync(1);
  expect(updater.checkCalls).toBe(1);
  await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1_000);
  expect(updater.checkCalls).toBe(2);
  setup.controller.stop();
});

it("preserves the stopped state when native verification fails after installation begins", async () => {
  const setup = fixture();
  setup.updater.downloaded({ ...release, downloadedFile: "/synthetic/Koyori.zip" });
  await expect(invoke("update:install")).resolves.toMatchObject({ status: "installing" });
  expect(setup.updater.installCalls).toBe(1);
  setup.updater.fail(new Error("synthetic native signature failure with private details"));
  await expect(invoke("update:get")).resolves.toMatchObject({
    status: "install-error",
    message: "安装没有启动。Koyori 已安全停止，请重新打开应用后再试。",
  });
  await expect(invoke("update:install")).rejects.toThrow("新版尚未下载完成");
  expect(setup.updater.installCalls).toBe(1);
  setup.controller.stop();
});

it("keeps development builds offline even when manually asked to check", async () => {
  const setup = fixture({ enabled: false, automatic: true });
  await expect(invoke("update:check")).resolves.toMatchObject({ status: "unsupported" });
  expect(setup.updater.checkCalls).toBe(0);
  setup.controller.start();
  expect(setup.updater.checkCalls).toBe(0);
  setup.controller.stop();
});
