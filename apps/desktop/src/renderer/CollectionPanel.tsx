import { useEffect, useRef, useState } from "react";
import type { CollectionView } from "../bridge";
import "./management.css";

export function CollectionPanel() {
  const [view, setView] = useState<CollectionView | null>(null);
  const [ids, setIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const selectionDirtyRef = useRef(false);
  useEffect(() => {
    let disposed = false;
    const update = () => {
      void window.koyori
        .getCollection()
        .then((next) => {
          if (!disposed) {
            setView(next);
            if (!selectionDirtyRef.current) setIds(next.selectedCandidateIds);
          }
        })
        .catch(() => {
          if (!disposed) setError("无法读取自动采集设置。");
        });
    };
    update();
    const unsubscribe = window.koyori.onWorkspaceChanged(update);
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);
  async function change(enabled: boolean) {
    setBusy(true);
    setError("");
    try {
      const next = await window.koyori.setCollection(enabled, enabled ? ids : undefined);
      setView(next);
      setIds(next.selectedCandidateIds);
      selectionDirtyRef.current = false;
    } catch {
      setError("自动采集设置未保存，请检查目录权限或稍后重试。");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="collection-panel" aria-label="自动使用统计">
      <div className="section-title">
        <h2>让使用证据持续更新</h2>
        <span>{view?.enabled ? "自动采集已开启" : "尚未开启自动采集"}</span>
      </div>
      <p className="management-hint">
        已自动查找本机历史目录。选择后开启，只在本机保留调用元数据；应用运行时更新，重启后补扫，原始会话不会上传。
      </p>
      {!view?.enabled &&
        view?.candidates.map((candidate) => (
          <label className="collection-candidate" key={candidate.id}>
            <input
              type="checkbox"
              disabled={busy || candidate.capability === "unsupported"}
              checked={ids.includes(candidate.id)}
              onChange={(event) => {
                selectionDirtyRef.current = true;
                setIds(
                  event.target.checked
                    ? [...ids, candidate.id]
                    : ids.filter((id) => id !== candidate.id),
                );
              }}
            />
            <span>
              {candidate.label}
              {candidate.capability === "unsupported" && (
                <small>仅发现目录，当前不支持调用统计</small>
              )}
              <code>{candidate.path}</code>
            </span>
          </label>
        ))}
      {!view?.enabled && view?.candidates.length === 0 && (
        <p className="management-hint">未发现可采集目录，可以在下方手动连接历史来源。</p>
      )}
      <div className="management-actions">
        <button
          className="button"
          type="button"
          disabled={busy || !view || (!view.enabled && ids.length === 0)}
          onClick={() => void change(!view?.enabled)}
        >
          {view?.enabled ? "暂停自动采集" : "开启所选目录的自动统计"}
        </button>
        {view?.lastAttemptAt && (
          <small>最近检查：{new Date(view.lastAttemptAt).toLocaleString("zh-CN")}</small>
        )}
      </div>
      {(error || view?.error) && <p role="alert">{error || view?.error}</p>}
    </section>
  );
}
