import type { SkillInventory } from "@koyori/core";
import { Archive, ArrowRight, RefreshCw, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ManagementPlanPreview, ManagementView, SourceTarget } from "../bridge";
import { RemoteBackupPanel } from "./RemoteBackupPanel";
import "./management.css";

const clients = { "claude-code": "Claude Code", codex: "Codex" };
const actions: Record<string, string> = {
  copy: "新增副本",
  replace: "备份后替换",
  skip: "内容相同，跳过",
  conflict: "存在冲突",
  restore: "恢复",
  revoke: "撤销项目副本并保留恢复材料",
};
const operationStatuses: Record<string, string> = {
  running: "进行中",
  succeeded: "已完成",
  partial: "部分完成",
  failed: "失败",
  cancelled: "已取消",
  interrupted: "进程中断",
};
const itemStatuses: Record<string, string> = {
  pending: "等待处理",
  skipped: "内容相同，已跳过",
  succeeded: "已完成",
  failed: "失败",
  cancelled: "已取消",
  interrupted: "进程中断",
};
const recoveryStates: Record<string, string> = {
  reserved: "已预留恢复位置，目标尚未确认移出",
  moving: "恢复材料正在移入受管目录",
  preserved: "原目录已保留，可用于恢复",
  restored: "原目录已回滚到目标",
};
function size(bytes: number) {
  return bytes < 1024
    ? `${bytes} B`
    : bytes < 1048576
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / 1048576).toFixed(1)} MB`;
}
function message(error: unknown) {
  return error instanceof Error
    ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, "")
    : "操作未完成，请重试。";
}

export function ManagementPanel({
  inventory,
  targets,
  initialSkillId,
  onChanged,
}: {
  inventory: SkillInventory | null;
  targets: SourceTarget[];
  initialSkillId: string | null;
  onChanged: () => void;
}) {
  const [selected, setSelected] = useState<string[]>(initialSkillId ? [initialSkillId] : []);
  const [targetId, setTargetId] = useState("");
  const [projectTargetId, setProjectTargetId] = useState("");
  const [query, setQuery] = useState("");
  const [replace, setReplace] = useState(false);
  const [plan, setPlan] = useState<ManagementPlanPreview | null>(null);
  const [view, setView] = useState<ManagementView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [reviewed, setReviewed] = useState(false);
  const requestIdRef = useRef(0);
  const skills = inventory?.skills ?? [];
  const available = useMemo(
    () =>
      skills.filter((skill) =>
        `${skill.name} ${skill.path}`.toLowerCase().includes(query.toLowerCase()),
      ),
    [skills, query],
  );
  const effectiveSelection = selected.filter((id) => skills.some((skill) => skill.id === id));
  const effectiveTarget =
    targets.find((target) => target.id === targetId) ??
    targets.find((target) => target.client === "codex") ??
    targets[0];
  const projectTargets = targets.filter((target) => target.scope === "project");
  const effectiveProjectTarget =
    projectTargets.find((target) => target.id === projectTargetId) ?? projectTargets[0];
  useEffect(() => {
    if (initialSkillId) {
      setSelected([initialSkillId]);
      setPlan(null);
    }
  }, [initialSkillId]);
  useEffect(() => {
    let disposed = false;
    const update = () => {
      const requestId = ++requestIdRef.current;
      void window.koyori
        .getManagement()
        .then((next) => {
          if (!disposed && requestId === requestIdRef.current) setView(next);
        })
        .catch((reason: unknown) => {
          if (!disposed && requestId === requestIdRef.current) setError(message(reason));
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
  function invalidate() {
    setPlan(null);
    setReviewed(false);
  }
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  }
  const disabled = busy || view?.busy === true;
  return (
    <section className="management-panel" aria-label="同步与备份">
      <div className="management-intro">
        <ShieldCheck size={20} />
        <p>选定 Skills，先查看影响，再同步或恢复。原始来源会保留，替换前会创建本地恢复快照。</p>
      </div>
      {error && (
        <p role="alert" className="notice error">
          {error}
        </p>
      )}
      {view?.lastResult && (
        <p role="status" className="notice">
          {view.lastResult}
        </p>
      )}
      <div className="management-grid">
        <section className="management-card">
          <div className="section-title">
            <h2>选择要整理的 Skills</h2>
            <span>{effectiveSelection.length} 项已选</span>
          </div>
          <input
            className="management-search"
            aria-label="搜索待同步 Skills"
            value={query}
            placeholder="按名称或路径筛选…"
            onChange={(event) => setQuery(event.target.value)}
          />
          <div className="management-selection-actions">
            <button
              className="text-button"
              type="button"
              disabled={disabled}
              onClick={() => {
                setSelected(available.map((skill) => skill.id));
                invalidate();
              }}
            >
              选择筛选结果
            </button>
            <button
              className="text-button"
              type="button"
              disabled={disabled}
              onClick={() => {
                setSelected([]);
                invalidate();
              }}
            >
              清空
            </button>
          </div>
          <div className="management-skill-list">
            {available.map((skill) => (
              <label className="management-skill" key={skill.id}>
                <input
                  type="checkbox"
                  disabled={disabled}
                  checked={effectiveSelection.includes(skill.id)}
                  onChange={(event) => {
                    setSelected(
                      event.target.checked
                        ? [...selected, skill.id]
                        : selected.filter((id) => id !== skill.id),
                    );
                    invalidate();
                  }}
                />
                <span>
                  <strong>{skill.name}</strong>
                  <small>
                    {clients[skill.client]} · {skill.isSymlink ? "链接资源" : "本机目录"}
                  </small>
                  <code>{skill.path}</code>
                </span>
              </label>
            ))}
            {available.length === 0 && (
              <p className="muted">没有可选 Skills。请先刷新资源清单或调整筛选条件。</p>
            )}
          </div>
        </section>
        <section className="management-card">
          <p className="eyebrow">SYNC & PRESERVE</p>
          <h2>放到另一个客户端</h2>
          <label className="management-field">
            同步目标
            <select
              aria-label="同步目标"
              value={effectiveTarget?.id ?? ""}
              disabled={disabled}
              onChange={(event) => {
                setTargetId(event.target.value);
                invalidate();
              }}
            >
              {targets.map((target) => (
                <option key={target.id} value={target.id}>
                  {clients[target.client]} · {target.label}
                </option>
              ))}
            </select>
          </label>
          {effectiveTarget && <code className="management-path">{effectiveTarget.path}</code>}
          {effectiveTarget?.shared && (
            <p className="management-hint">
              这是共享目录，其他使用该目录的客户端也可能看到新增 Skills。
            </p>
          )}
          <label className="management-check">
            <input
              type="checkbox"
              checked={replace}
              disabled={disabled}
              onChange={(event) => {
                setReplace(event.target.checked);
                invalidate();
              }}
            />
            允许替换不同内容，替换前保留快照
          </label>
          <button
            type="button"
            className="button primary"
            disabled={disabled || effectiveSelection.length === 0 || !effectiveTarget}
            onClick={() =>
              void run(async () => {
                if (!effectiveTarget) return;
                setReviewed(false);
                setPlan(
                  await window.koyori.planSync(effectiveSelection, effectiveTarget.id, replace),
                );
              })
            }
          >
            预览同步计划 <ArrowRight size={16} />
          </button>
          <hr />
          <h2>先留一份备份</h2>
          <p className="management-hint">
            保存所选 Skill
            的完整目录。不会读取客户端会话或账号配置；目录内自行写入的敏感内容也会保留。
          </p>
          <button
            type="button"
            className="button"
            disabled={disabled || effectiveSelection.length === 0}
            onClick={() =>
              void run(async () => {
                setView(await window.koyori.backupSkills(effectiveSelection));
                onChanged();
              })
            }
          >
            <Archive size={16} />
            备份所选 Skills
          </button>
        </section>
      </div>
      <section className="management-card" aria-label="项目 Skills 部署">
        <div className="section-title">
          <h2>部署到项目</h2>
          <span>一次选择一项 Skill</span>
        </div>
        <p className="management-hint">
          把完整 Skill 目录复制到已登记项目的客户端目录。已有同名目录不会被接管或替换。 原 Skill
          如果仍在全局扫描目录，撤销项目副本后客户端仍可能看到它。
        </p>
        <label className="management-field">
          项目目标
          <select
            aria-label="项目目标"
            value={effectiveProjectTarget?.id ?? ""}
            disabled={disabled}
            onChange={(event) => {
              setProjectTargetId(event.target.value);
              invalidate();
            }}
          >
            {projectTargets.map((target) => (
              <option key={target.id} value={target.id}>
                {clients[target.client]} · {target.label}
              </option>
            ))}
          </select>
        </label>
        {effectiveProjectTarget && (
          <code className="management-path">{effectiveProjectTarget.path}</code>
        )}
        <button
          type="button"
          className="button primary"
          disabled={disabled || effectiveSelection.length !== 1 || !effectiveProjectTarget}
          onClick={() =>
            void run(async () => {
              const skillId = effectiveSelection[0];
              if (!effectiveProjectTarget || effectiveSelection.length !== 1 || !skillId) return;
              setReviewed(false);
              setPlan(await window.koyori.planProjectDeploy(skillId, effectiveProjectTarget.id));
            })
          }
        >
          预览项目部署
        </button>
        {projectTargets.length === 0 && (
          <p className="muted">请先在资源来源中登记项目，并刷新目录。</p>
        )}
        <hr />
        <h2>受管项目副本</h2>
        {(view?.projectDeployments ?? [])
          .filter((entry) => entry.status === "active")
          .map((entry) => (
            <article className="backup-row" key={entry.id}>
              <div>
                <strong>{entry.targetPath.split("/").at(-1)}</strong>
                <code>项目：{entry.projectPath}</code>
                <code>来源：{entry.sourcePath}</code>
                <code>目标：{entry.targetPath}</code>
              </div>
              <button
                type="button"
                className="button"
                disabled={disabled}
                onClick={() =>
                  void run(async () => {
                    setReviewed(false);
                    setPlan(await window.koyori.planProjectRevoke(entry.id));
                  })
                }
              >
                预览撤销
              </button>
            </article>
          ))}
        {(view?.projectDeployments ?? []).filter((entry) => entry.status === "active").length ===
          0 && <p className="muted">还没有 Koyori 登记的项目部署。</p>}
      </section>
      {plan && (
        <section className="management-card plan-preview" aria-label="操作计划">
          <div className="section-title">
            <h2>
              {
                {
                  sync: "同步计划",
                  restore: "恢复计划",
                  "project-deploy": "项目部署计划",
                  "project-revoke": "项目撤销计划",
                }[plan.kind]
              }
            </h2>
            <span>有效至 {new Date(plan.expiresAt).toLocaleTimeString("zh-CN")}</span>
          </div>
          <p className="management-hint">
            执行前会再次核对文件。预览后发生外部修改时，计划会停止。
          </p>
          {plan.items.map((item) => (
            <div className="plan-item" key={item.target}>
              <strong>{item.name}</strong>
              <span>
                {actions[item.action] ?? item.action} · {item.files} 个文件 · {size(item.bytes)}
              </span>
              <code>{item.source}</code>
              <code>→ {item.target}</code>
            </div>
          ))}
          {plan.warnings.length > 0 && (
            <div className="compatibility-notice">
              <strong>兼容性与影响</strong>
              <ul>
                {[...new Set(plan.warnings)].map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </div>
          )}
          <label className="management-check">
            <input
              type="checkbox"
              checked={reviewed}
              disabled={disabled}
              onChange={(event) => setReviewed(event.target.checked)}
            />
            我已检查目标、差异和兼容提示
          </label>
          <div className="management-actions">
            <button
              type="button"
              className="button primary"
              disabled={disabled || !reviewed || !plan.canExecute}
              onClick={() =>
                void run(async () => {
                  try {
                    setView(await window.koyori.executePlan(plan.id));
                  } finally {
                    invalidate();
                    onChanged();
                  }
                })
              }
            >
              确认执行
              {
                {
                  sync: "同步",
                  restore: "恢复",
                  "project-deploy": "项目部署",
                  "project-revoke": "项目撤销",
                }[plan.kind]
              }
            </button>
            <button type="button" className="text-button" disabled={disabled} onClick={invalidate}>
              取消计划
            </button>
            {!plan.canExecute && <span className="muted">请先处理冲突并重新生成计划。</span>}
          </div>
        </section>
      )}
      <section className="management-card" aria-label="本地备份历史">
        <div className="section-title">
          <h2>本地恢复快照</h2>
          <button
            type="button"
            className="text-button"
            disabled={disabled}
            onClick={() => void run(async () => setView(await window.koyori.getManagement()))}
          >
            <RefreshCw size={14} />
            刷新
          </button>
        </div>
        <p className="management-hint">
          恢复先生成计划。原位置不可用时，可以恢复到上方选定的客户端；已有内容仍需检查冲突。
        </p>
        {(view?.backups ?? []).map((backup) => (
          <article className="backup-row" key={backup.id}>
            <div>
              <strong>{new Date(backup.createdAt).toLocaleString("zh-CN")}</strong>
              <small>
                {backup.reason} · {backup.entries.length} 项 ·{" "}
                {size(backup.entries.reduce((sum, entry) => sum + entry.bytes, 0))}
              </small>
              <details>
                <summary>查看内容</summary>
                {backup.entries.map((entry) => (
                  <p key={`${entry.path}-${entry.client ?? "snapshot"}`}>
                    <strong>{entry.name}</strong>
                    <code>{entry.path}</code>
                  </p>
                ))}
              </details>
            </div>
            <div className="backup-actions">
              <button
                type="button"
                className="button"
                disabled={disabled || !backup.canRestoreOriginal}
                onClick={() =>
                  void run(async () => {
                    setReviewed(false);
                    setPlan(await window.koyori.planRestore(backup.id, null, replace));
                  })
                }
              >
                预览原位恢复
              </button>
              <button
                type="button"
                className="text-button"
                disabled={disabled || !effectiveTarget}
                onClick={() =>
                  void run(async () => {
                    if (!effectiveTarget) return;
                    setReviewed(false);
                    setPlan(
                      await window.koyori.planRestore(backup.id, effectiveTarget.id, replace),
                    );
                  })
                }
              >
                恢复到选定客户端
              </button>
            </div>
          </article>
        ))}
        {view?.backups.length === 0 && (
          <p className="muted">
            还没有快照。可以先备份所选 Skills，之后的受管替换也会留下恢复材料。
          </p>
        )}
      </section>
      <section className="management-card" aria-label="最近文件操作">
        <div className="section-title">
          <h2>最近文件操作</h2>
          <span>最多保留展示 20 条</span>
        </div>
        <p className="management-hint">
          每项记录执行结果与恢复材料位置。进程中断时，先按这里显示的路径核对原目录。
        </p>
        {(view?.operations ?? []).map((operation) => (
          <details className="operation-row" key={operation.id}>
            <summary>
              <span>
                <strong>
                  {
                    {
                      sync: "同步",
                      restore: "恢复",
                      "project-deploy": "项目部署",
                      "project-revoke": "项目撤销",
                    }[operation.kind]
                  }
                </strong>
                <small>{new Date(operation.startedAt).toLocaleString("zh-CN")}</small>
              </span>
              <span>{operationStatuses[operation.status] ?? operation.status}</span>
            </summary>
            {operation.completedAt && (
              <p className="management-hint">
                完成时间：{new Date(operation.completedAt).toLocaleString("zh-CN")}
              </p>
            )}
            {operation.error && <p className="operation-error">{operation.error}</p>}
            <div className="operation-items">
              {operation.items.map((item) => (
                <article key={item.id}>
                  <div className="operation-item-heading">
                    <strong>{itemStatuses[item.status] ?? item.status}</strong>
                    <span>{actions[item.action] ?? item.action}</span>
                  </div>
                  <code>目标：{item.target}</code>
                  {item.error && <p className="operation-error">{item.error}</p>}
                  {item.recoveryState && (
                    <div className="recovery-material">
                      <strong>
                        恢复材料 · {recoveryStates[item.recoveryState] ?? item.recoveryState}
                      </strong>
                      {operation.status === "interrupted" && item.recoveryState === "moving" && (
                        <p>上次进程在移动恢复材料时中断，请同时检查以下两个路径。</p>
                      )}
                      {item.recoveryPath && (
                        <code>
                          {item.recoveryState === "restored"
                            ? "回滚位置"
                            : item.recoveryState === "moving"
                              ? "移动前路径"
                              : "保留位置"}
                          ：{item.recoveryPath}
                        </code>
                      )}
                      {item.recoveryDestinationPath && (
                        <code>计划移入位置：{item.recoveryDestinationPath}</code>
                      )}
                    </div>
                  )}
                </article>
              ))}
            </div>
          </details>
        ))}
        {view?.operations.length === 0 && <p className="muted">还没有受管文件操作记录。</p>}
      </section>
      <RemoteBackupPanel selectedSkillIds={effectiveSelection} backups={view?.backups ?? []} />
      {disabled && (
        <div className="notice" role="status">
          正在检查或保存文件…{" "}
          <button
            type="button"
            className="text-button"
            onClick={() =>
              void window.koyori
                .cancelManagement()
                .catch((reason: unknown) => setError(message(reason)))
            }
          >
            请求取消
          </button>
        </div>
      )}
    </section>
  );
}
