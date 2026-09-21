import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import type { ResourceRoot, SkillInventory } from "@koyori/core";
import { app, BrowserWindow, dialog, ipcMain, net, protocol, session, shell } from "electron";

protocol.registerSchemesAsPrivileged([
  { scheme: "koyori", privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);
const dataDirectory = app.commandLine.getSwitchValue("user-data-dir");
if (dataDirectory && isAbsolute(dataDirectory)) app.setPath("userData", dataDirectory);
const rendererRoot = resolve(import.meta.dirname, "../renderer");
const devURL = app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL;
let window: BrowserWindow | undefined;
let roots: ResourceRoot[] = [];
let activeScan: AbortController | undefined;
let settingsPath: string;

function isRoot(value: unknown): value is ResourceRoot {
  if (!value || typeof value !== "object") return false;
  return (
    "id" in value &&
    typeof value.id === "string" &&
    "client" in value &&
    (value.client === "claude-code" || value.client === "codex") &&
    "path" in value &&
    typeof value.path === "string" &&
    isAbsolute(value.path) &&
    "label" in value &&
    typeof value.label === "string"
  );
}
async function persist(next: ResourceRoot[]) {
  await mkdir(dirname(settingsPath), { recursive: true });
  const temporary = `${settingsPath}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify({ version: 1, roots: next }, null, 2), { mode: 0o600 });
  await rename(temporary, settingsPath);
  roots = next;
}
function trusted(event: Electron.IpcMainInvokeEvent) {
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
function registerIpc() {
  ipcMain.handle("roots:list", (event) => {
    trusted(event);
    return roots;
  });
  let changingRoots = false;
  ipcMain.handle("roots:add", async (event, client: unknown) => {
    trusted(event);
    if (client !== "claude-code" && client !== "codex") throw new Error("Unsupported client");
    if (!window || changingRoots || activeScan) throw new Error("An operation is in progress");
    changingRoots = true;
    try {
      const result = await dialog.showOpenDialog(window, {
        title: "选择要读取的 Skills 目录",
        properties: ["openDirectory"],
      });
      const path = result.filePaths[0];
      if (result.canceled || !path) return null;
      const existing = roots.find((root) => root.path === path && root.client === client);
      if (existing) return existing;
      const root: ResourceRoot = { id: randomUUID(), client, path, label: basename(path) || path };
      await persist([...roots, root]);
      return root;
    } finally {
      changingRoots = false;
    }
  });
  ipcMain.handle("roots:remove", async (event, id: unknown) => {
    trusted(event);
    if (typeof id !== "string" || changingRoots || activeScan)
      throw new Error("Cannot remove this source now");
    changingRoots = true;
    try {
      await persist(roots.filter((root) => root.id !== id));
      return roots;
    } finally {
      changingRoots = false;
    }
  });
  ipcMain.handle("skills:scan", async (event) => {
    trusted(event);
    if (activeScan || changingRoots) throw new Error("An operation is in progress");
    const controller = new AbortController();
    activeScan = controller;
    try {
      return await new Promise<SkillInventory>((resolveScan, reject) => {
        const worker = new Worker(new URL("./scan-worker.js", import.meta.url), {
          workerData: roots,
        });
        let settled = false;
        const finish = () => {
          settled = true;
          controller.signal.removeEventListener("abort", cancel);
          void worker.terminate();
        };
        const cancel = () => {
          finish();
          reject(new Error("Scan cancelled"));
        };
        controller.signal.addEventListener("abort", cancel, { once: true });
        worker.once("message", (result: SkillInventory) => {
          finish();
          resolveScan(result);
        });
        worker.once("error", () => {
          finish();
          reject(new Error("Scan failed"));
        });
        worker.once("exit", () => {
          if (!settled) {
            finish();
            reject(new Error("Scan interrupted"));
          }
        });
      });
    } finally {
      activeScan = undefined;
    }
  });
  ipcMain.handle("skills:cancel", (event) => {
    trusted(event);
    activeScan?.abort();
  });
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
    activeScan?.abort();
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
      settingsPath = join(app.getPath("userData"), "sources.json");
      try {
        const state: unknown = JSON.parse(await readFile(settingsPath, "utf8"));
        if (
          !state ||
          typeof state !== "object" ||
          !("version" in state) ||
          state.version !== 1 ||
          !("roots" in state) ||
          !Array.isArray(state.roots) ||
          !state.roots.every(isRoot)
        )
          throw new Error("Invalid source settings");
        roots = state.roots;
      } catch (error) {
        if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
          dialog.showErrorBox(
            "无法读取来源设置",
            "设置文件仍保留在本机，请先备份并检查。应用不会覆盖无法识别的设置。",
          );
          app.quit();
          return;
        }
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
  app.on("before-quit", () => activeScan?.abort());
}
