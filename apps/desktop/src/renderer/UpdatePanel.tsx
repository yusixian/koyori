import { ChevronDown, Download, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import type { UpdateView } from "../bridge";

function statusText(view: UpdateView): string {
  switch (view.status) {
    case "idle":
      return "尚未检查更新。";
    case "checking":
      return "正在检查更新…";
    case "current":
      return "当前已是这个渠道的最新版本。";
    case "available":
      return `发现新版本 v${view.latestVersion}。`;
    case "downloading":
      return `正在下载 v${view.latestVersion}${view.progress ? ` · ${Math.round(view.progress.percent)}%` : ""}`;
    case "cancelling":
      return "正在取消下载…";
    case "cancelled":
      return view.message ?? "下载已取消。";
    case "ready":
      return view.message ?? `v${view.latestVersion} 已下载，可以重启安装。`;
    case "installing":
      return view.message ?? "正在安全退出并安装新版…";
    case "download-error":
      return view.message ?? "新版下载或校验失败，请稍后重试。";
    case "install-error":
      return view.message ?? "安装没有启动，请重新启动 Koyori 后再试。";
    case "unsupported":
      return view.message ?? "当前环境不支持应用内更新。";
    case "error":
      return view.message ?? "更新没有完成，请稍后重试。";
  }
}

function summaryText(view: UpdateView | null): string {
  if (!view) return `v${__APP_VERSION__}`;
  if (view.status === "ready") return "新版已下载";
  if (view.status === "downloading")
    return view.progress ? `${Math.round(view.progress.percent)}%` : "下载中";
  if (view.latestVersion && ["available", "cancelled", "download-error"].includes(view.status))
    return "发现新版";
  return `v${view.currentVersion}`;
}

export function UpdatePanel() {
  const [view, setView] = useState<UpdateView | null>(null);
  const [actionError, setActionError] = useState("");

  useEffect(() => {
    let disposed = false;
    const update = () => {
      void window.koyori
        .getUpdate()
        .then((next) => {
          if (!disposed) {
            setView(next);
            setActionError("");
          }
        })
        .catch(() => {
          if (!disposed) setActionError("无法读取更新状态，请稍后重试。");
        });
    };
    update();
    const unsubscribe = window.koyori.onUpdateChanged(update);
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);

  const checking = view?.status === "checking";
  const locked =
    view?.status === "downloading" ||
    view?.status === "cancelling" ||
    view?.status === "installing";
  async function check() {
    setActionError("");
    try {
      setView(await window.koyori.checkForUpdate());
    } catch {
      setActionError("暂时无法检查更新，请稍后重试。");
    }
  }
  async function download() {
    setActionError("");
    try {
      setView(await window.koyori.downloadUpdate());
    } catch {
      setActionError("新版没有开始下载，请重新检查后再试。");
    }
  }
  async function cancelDownload() {
    setActionError("");
    try {
      setView(await window.koyori.cancelUpdateDownload());
    } catch {
      setActionError("无法取消下载，请稍后再试。");
    }
  }
  async function install() {
    setActionError("");
    try {
      setView(await window.koyori.installUpdate());
    } catch {
      setActionError("无法开始安装，请稍后再试。");
    }
  }

  return (
    <details className="update-panel">
      <summary>
        <span>
          <Download size={15} />
          更新
        </span>
        <span className="update-version">{summaryText(view)}</span>
        <ChevronDown className="update-chevron" size={14} />
      </summary>
      <div className="update-body">
        <p className="update-status" aria-live="polite">
          {view ? statusText(view) : "正在读取更新状态…"}
        </p>
        {view?.status === "available" && (
          <p>下载由 Koyori 完成。开始安装前会先确认当前任务已结束并保存 Agent 数据。</p>
        )}
        {view?.status === "downloading" && view.progress && (
          <progress max={100} value={view.progress.percent} aria-label="新版下载进度" />
        )}
        {actionError && (
          <p className="update-error" role="alert">
            {actionError}
          </p>
        )}
        <div className="update-actions">
          {view && ["available", "cancelled", "download-error"].includes(view.status) && (
            <button type="button" onClick={() => void download()}>
              下载新版
            </button>
          )}
          {view?.status === "downloading" && (
            <button type="button" onClick={() => void cancelDownload()}>
              取消下载
            </button>
          )}
          {view?.status === "ready" && (
            <button type="button" onClick={() => void install()}>
              重启并安装
            </button>
          )}
          {view &&
            [
              "idle",
              "checking",
              "current",
              "available",
              "cancelled",
              "download-error",
              "error",
            ].includes(view.status) && (
              <button type="button" disabled={checking || locked} onClick={() => void check()}>
                <RefreshCw className={checking ? "spinning" : undefined} size={13} />
                {checking ? "检查中…" : "检查更新"}
              </button>
            )}
        </div>
      </div>
    </details>
  );
}
