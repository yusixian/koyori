import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, net, protocol, session, shell } from "electron";
import { createGitBackupStore } from "../../../../packages/core/src/git-backup";
import { createAgentController } from "./agent-controller";
import { createManagementController } from "./management-controller";
import { createRemoteBackupController } from "./remote-backup-controller";
import { createServicesController } from "./services-controller";
import { createUpdateController, prepareUpdateInstallation } from "./update-controller";
import { createUsageController } from "./usage-controller";
import { createWorkspaceController } from "./workspace-controller";

protocol.registerSchemesAsPrivileged([
  { scheme: "koyori", privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);
const dataDirectory = app.commandLine.getSwitchValue("user-data-dir");
if (dataDirectory && isAbsolute(dataDirectory)) app.setPath("userData", dataDirectory);
const rendererRoot = resolve(import.meta.dirname, "../renderer");
const devURL = app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL;
let window: BrowserWindow | undefined;
let workspace: Awaited<ReturnType<typeof createWorkspaceController>> | undefined;
let usage: Awaited<ReturnType<typeof createUsageController>> | undefined;
let management: Awaited<ReturnType<typeof createManagementController>> | undefined;
let remoteBackup: Awaited<ReturnType<typeof createRemoteBackupController>> | undefined;
let agent: Awaited<ReturnType<typeof createAgentController>> | undefined;
let updater: ReturnType<typeof createUpdateController> | undefined;
let agentShutdown: Promise<void> | undefined;
let agentStopped = false;
let installationGate = false;
let refreshTimer: ReturnType<typeof setInterval> | undefined;
let stopped = false;
function changed() {
  if (window && !window.isDestroyed()) window.webContents.send("workspace:changed");
}
function agentChanged() {
  if (window && !window.isDestroyed()) window.webContents.send("agent:changed");
}
function updateChanged() {
  if (window && !window.isDestroyed()) window.webContents.send("update:changed");
}
async function refresh() {
  if (
    stopped ||
    installationGate ||
    workspace?.isBusy() ||
    usage?.isBusy() ||
    management?.isBusy() ||
    remoteBackup?.isBusy()
  )
    return;
  try {
    await workspace?.refresh();
    if (!stopped && !installationGate) await usage?.refreshAutomatic();
    if (!stopped && !installationGate) await remoteBackup?.tick();
  } catch {
    // Each controller retains a user-visible failure while preserving previous data.
    changed();
  }
}
function trustedWindow(event: Electron.IpcMainInvokeEvent) {
  if (
    !window ||
    event.sender !== window.webContents ||
    event.senderFrame !== window.webContents.mainFrame
  ) {
    throw new Error("Unauthorized window");
  }
  const url = new URL(event.senderFrame.url);
  if (
    devURL
      ? url.origin !== new URL(devURL).origin
      : url.protocol !== "koyori:" || url.host !== "app"
  ) {
    throw new Error("Unauthorized origin");
  }
}
function trusted(event: Electron.IpcMainInvokeEvent) {
  trustedWindow(event);
  if (installationGate) throw new Error("正在准备安装更新，暂时不能开始新操作。");
}
async function prepareUpdateInstall() {
  return prepareUpdateInstallation({
    enter: () => {
      if (installationGate) return false;
      installationGate = true;
      return true;
    },
    leave: () => {
      installationGate = false;
    },
    isBusy: () =>
      Boolean(
        workspace?.isBusy() ||
          usage?.isBusy() ||
          management?.isBusy() ||
          remoteBackup?.isBusy() ||
          agent?.isBusy(),
      ),
    stopAgent: async () => {
      await agent?.stop();
    },
    markAgentStopped: () => {
      agentStopped = true;
    },
  });
}
function registerIpc() {
  ipcMain.handle("project:open", async (event) => {
    trusted(event);
    await shell.openExternal("https://github.com/yusixian/koyori");
  });
}
function createWindow() {
  window = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 920,
    minHeight: 620,
    title: "Koyori",
    backgroundColor: "#faf7f5",
    titleBarStyle: "hiddenInset",
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.on("closed", () => {
    workspace?.cancel();
    usage?.cancel();
    management?.cancel();
    remoteBackup?.cancel();
    void agent?.cancel().catch(() => agentChanged());
    window = undefined;
  });
  if (devURL) void window.loadURL(devURL);
  else void window.loadURL("koyori://app/index.html");
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    if (window?.isMinimized()) window.restore();
    window?.focus();
  });
  void app
    .whenReady()
    .then(async () => {
      const dataDir = app.getPath("userData");
      try {
        const updatesEnabled =
          app.isPackaged &&
          process.platform === "darwin" &&
          process.arch === "arm64" &&
          existsSync(join(process.resourcesPath, "app-update.yml"));
        updater = createUpdateController({
          currentVersion: __APP_VERSION__,
          enabled: updatesEnabled,
          automatic: updatesEnabled && !app.commandLine.hasSwitch("disable-auto-update-check"),
          trusted: trustedWindow,
          changed: updateChanged,
          prepareInstall: prepareUpdateInstall,
        });
        agent = await createAgentController({
          path: join(dataDir, "agent.json"),
          trusted,
          changed: agentChanged,
        });
        await createServicesController({
          path: join(dataDir, "services.json"),
          trusted,
          openExternal: (url) => shell.openExternal(url),
        });
        workspace = await createWorkspaceController({
          path: join(dataDir, "sources.json"),
          home: homedir(),
          codexHome: process.env.CODEX_HOME,
          claudeConfigDir: process.env.CLAUDE_CONFIG_DIR,
          getWindow: () => window,
          resourceBusy: () =>
            Boolean(usage?.isBusy() || management?.isBusy() || remoteBackup?.isBusy()),
          observe: async (inventory) => {
            await usage?.observe(inventory);
          },
          trusted,
          changed,
        });
        usage = await createUsageController({
          path: join(dataDir, "usage.json"),
          getRoots: () => workspace?.getRoots() ?? [],
          getInventory: () => workspace?.getInventory() ?? null,
          getCandidates: () => workspace?.getCandidates() ?? [],
          getWindow: () => window,
          resourceBusy: () =>
            Boolean(workspace?.isBusy() || management?.isBusy() || remoteBackup?.isBusy()),
          trusted,
          changed,
        });
        management = await createManagementController({
          dataDirectory: join(dataDir, "management"),
          transferRoots: [join(dataDir, "remote-backup", "exports"), join(dataDir, "git-backup")],
          getRoots: () => workspace?.getRoots() ?? [],
          getTargets: () => workspace?.getTargets() ?? [],
          getProjects: () => workspace?.getProjects() ?? [],
          getInventory: () => workspace?.getInventory() ?? null,
          resourceBusy: () =>
            Boolean(workspace?.isBusy() || usage?.isBusy() || remoteBackup?.isBusy()),
          refresh: async () => {
            await workspace?.refresh();
          },
          trusted,
          changed,
        });
        remoteBackup = await createRemoteBackupController({
          dataDirectory: join(dataDir, "remote-backup"),
          git: await createGitBackupStore(join(dataDir, "git-backup")),
          management: management.store,
          getRoots: () => workspace?.getRoots() ?? [],
          getInventory: () => workspace?.getInventory() ?? null,
          resourceBusy: () =>
            Boolean(workspace?.isBusy() || usage?.isBusy() || management?.isBusy()),
          trusted,
          changed,
        });
      } catch {
        dialog.showErrorBox(
          "无法读取工作台数据",
          "原文件仍保留在本机。请备份并检查应用数据目录；应用不会覆盖无法识别的设置或记录。",
        );
        app.quit();
        return;
      }
      session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) =>
        callback(false),
      );
      session.defaultSession.setPermissionCheckHandler(() => false);
      protocol.handle("koyori", async (request) => {
        const url = new URL(request.url);
        if (url.host !== "app" || request.method !== "GET")
          return new Response(null, { status: 403 });
        let path: string;
        try {
          path = resolve(rendererRoot, `.${decodeURIComponent(url.pathname)}`);
        } catch {
          return new Response(null, { status: 400 });
        }
        if (!path.startsWith(`${rendererRoot}${sep}`)) return new Response(null, { status: 403 });
        try {
          return await net.fetch(pathToFileURL(path).href);
        } catch {
          return new Response(null, { status: 404 });
        }
      });
      registerIpc();
      createWindow();
      updater.start();
      void refresh();
      refreshTimer = setInterval(() => {
        void refresh();
      }, 30_000);
      refreshTimer.unref();
      app.on("activate", () => {
        if (!window) createWindow();
      });
    })
    .catch(() => {
      dialog.showErrorBox("启动失败", "无法初始化工作台。请检查应用数据目录的读写权限。");
      app.quit();
    });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  app.on("before-quit", (event) => {
    stopped = true;
    updater?.stop();
    remoteBackup?.stop();
    clearInterval(refreshTimer);
    workspace?.cancel();
    usage?.cancel();
    management?.cancel();
    if (agent && !agentStopped) {
      event.preventDefault();
      if (agentShutdown) return;
      agentShutdown = agent.stop().then(
        () => {
          agentStopped = true;
          app.quit();
        },
        () => {
          dialog.showErrorBox(
            "会话保存失败",
            "请保留应用数据目录。未完成的回复将在下次启动时标记为中断。",
          );
          agentStopped = true;
          app.quit();
        },
      );
    }
  });
}
