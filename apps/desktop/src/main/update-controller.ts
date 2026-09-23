import { getReleaseChannel } from "@koyori/core";
import { ipcMain } from "electron";
import electronUpdater, {
  type ProgressInfo,
  type UpdateCheckResult,
  type UpdateDownloadedEvent,
  type UpdateInfo,
} from "electron-updater";
import type { UpdateView } from "../bridge";

const CHECK_DELAY_MS = 10_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1_000;

// electron-updater exposes autoUpdater through a CommonJS getter.
const { autoUpdater, CancellationToken } = electronUpdater;
type CancellationToken = InstanceType<typeof CancellationToken>;

type Timer = ReturnType<typeof setTimeout>;
type UpdateEvents = {
  error: (error: Error) => void;
  "checking-for-update": () => void;
  "update-not-available": (info: UpdateInfo) => void;
  "update-available": (info: UpdateInfo) => void;
  "download-progress": (info: ProgressInfo) => void;
  "update-downloaded": (info: UpdateDownloadedEvent) => void;
  "update-cancelled": (info: UpdateInfo) => void;
};

export interface UpdateDriver {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowPrerelease: boolean;
  allowDowngrade: boolean;
  disableDifferentialDownload: boolean;
  channel: string | null;
  subscribe(listeners: UpdateEvents): () => void;
  checkForUpdates(): Promise<UpdateCheckResult | null>;
  downloadUpdate(token: CancellationToken): Promise<string[]>;
  quitAndInstall(): void;
}

interface Clock {
  now(): Date;
  setTimeout(callback: () => void, delay: number): Timer;
  clearTimeout(timer: Timer): void;
}

interface InstallPreparation {
  ready: boolean;
  message?: string;
  terminal?: boolean;
}

interface InstallationGateDependencies {
  enter(): boolean;
  leave(): void;
  isBusy(): boolean;
  stopAgent(): Promise<void>;
  markAgentStopped(): void;
}

interface Dependencies {
  currentVersion: string;
  enabled: boolean;
  automatic: boolean;
  trusted(event: Electron.IpcMainInvokeEvent): void;
  changed(): void;
  prepareInstall(): Promise<InstallPreparation>;
  updater?: UpdateDriver;
  clock?: Clock;
}

const defaultClock: Clock = {
  now: () => new Date(),
  setTimeout,
  clearTimeout,
};

export async function prepareUpdateInstallation(
  deps: InstallationGateDependencies,
): Promise<InstallPreparation> {
  if (!deps.enter()) return { ready: false, message: "更新安装已经在准备中。" };
  if (deps.isBusy()) {
    deps.leave();
    return { ready: false, message: "请先等待当前任务结束，再重新安装新版。" };
  }
  try {
    await deps.stopAgent();
    deps.markAgentStopped();
    return { ready: true };
  } catch {
    return {
      ready: false,
      terminal: true,
      message: "当前数据没有安全保存。请重新启动 Koyori 后再试。",
    };
  }
}

