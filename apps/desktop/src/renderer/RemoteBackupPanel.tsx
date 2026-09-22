import { CloudUpload, Download, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { BackupItemView, RemoteBackupView } from "../bridge";

const states = {
  "local-only": "仅保存在本机",
  pending: "等待上传",
  verified: "远端已核验",
  failed: "上传未完成",
  unknown: "远端状态待核验",
};

export function RemoteBackupPanel({
  selectedSkillIds,
  backups,
}: {
  selectedSkillIds: string[];
  backups: BackupItemView[];
}) {
  const [view, setView] = useState<RemoteBackupView | null>(null);
  const [remote, setRemote] = useState("");
  const [snapshotId, setSnapshotId] = useState("");
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const requestIdRef = useRef(0);
  const selectedSnapshot = backups.find((backup) => backup.id === snapshotId) ?? backups[0];
  const reviewScope = JSON.stringify([selectedSkillIds, selectedSnapshot?.id, view?.remote]);
  useEffect(() => {
    let disposed = false;
    const update = () => {
      const requestId = ++requestIdRef.current;
      void window.koyori
        .getRemoteBackup()
        .then((next) => {
          if (!disposed && requestId === requestIdRef.current) setView(next);
        })
        .catch(() => {
          if (!disposed && requestId === requestIdRef.current) setError("无法读取远端备份状态。");
        });
    };
    update();
    const unsubscribe = window.koyori.onWorkspaceChanged(update);
    return () => {
      disposed = true;
      requestIdRef.current += 1;
      unsubscribe();
    };
  }, []);
  useEffect(() => {
    void reviewScope;
    setReviewed(false);
  }, [reviewScope]);
  async function run(action: () => Promise<RemoteBackupView>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const next = await action();
      requestIdRef.current += 1;
      setView(next);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message.replace(/^Error invoking remote method '[^']+': Error: /, "")
          : "操作未完成，本地快照仍保留。",
      );
    } finally {
      setBusy(false);
    }
  }
  const disabled = busy || view?.busy === true;
  return (
    <section className="management-card" aria-label="Git 远端备份">
      <div className="section-title">
        <h2>再保存到自己的 Git 仓库</h2>
        <span>{view ? states[view.state] : "读取状态…"}</span>
      </div>
      <p className="management-hint">
        本地快照可以独立使用。连接远端后，可上传副本或取回历史；取回后仍需在上方预览恢复。
      </p>
      {error && (
        <p role="alert" className="notice error">
          {error}
        </p>
      )}
      {view?.lastError && !error && (
        <p role="alert" className="notice error">
          {view.lastError}
        </p>
      )}
      {notice && (
        <p role="status" className="notice">
          {notice}
        </p>
      )}
      {view?.configured ? (
        <div className="management-actions">
          <code className="management-path">{view.remote}</code>
          <button
            type="button"
            className="text-button"
            disabled={disabled}
            onClick={() => void run(() => window.koyori.disconnectRemoteBackup())}
          >
            断开远端
          </button>
        </div>
      ) : (
        <div className="remote-connect">
          <label className="management-field">
            备份仓库地址
            <input
              value={remote}
              aria-label="备份仓库地址"
              placeholder="git@github.com:your-name/skills-backup.git"
              onChange={(event) => {
                setRemote(event.target.value);
                setReviewed(false);
              }}
            />
          </label>
          <p className="management-hint">
            私有仓库使用已配置的 SSH 身份；HTTPS 当前支持无需认证的远端。地址中不要填写密码或
            Token。连接不会上传文件。
          </p>
          <button
            className="button"
            type="button"
            disabled={disabled || !remote.trim()}
            onClick={() => void run(() => window.koyori.connectRemoteBackup(remote.trim()))}
          >
            连接备份仓库
          </button>
        </div>
      )}
      {view?.configured && (
        <>
          <label className="management-field">
            要上传的本地快照
            <select
              aria-label="要上传的本地快照"
              value={selectedSnapshot?.id ?? ""}
              disabled={disabled}
              onChange={(event) => {
                setSnapshotId(event.target.value);
                setReviewed(false);
              }}
            >
              {backups.map((backup) => (
                <option value={backup.id} key={backup.id}>
                  {new Date(backup.createdAt).toLocaleString("zh-CN")} · {backup.entries.length} 项
                </option>
              ))}
            </select>
          </label>
          {selectedSnapshot && (
            <p className="management-hint">
              包含：{selectedSnapshot.entries.map((entry) => entry.name).join("、")}
            </p>
          )}
          <label className="management-check">
            <input
              type="checkbox"
              disabled={disabled}
              checked={reviewed}
              onChange={(event) => setReviewed(event.target.checked)}
            />
            已检查目录内容，同意将完整 Skill 文件发送到这个远端
          </label>
          <p className="management-hint">
            不会打包客户端会话、来源设置或本机路径。写在 Skill
            正文、脚本或附属文件里的敏感信息仍会上传，请先检查。
          </p>
          <div className="management-actions">
            <button
              className="button"
              type="button"
              disabled={disabled || !reviewed || !selectedSnapshot}
              onClick={() =>
                void run(() =>
                  selectedSnapshot
                    ? window.koyori.publishBackup(selectedSnapshot.id)
                    : Promise.reject(new Error("请先创建本地快照。")),
                )
              }
            >
              <CloudUpload size={16} />
              上传所选快照
            </button>
            <button
              className="button"
              type="button"
              disabled={
                disabled || (!view.automatic && (!reviewed || selectedSkillIds.length === 0))
              }
              onClick={() =>
                void run(() => window.koyori.setAutomaticBackup(!view.automatic, selectedSkillIds))
              }
            >
              {view.automatic ? "暂停自动备份" : `自动备份当前所选 ${selectedSkillIds.length} 项`}
            </button>
          </div>
          <p className="management-hint">
            {view.automatic
              ? `已开启 ${view.selectedCount} 项。应用运行时监听文件，变更平稳两分钟后保存并上传；失败会延后重试。`
              : "自动备份默认关闭，仅包含明确选定的资源。"}
            退出应用后不继续联网上传。
          </p>
          {view.nextAttemptAt && (
            <p className="management-hint">
              下次尝试：{new Date(view.nextAttemptAt).toLocaleTimeString("zh-CN")}
            </p>
          )}
          {view.commit && (
            <p className="management-hint">
              已核验提交：<code>{view.commit.slice(0, 12)}</code>
            </p>
          )}
          <div className="section-title">
            <h3>远端历史</h3>
            <button
              className="text-button"
              type="button"
              disabled={disabled}
              onClick={() => void run(() => window.koyori.refreshRemoteHistory())}
            >
              <RefreshCw size={14} />
              获取最新历史
            </button>
          </div>
          {view.history.map((entry) => (
            <article className="backup-row" key={entry.commit}>
              <div>
                <strong>{new Date(entry.committedAt).toLocaleString("zh-CN")}</strong>
                <small>
                  {entry.commit.slice(0, 12)} · {entry.message}
                </small>
              </div>
              <button
                type="button"
                className="button"
                disabled={disabled}
                onClick={() =>
                  void run(async () => {
                    const result = await window.koyori.fetchRemoteBackup(entry.commit);
                    setNotice("已取回为本地快照。请在本地恢复快照中选择客户端并预览恢复。");
                    return result;
                  })
                }
              >
                <Download size={14} />
                取回快照
              </button>
            </article>
          ))}
          {view.history.length === 0 && (
            <p className="muted">尚未读取到备份历史，可以先上传本地快照。</p>
          )}
        </>
      )}
      {disabled && (
        <p className="management-hint">
          正在保存或连接远端…{" "}
          <button
            className="text-button"
            type="button"
            onClick={() =>
              void window.koyori.cancelRemoteBackup().catch(() => setError("取消请求未完成。"))
            }
          >
            取消远端操作
          </button>
        </p>
      )}
    </section>
  );
}