export function createUpdateController(deps: Dependencies) {
  const updater = deps.updater ?? electronUpdateDriver();
  const clock = deps.clock ?? defaultClock;
  const channel = getReleaseChannel(deps.currentVersion);
  let state: UpdateView = {
    status: deps.enabled ? "idle" : "unsupported",
    currentVersion: deps.currentVersion,
    channel,
    checkedAt: null,
    latestVersion: null,
    publishedAt: null,
    progress: null,
    message: deps.enabled ? null : "更新仅在已配置更新源的 Apple Silicon Mac 安装包中可用。",
  };
  let availableInfo: UpdateInfo | null = null;
  let activeCheck: Promise<UpdateView> | null = null;
  let activeDownload: Promise<UpdateView> | null = null;
  let downloadToken: CancellationToken | null = null;
  let scheduledCheck: Timer | null = null;
  let stopped = false;

  function setState(next: UpdateView) {
    state = next;
    deps.changed();
    return state;
  }

  function withInfo(
    status: UpdateView["status"],
    info: UpdateInfo | null,
    message: string | null = null,
  ): UpdateView {
    return {
      status,
      currentVersion: deps.currentVersion,
      channel,
      checkedAt: clock.now().toISOString(),
      latestVersion: info?.version ?? null,
      publishedAt: info?.releaseDate ?? null,
      progress: null,
      message,
    };
  }

  const listeners: { [Event in keyof UpdateEvents]: UpdateEvents[Event] } = {
    error: () => {
      if (stopped || downloadToken?.cancelled) return;
      if (state.status === "installing") {
        setState(
          withInfo(
            "install-error",
            availableInfo,
            "安装没有启动。Koyori 已安全停止，请重新打开应用后再试。",
          ),
        );
        return;
      }
      const downloadFailed =
        activeDownload !== null ||
        state.status === "downloading" ||
        state.status === "download-error";
      setState(
        withInfo(
          downloadFailed ? "download-error" : "error",
          availableInfo,
          availableInfo
            ? "新版下载或校验失败，请稍后重试。"
            : "暂时无法检查更新，请确认网络连接后重试。",
        ),
      );
    },
    "checking-for-update": () => {
      if (!stopped) setState({ ...state, status: "checking", progress: null, message: null });
    },
    "update-not-available": (info) => {
      if (stopped) return;
      availableInfo = null;
      setState(withInfo("current", info));
    },
    "update-available": (info) => {
      if (stopped) return;
      availableInfo = info;
      setState(withInfo("available", info));
    },
    "download-progress": (progress) => {
      if (stopped || !availableInfo || downloadToken?.cancelled) return;
      setState({
        ...withInfo("downloading", availableInfo),
        progress: {
          percent: Math.max(0, Math.min(100, progress.percent)),
          transferred: Math.max(0, progress.transferred),
          total: Math.max(0, progress.total),
          bytesPerSecond: Math.max(0, progress.bytesPerSecond),
        },
      });
    },
    "update-downloaded": (info) => {
      if (stopped || downloadToken?.cancelled) return;
      availableInfo = info;
      downloadToken = null;
      setState(withInfo("ready", info));
    },
    "update-cancelled": (info) => {
      if (stopped) return;
      availableInfo = info;
      downloadToken = null;
      setState(withInfo("cancelled", info, "下载已取消，可以稍后重新下载。"));
    },
  };

  let unsubscribe = () => {};
  if (deps.enabled) {
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.allowPrerelease = channel === "preview";
    updater.channel = channel === "preview" ? "alpha" : "latest";
    updater.allowDowngrade = false;
    updater.disableDifferentialDownload = true;
    unsubscribe = updater.subscribe(listeners);
  }

  function check(): Promise<UpdateView> {
    if (
      !deps.enabled ||
      stopped ||
      activeDownload ||
      ["ready", "installing", "install-error"].includes(state.status)
    ) {
      return Promise.resolve(state);
    }
    if (activeCheck) return activeCheck;
    setState({ ...state, status: "checking", progress: null, message: null });
    const checking = updater
      .checkForUpdates()
      .then((result) => {
        if (!result || stopped) return state;
        if (result.isUpdateAvailable) {
          availableInfo = result.updateInfo;
          if (state.status === "checking") setState(withInfo("available", result.updateInfo));
        } else if (state.status === "checking") {
          availableInfo = null;
          setState(withInfo("current", result.updateInfo));
        }
        return state;
      })
      .catch(() => {
        if (!stopped) setState(withInfo("error", null, "暂时无法检查更新，请确认网络连接后重试。"));
        return state;
      })
      .finally(() => {
        if (activeCheck === checking) activeCheck = null;
      });
    activeCheck = checking;
    return checking;
  }

  function download(): Promise<UpdateView> {
    if (!deps.enabled || stopped) return Promise.resolve(state);
    if (activeDownload) return activeDownload;
    if (!availableInfo || !["available", "cancelled", "download-error"].includes(state.status)) {
      return Promise.reject(new Error("请先检查并确认有可用的新版本。"));
    }
    const token = new CancellationToken();
    downloadToken = token;
    setState({ ...withInfo("downloading", availableInfo), progress: null });
    const downloading = updater
      .downloadUpdate(token)
      .then(() => {
        if (!stopped && token.cancelled) {
          setState(withInfo("cancelled", availableInfo, "下载已取消，可以稍后重新下载。"));
        }
        return state;
      })
      .catch(() => {
        if (stopped) return state;
        if (token.cancelled) {
          setState(withInfo("cancelled", availableInfo, "下载已取消，可以稍后重新下载。"));
        } else {
          setState(withInfo("download-error", availableInfo, "新版下载或校验失败，请稍后重试。"));
        }
        return state;
      })
      .finally(() => {
        if (downloadToken === token) downloadToken = null;
        if (activeDownload === downloading) activeDownload = null;
      });
    activeDownload = downloading;
    return downloading;
  }

  function cancelDownload(): UpdateView {
    downloadToken?.cancel();
    if (state.status === "downloading") {
      setState(withInfo("cancelling", availableInfo, "正在取消下载…"));
    }
    return state;
  }

  async function install(): Promise<UpdateView> {
    if (state.status === "installing") return state;
    if (state.status !== "ready" || !availableInfo) {
      throw new Error("新版尚未下载完成。");
    }
    if (scheduledCheck) clock.clearTimeout(scheduledCheck);
    scheduledCheck = null;
    setState({ ...state, status: "installing", message: "正在安全退出并安装新版…" });
    try {
      const preparation = await deps.prepareInstall();
      if (!preparation.ready) {
        return setState({
          ...state,
          status: preparation.terminal ? "install-error" : "ready",
          message: preparation.message ?? "请等待当前任务完成后再安装。",
        });
      }
    } catch {
      return setState({
        ...state,
        status: "ready",
        message: "无法安全保存当前数据，请重试或重新启动 Koyori。",
      });
    }
    try {
      updater.quitAndInstall();
    } catch {
      return setState({
        ...state,
        status: "install-error",
        message: "安装没有启动。Koyori 已安全停止，请重新打开应用后再试。",
      });
    }
    return state;
  }

  function schedule(delay: number) {
    if (stopped || !deps.automatic) return;
    if (scheduledCheck) clock.clearTimeout(scheduledCheck);
    scheduledCheck = clock.setTimeout(() => {
      scheduledCheck = null;
      void check().finally(() => schedule(CHECK_INTERVAL_MS));
    }, delay);
    (scheduledCheck as Timer & { unref?: () => void }).unref?.();
  }

  ipcMain.handle("update:get", (event) => {
    deps.trusted(event);
    return state;
  });
  ipcMain.handle("update:check", (event) => {
    deps.trusted(event);
    return check();
  });
  ipcMain.handle("update:download", (event) => {
    deps.trusted(event);
    return download();
  });
  ipcMain.handle("update:download:cancel", (event) => {
    deps.trusted(event);
    return cancelDownload();
  });
  ipcMain.handle("update:install", (event) => {
    deps.trusted(event);
    return install();
  });

  return {
    getView: () => state,
    check,
    start: () => schedule(CHECK_DELAY_MS),
    stop() {
      stopped = true;
      downloadToken?.cancel();
      if (scheduledCheck) clock.clearTimeout(scheduledCheck);
      scheduledCheck = null;
      unsubscribe();
    },
  };
}

function electronUpdateDriver(): UpdateDriver {
  return {
    get autoDownload() {
      return autoUpdater.autoDownload;
    },
    set autoDownload(value) {
      autoUpdater.autoDownload = value;
    },
    get autoInstallOnAppQuit() {
      return autoUpdater.autoInstallOnAppQuit;
    },
    set autoInstallOnAppQuit(value) {
      autoUpdater.autoInstallOnAppQuit = value;
    },
    get allowPrerelease() {
      return autoUpdater.allowPrerelease;
    },
    set allowPrerelease(value) {
      autoUpdater.allowPrerelease = value;
    },
    get allowDowngrade() {
      return autoUpdater.allowDowngrade;
    },
    set allowDowngrade(value) {
      autoUpdater.allowDowngrade = value;
    },
    get disableDifferentialDownload() {
      return autoUpdater.disableDifferentialDownload;
    },
    set disableDifferentialDownload(value) {
      autoUpdater.disableDifferentialDownload = value;
    },
    get channel() {
      return autoUpdater.channel;
    },
    set channel(value) {
      autoUpdater.channel = value;
    },
    subscribe(listeners) {
      autoUpdater.on("error", listeners.error);
      autoUpdater.on("checking-for-update", listeners["checking-for-update"]);
      autoUpdater.on("update-not-available", listeners["update-not-available"]);
      autoUpdater.on("update-available", listeners["update-available"]);
      autoUpdater.on("download-progress", listeners["download-progress"]);
      autoUpdater.on("update-downloaded", listeners["update-downloaded"]);
      autoUpdater.on("update-cancelled", listeners["update-cancelled"]);
      return () => {
        autoUpdater.removeListener("error", listeners.error);
        autoUpdater.removeListener("checking-for-update", listeners["checking-for-update"]);
        autoUpdater.removeListener("update-not-available", listeners["update-not-available"]);
        autoUpdater.removeListener("update-available", listeners["update-available"]);
        autoUpdater.removeListener("download-progress", listeners["download-progress"]);
        autoUpdater.removeListener("update-downloaded", listeners["update-downloaded"]);
        autoUpdater.removeListener("update-cancelled", listeners["update-cancelled"]);
      };
    },
    checkForUpdates: () => autoUpdater.checkForUpdates(),
    downloadUpdate: (token) => autoUpdater.downloadUpdate(token),
    quitAndInstall: () => autoUpdater.quitAndInstall(),
  };
}
