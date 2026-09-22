import type {
  HistoryCoverage,
  ResourceRoot,
  SkillInventory,
  SkillUsage,
  UsageCounts,
  UsageEvent,
  UsageRules,
  UsageView,
} from "@koyori/core";
import {
  BarChart3,
  CalendarClock,
  CheckCircle2,
  Clock3,
  FileText,
  FolderPlus,
  History,
  LoaderCircle,
  RefreshCw,
  Unplug,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type {} from "../bridge";
import "./usage.css";

interface UsagePanelProps {
  inventory: SkillInventory | null;
  roots: ResourceRoot[];
  onChange: (view: UsageView) => void;
}

type WindowDays = 30 | 90;
type BusyAction = "load" | "source" | "import" | "preference" | "rules" | "review" | null;

const clientNames = { "claude-code": "Claude Code", codex: "Codex" } as const;
const dayMs = 24 * 60 * 60 * 1000;

export function UsagePanel({ inventory, roots, onChange }: UsagePanelProps) {
  const [revision, setRevision] = useState(0);
  const [windowDays, setWindowDays] = useState<WindowDays>(30);
  const [view, setView] = useState<UsageView | null>(null);
  const [busy, setBusy] = useState<BusyAction>("load");
  const [error, setError] = useState("");
  const [sourceRootId, setSourceRootId] = useState("");
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const [ruleDraft, setRuleDraft] = useState<Record<keyof UsageRules, string>>({
    idleDays: "",
    lowUseThreshold: "",
    graceDays: "",
  });
  const onChangeRef = useRef(onChange);
  const requestIdRef = useRef(0);
  const rootsSignature = roots.map((root) => `${root.id}:${root.client}:${root.path}`).join("|");

  useEffect(() => window.koyori.onWorkspaceChanged(() => setRevision((value) => value + 1)), []);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    // Scanning or changing roots can change the main-process attribution context.
    void inventory?.scannedAt;
    void rootsSignature;
    void revision;
    const requestId = ++requestIdRef.current;
    setBusy("load");
    setError("");
    window.koyori
      .getUsage(windowDays)
      .then((next) => {
        if (requestId !== requestIdRef.current) return;
        setView(next);
        onChangeRef.current(next);
      })
      .catch(() => {
        if (requestId !== requestIdRef.current) return;
        setError("使用账本读取失败。已保留上一次成功结果，可以稍后重试。");
      })
      .finally(() => {
        if (requestId === requestIdRef.current) setBusy(null);
      });
    return () => {
      if (requestId === requestIdRef.current) requestIdRef.current += 1;
    };
  }, [windowDays, inventory?.scannedAt, rootsSignature, revision]);

  useEffect(() => {
    if (!view) return;
    setRuleDraft({
      idleDays: String(view.rules.idleDays),
      lowUseThreshold: String(view.rules.lowUseThreshold),
      graceDays: String(view.rules.graceDays),
    });
  }, [view]);

  const claudeRoots = useMemo(() => roots.filter((root) => root.client === "claude-code"), [roots]);
  const availableRoots = claudeRoots;

  useEffect(() => {
    if (availableRoots.some((root) => root.id === sourceRootId)) return;
    setSourceRootId(availableRoots[0]?.id ?? "");
  }, [availableRoots, sourceRootId]);

  function accept(next: UsageView) {
    setView(next);
    setError("");
    onChangeRef.current(next);
  }

  async function refresh() {
    setBusy("load");
    setError("");
    try {
      accept(await window.koyori.getUsage(windowDays));
    } catch {
      setError("使用账本读取失败。已保留上一次成功结果，可以稍后重试。");
    } finally {
      setBusy(null);
    }
  }

  async function addSource() {
    if (!sourceRootId) return;
    setBusy("source");
    setError("");
    try {
      const source = await window.koyori.addHistorySource(sourceRootId);
      if (source) accept(await window.koyori.getUsage(windowDays));
    } catch {
      setError("历史来源连接失败或目录不可读。已有来源和账本记录保持不变。");
    } finally {
      setBusy(null);
    }
  }

  async function disconnectSource(sourceId: string) {
    setBusy("source");
    setError("");
    try {
      await window.koyori.disconnectHistorySource(sourceId);
      accept(await window.koyori.getUsage(windowDays));
    } catch {
      setError("来源断开失败。已有来源和账本记录保持不变。");
    } finally {
      setBusy(null);
    }
  }

  async function importUsage() {
    setBusy("import");
    setError("");
    try {
      accept(await window.koyori.importUsage(windowDays));
    } catch {
      setError("本次导入未完成或已取消。上一次成功结果仍然保留。");
    } finally {
      setBusy(null);
    }
  }

  async function setPreference(
    skillId: string,
    patch: { keep?: boolean; reviewAfter?: string | null },
  ) {
    setBusy("preference");
    setError("");
    try {
      accept(await window.koyori.setSkillPreference(skillId, patch, windowDays));
    } catch {
      setError("偏好保存失败。原有设置保持不变。");
    } finally {
      setBusy(null);
    }
  }

  async function saveRules() {
    const rules = parseRules(ruleDraft);
    if (!rules) {
      setError("规则需要填写整数：闲置 1–365 天、低频 0–100 次、新资源观察 0–365 天。");
      return;
    }
    setBusy("rules");
    setError("");
    try {
      accept(await window.koyori.setUsageRules(rules, windowDays));
    } catch {
      setError("规则保存失败。原有设置保持不变。");
    } finally {
      setBusy(null);
    }
  }

  async function markReviewed() {
    setBusy("review");
    setError("");
    try {
      accept(await window.koyori.markUsageReviewed(windowDays));
    } catch {
      setError("复查时间保存失败，请稍后重试。");
    } finally {
      setBusy(null);
    }
  }

  if (!inventory) {
    return (
      <section className="usage-panel usage-onboarding" aria-labelledby="usage-heading">
        <div className="usage-onboarding-mark" aria-hidden="true">
          <BarChart3 size={23} />
        </div>
        <div>
          <p className="usage-kicker">USAGE LEDGER</p>
          <h2 id="usage-heading">先扫描 Skills，再建立使用账本</h2>
          <p>
            账本只会关联本次扫描到的真实资源。完成扫描后，可主动选择 Claude Code
            资源来源和原生日志目录。
          </p>
        </div>
      </section>
    );
  }

  const isImporting = busy === "import";
  const appliedWindow = view?.report.windowDays;
  const totals = view
    ? sumCounts([...view.report.skills, ...view.report.unattributed])
    : emptyCounts();
  const sourceById = new Map(view?.sources.map((source) => [source.id, source]) ?? []);
  const usageBySkillId = new Map(view?.report.skills.map((usage) => [usage.skillId, usage]) ?? []);
  const inventoryById = new Map(inventory.skills.map((skill) => [skill.id, skill]));
  const selectedUsage = selectedSkillId ? usageBySkillId.get(selectedSkillId) : undefined;
  const selectedSkill = selectedSkillId ? inventoryById.get(selectedSkillId) : undefined;
  const reviewDue = isWeeklyReviewDue(view?.lastReviewedAt ?? null);

  return (
    <section className="usage-panel" aria-labelledby="usage-heading">
      <header className="usage-header">
        <div>
          <p className="usage-kicker">LOCAL EVIDENCE</p>
          <h2 id="usage-heading">使用账本与复查偏好</h2>
          <p>从本机日志提取最小事件，不保留会话原文。调用证据不代表任务成功。</p>
        </div>
        <fieldset className="usage-window" aria-label="统计窗口">
          {([30, 90] as const).map((days) => (
            <button
              type="button"
              key={days}
              className={windowDays === days ? "active" : ""}
              aria-pressed={windowDays === days}
              disabled={busy !== null}
              onClick={() => setWindowDays(days)}
            >
              {days} 天
            </button>
          ))}
        </fieldset>
      </header>

      {error && (
        <div className="usage-alert" role="alert">
          {error}
          <button type="button" onClick={() => setError("")} aria-label="关闭使用账本错误提示">
            ×
          </button>
        </div>
      )}

      <div className="usage-source-card">
        <div className="usage-source-copy">
          <span className="usage-icon" aria-hidden="true">
            <FolderPlus size={17} />
          </span>
          <div>
            <strong>连接 Claude Code 原生历史</strong>
            <p>
              先选择一个已扫描的 Claude Code 资源来源，再由系统目录选择器指定原生日志目录。只读取
              JSONL 并保存时间、状态和证据位置等最小事件，不保存会话原文。
            </p>
          </div>
        </div>
        {claudeRoots.length === 0 ? (
          <p className="usage-inline-empty">还没有 Claude Code 资源来源，请先在上方添加并扫描。</p>
        ) : availableRoots.length > 0 ? (
          <div className="usage-source-actions">
            <label>
              <span>资源来源</span>
              <select
                value={sourceRootId}
                disabled={busy !== null}
                onChange={(event) => setSourceRootId(event.target.value)}
              >
                {availableRoots.map((root) => (
                  <option value={root.id} key={root.id}>
                    {root.label || "Claude Code 来源"}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="usage-primary-button"
              aria-label="连接历史"
              disabled={!sourceRootId || busy !== null}
              onClick={() => void addSource()}
            >
              {busy === "source" ? (
                <LoaderCircle className="usage-spin" size={15} />
              ) : (
                <FolderPlus size={15} />
              )}
              连接历史
            </button>
          </div>
        ) : (
          <p className="usage-inline-empty">选择同一资源来源可继续连接另一个历史目录。</p>
        )}
        <p className="usage-boundary">
          Codex 当前只参与资源盘点，不宣称支持调用计数。重复导入会按事件身份去重，不会增加次数。
        </p>
      </div>

      {(view?.sources.length ?? 0) > 0 && (
        <fieldset className="usage-connected" aria-label="已连接的历史来源">
          {view?.sources.map((source) => (
            <div className="usage-connected-row" key={source.id}>
              <div>
                <strong>{source.label || clientNames[source.client]}</strong>
                <code>{source.path}</code>
              </div>
              <span
                className={source.enabled ? "usage-source-status active" : "usage-source-status"}
              >
                {source.enabled ? "已连接" : "已断开"}
              </span>
              {source.enabled && (
                <button
                  type="button"
                  className="usage-text-button"
                  aria-label={`断开来源：${source.label || clientNames[source.client]}`}
                  disabled={busy !== null}
                  onClick={() => void disconnectSource(source.id)}
                >
                  <Unplug size={13} />
                  断开来源
                </button>
              )}
            </div>
          ))}
          <p>断开只会停止后续导入，并保留已采集记录；不会删除日志、资源或账本。</p>
        </fieldset>
      )}

      <div className="usage-import-bar">
        <div>
          <strong>
            {view?.lastImportedAt
              ? `最近导入 ${formatDateTime(view.lastImportedAt)}`
              : "尚未导入历史"}
          </strong>
          <span>
            当前显示{appliedWindow ? `近 ${appliedWindow} 天` : "所选窗口"}
            {busy === "load" ? " · 正在读取…" : ""}
          </span>
        </div>
        <div>
          <button
            type="button"
            className="usage-quiet-button"
            disabled={busy !== null}
            onClick={() => void refresh()}
          >
            <RefreshCw size={14} />
            刷新
          </button>
          {isImporting ? (
            <button
              type="button"
              className="usage-quiet-button danger"
              onClick={() => {
                void window.koyori
                  .cancelUsageImport()
                  .catch(() =>
                    setError("取消未生效，记录可能已进入保存阶段；请等待并检查导入结果。"),
                  );
              }}
            >
              取消导入
            </button>
          ) : (
            <button
              type="button"
              className="usage-primary-button"
              aria-label="导入使用记录"
              disabled={busy !== null || !view?.sources.some((source) => source.enabled)}
              onClick={() => void importUsage()}
            >
              <History size={15} />
              导入
            </button>
          )}
        </div>
      </div>

      {view && (
        <>
          <fieldset
            className="usage-metrics"
            aria-label={`近 ${view.report.windowDays} 天使用统计`}
          >
            <Metric
              label="已采集事件"
              value={view.lastImportedAt ? view.report.totalEvents : "—"}
              tone="neutral"
            />
            <Metric label="调用尝试" value={view.lastImportedAt ? totals.calls : "—"} tone="pink" />
            <Metric
              label="成功返回"
              value={view.lastImportedAt ? totals.loaded : "—"}
              tone="mint"
            />
            <Metric label="失败" value={view.lastImportedAt ? totals.failed : "—"} tone="red" />
            <Metric
              label="结果未知"
              value={view.lastImportedAt ? totals.unresolved : "—"}
              tone="sand"
            />
            <Metric
              label="显式请求"
              value={view.lastImportedAt ? totals.requests : "—"}
              tone="blue"
            />
          </fieldset>

          <section className="usage-section" aria-labelledby="coverage-heading">
            <div className="usage-section-heading">
              <div>
                <p className="usage-kicker">COVERAGE</p>
                <h3 id="coverage-heading">证据覆盖与限制</h3>
              </div>
              <span>
                {formatDate(view.report.since)} — {formatDate(view.report.until)}
              </span>
            </div>
            {view.coverage.length > 0 ? (
              <div className="coverage-list">
                {view.coverage.map((coverage) => (
                  <CoverageRow
                    key={coverage.sourceId}
                    coverage={coverage}
                    sourceLabel={sourceById.get(coverage.sourceId)?.label}
                  />
                ))}
              </div>
            ) : (
              <p className="usage-empty-line">连接并导入后才会显示覆盖。未采集不等于 0 次。</p>
            )}
            {view.issues.length > 0 && (
              <details className="usage-issues">
                <summary>{view.issues.length} 条导入提示</summary>
                {view.issues.map((issue, index) => (
                  <div
                    className="usage-issue-row"
                    key={`${issue.sourceId}-${issue.code}-${issue.file ?? ""}-${issue.line ?? index}`}
                  >
                    <strong>{issue.code}</strong>
                    <span>{issue.message}</span>
                    {issue.file && (
                      <code>
                        {relativeEvidenceFile(issue.file)}
                        {issue.line ? `:${issue.line}` : ""}
                      </code>
                    )}
                  </div>
                ))}
              </details>
            )}
          </section>

          <section className="usage-section" aria-labelledby="skills-usage-heading">
            <div className="usage-section-heading">
              <div>
                <p className="usage-kicker">BY RESOURCE</p>
                <h3 id="skills-usage-heading">逐资源账本与偏好</h3>
              </div>
              <span>{inventory.skills.length} 份已扫描资源</span>
            </div>
            <div className="usage-skill-list">
              {inventory.skills.map((skill) => {
                const usage = usageBySkillId.get(skill.id);
                const preference = view.preferences[skill.id];
                const countableUsage = usage?.status === "observed" ? usage : undefined;
                return (
                  <article className="usage-skill-row" key={skill.id}>
                    <div className="usage-skill-name">
                      <strong>{skill.name}</strong>
                      <span>{clientNames[skill.client]}</span>
                      <UsageStatus usage={usage} />
                    </div>
                    <fieldset className="usage-skill-counts" aria-label={`${skill.name} 使用统计`}>
                      <Count label="调用" value={countableUsage?.calls} />
                      <Count label="返回" value={countableUsage?.loaded} />
                      <Count label="失败" value={countableUsage?.failed} />
                      <Count label="未知" value={countableUsage?.unresolved} />
                      <Count label="请求" value={countableUsage?.requests} />
                      <Count label="会话" value={countableUsage?.sessions} />
                    </fieldset>
                    <div className="usage-preference-actions">
                      <label className="usage-keep">
                        <input
                          type="checkbox"
                          aria-label={`${skill.name} 始终保留`}
                          checked={preference?.keep ?? false}
                          disabled={busy !== null}
                          onChange={(event) =>
                            void setPreference(skill.id, { keep: event.target.checked })
                          }
                        />
                        始终保留
                      </label>
                      <button
                        type="button"
                        className="usage-text-button"
                        aria-label={
                          preference?.reviewAfter
                            ? `${skill.name} 清除复查日期`
                            : `${skill.name} 30 天后复查`
                        }
                        disabled={busy !== null}
                        onClick={() =>
                          void setPreference(skill.id, {
                            reviewAfter: preference?.reviewAfter ? null : addDaysIso(30),
                          })
                        }
                      >
                        <CalendarClock size={13} />
                        {preference?.reviewAfter
                          ? `清除复查日期（${formatDate(preference.reviewAfter)}）`
                          : "30 天后复查"}
                      </button>
                      <button
                        type="button"
                        className="usage-text-button"
                        disabled={!usage?.evidence.length}
                        aria-expanded={selectedSkillId === skill.id}
                        onClick={() =>
                          setSelectedSkillId((current) => (current === skill.id ? null : skill.id))
                        }
                      >
                        <FileText size={13} />
                        证据 {usage?.evidence.length ?? 0}
                      </button>
                    </div>
                    {usage && (
                      <details className="usage-skill-notes">
                        <summary>
                          最近使用 {formatDateTime(usage.lastUsedAt)}
                          {usage.notes.length > 0 ? ` · ${usage.notes.length} 条口径说明` : ""}
                        </summary>
                        {usage.notes.length > 0 ? (
                          <ul>
                            {usage.notes.map((note) => (
                              <li key={note}>{note}</li>
                            ))}
                          </ul>
                        ) : (
                          <p>当前没有额外口径说明。</p>
                        )}
                      </details>
                    )}
                  </article>
                );
              })}
            </div>
            {selectedSkill && selectedUsage && (
              <EvidenceList skillName={selectedSkill.name} events={selectedUsage.evidence} />
            )}
          </section>

          <section className="usage-section" aria-labelledby="unattributed-heading">
            <div className="usage-section-heading">
              <div>
                <p className="usage-kicker">UNATTRIBUTED</p>
                <h3 id="unattributed-heading">未归因名字排行</h3>
              </div>
              <span>同名资源不会猜测归属</span>
            </div>
            {view.report.unattributed.length > 0 ? (
              <ol className="usage-ranking">
                {[...view.report.unattributed]
                  .sort((a, b) => b.calls + b.requests - (a.calls + a.requests))
                  .map((item) => (
                    <li key={`${item.client}-${item.skillName}-${item.reason}`}>
                      <span className="usage-rank-name">
                        <strong>{item.skillName}</strong>
                        <small>
                          {clientNames[item.client]} ·{" "}
                          {item.reason === "ambiguous" ? "存在重名" : "清单中未找到"}
                        </small>
                      </span>
                      <span>调用 {item.calls}</span>
                      <span>请求 {item.requests}</span>
                      <span>未知 {item.unresolved}</span>
                    </li>
                  ))}
              </ol>
            ) : (
              <p className="usage-empty-line">当前窗口内没有未归因事件。</p>
            )}
          </section>

          <section className="usage-section" aria-labelledby="suggestions-heading">
            <div className="usage-section-heading">
              <div>
                <p className="usage-kicker">REVIEW NOTES</p>
                <h3 id="suggestions-heading">整理建议</h3>
              </div>
              <span>仅供查看、保留与复查</span>
            </div>
            {view.report.suggestions.length > 0 ? (
              <div className="usage-suggestions">
                {view.report.suggestions.map((suggestion) => (
                  <article key={suggestion.id}>
                    <div className="usage-suggestion-title">
                      <span className="usage-suggestion-kind">
                        {suggestionKindLabel(suggestion.kind)}
                      </span>
                      <strong className="usage-suggestion-name">{suggestion.title}</strong>
                    </div>
                    <p>{suggestion.reason}</p>
                    <ul>
                      {suggestion.skillIds.map((skillId) => (
                        <li key={skillId}>
                          {inventoryById.get(skillId)?.name ?? "当前清单中已不存在的资源"}
                        </li>
                      ))}
                    </ul>
                    {suggestion.cautions.map((caution) => (
                      <small key={caution}>{caution}</small>
                    ))}
                  </article>
                ))}
              </div>
            ) : (
              <p className="usage-empty-line">当前规则和证据下没有待复查建议。</p>
            )}
            <p className="usage-boundary">
              闲置/低频候选要求覆盖所设观察期、最新记录在近七天且本次读取未受限。建议不会移动或删除资源。
            </p>
          </section>

          <section className="usage-settings" aria-labelledby="usage-rules-heading">
            <div className="usage-section-heading">
              <div>
                <p className="usage-kicker">REVIEW RHYTHM</p>
                <h3 id="usage-rules-heading">规则与人工复查</h3>
              </div>
              <span>规则只生成建议</span>
            </div>
            <div className="usage-rule-form">
              <RuleInput
                label="闲置天数"
                value={ruleDraft.idleDays}
                min={1}
                max={365}
                disabled={busy !== null}
                onChange={(value) => setRuleDraft((current) => ({ ...current, idleDays: value }))}
              />
              <RuleInput
                label="低频调用上限"
                value={ruleDraft.lowUseThreshold}
                min={0}
                max={100}
                disabled={busy !== null}
                onChange={(value) =>
                  setRuleDraft((current) => ({ ...current, lowUseThreshold: value }))
                }
              />
              <RuleInput
                label="新资源观察天数"
                value={ruleDraft.graceDays}
                min={0}
                max={365}
                disabled={busy !== null}
                onChange={(value) => setRuleDraft((current) => ({ ...current, graceDays: value }))}
              />
              <button
                type="button"
                className="usage-quiet-button"
                disabled={busy !== null}
                onClick={() => void saveRules()}
              >
                保存规则
              </button>
            </div>
            <div className={reviewDue ? "usage-review-note due" : "usage-review-note"}>
              <Clock3 size={17} />
              <div>
                <strong className="usage-review-title">
                  {view.lastReviewedAt
                    ? `上次人工复查 ${formatDateTime(view.lastReviewedAt)}`
                    : "还没有记录人工复查"}
                </strong>
                <p>
                  {reviewDue
                    ? view.lastReviewedAt
                      ? "距离上次复查已满 7 天，建议在应用内完成本周复查。"
                      : "完成首次复查后，应用会按每 7 天的节奏提示下一次复查。"
                    : "未满 7 天，无需重复复查；统计变化仍可随时查看。"}
                </p>
              </div>
              <button
                type="button"
                className="usage-primary-button"
                disabled={busy !== null}
                onClick={() => void markReviewed()}
              >
                <CheckCircle2 size={15} />
                本次已复查
              </button>
            </div>
          </section>
        </>
      )}
    </section>
  );
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: number | string;
  tone: "neutral" | "pink" | "mint" | "red" | "sand" | "blue";
}) {
  return (
    <div className={`usage-metric ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function CoverageRow({
  coverage,
  sourceLabel,
}: {
  coverage: HistoryCoverage;
  sourceLabel: string | undefined;
}) {
  const statusLabels: Record<HistoryCoverage["status"], string> = {
    supported: "可读取",
    unsupported: "版本未支持",
    empty: "没有记录",
    unreadable: "无法读取",
  };
  return (
    <article className="coverage-row">
      <div className="coverage-title">
        <strong>{sourceLabel || coverage.adapter}</strong>
        <div className="coverage-badges">
          {coverage.readLimited && <span className="coverage-status limited">部分读取</span>}
          <span className={`coverage-status ${coverage.status}`}>
            {statusLabels[coverage.status]}
          </span>
        </div>
      </div>
      <dl>
        <div>
          <dt>最早记录</dt>
          <dd>{formatDateTime(coverage.firstRecordAt)}</dd>
        </div>
        <div>
          <dt>最新记录</dt>
          <dd>{formatDateTime(coverage.lastRecordAt)}</dd>
        </div>
        <div>
          <dt>文件 / 记录</dt>
          <dd>
            {coverage.filesRead} / {coverage.recordsRead}
          </dd>
        </div>
        <div>
          <dt>坏行 / 跳过</dt>
          <dd>
            {coverage.malformedLines} / {coverage.skippedFiles}
          </dd>
        </div>
      </dl>
      <div className="coverage-meta">
        <span>解析器 {coverage.adapter}</span>
        {coverage.clientVersions.length > 0 && (
          <span>客户端 {coverage.clientVersions.join("、")}</span>
        )}
        <span>扫描 {formatDateTime(coverage.scannedAt)}</span>
      </div>
      {coverage.limitations.map((limitation) => (
        <p key={limitation}>{limitation}</p>
      ))}
      {coverage.readLimited && <p>本次读取受到文件或数量限制，统计只覆盖已读取部分。</p>}
      <small>覆盖日期只表示实际读到记录的范围，不保证期间完整。</small>
    </article>
  );
}

function UsageStatus({ usage }: { usage: SkillUsage | undefined }) {
  if (!usage) return <span className="usage-status unknown">暂无账本项</span>;
  const labels: Record<SkillUsage["status"], string> = {
    "not-connected": "未连接",
    unknown: "证据不足",
    observed: "已观察",
    ambiguous: "归因不确定",
  };
  return <span className={`usage-status ${usage.status}`}>{labels[usage.status]}</span>;
}

function Count({ label, value }: { label: string; value: number | undefined }) {
  return (
    <span>
      <small>{label}</small>
      <strong>{value ?? "—"}</strong>
    </span>
  );
}

function EvidenceList({ skillName, events }: { skillName: string; events: UsageEvent[] }) {
  return (
    <section className="usage-evidence" aria-label={`${skillName} 的使用证据`}>
      <div>
        <strong>{skillName}</strong>
        <span>仅显示相对文件、行号、时间与状态，不读取会话原文。</span>
      </div>
      {events.map((event) => (
        <article key={event.id}>
          <span className={`evidence-status ${event.status}`}>{eventStatusLabel(event)}</span>
          <time dateTime={event.at}>{formatDateTime(event.at)}</time>
          <div>
            {event.evidence.map((evidence) => (
              <code key={`${evidence.sourceId}-${evidence.file}-${evidence.line}`}>
                {relativeEvidenceFile(evidence.file)}:{evidence.line}
              </code>
            ))}
          </div>
        </article>
      ))}
    </section>
  );
}

function RuleInput({
  label,
  value,
  min,
  max,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  min: number;
  max: number;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <label>
      <span>{label}</span>
      <input
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        step={1}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function parseRules(draft: Record<keyof UsageRules, string>): UsageRules | null {
  const idleDays = Number(draft.idleDays);
  const lowUseThreshold = Number(draft.lowUseThreshold);
  const graceDays = Number(draft.graceDays);
  if (
    !Number.isInteger(idleDays) ||
    idleDays < 1 ||
    idleDays > 365 ||
    !Number.isInteger(lowUseThreshold) ||
    lowUseThreshold < 0 ||
    lowUseThreshold > 100 ||
    !Number.isInteger(graceDays) ||
    graceDays < 0 ||
    graceDays > 365
  ) {
    return null;
  }
  return { idleDays, lowUseThreshold, graceDays };
}

function emptyCounts(): UsageCounts {
  return {
    calls: 0,
    loaded: 0,
    failed: 0,
    unresolved: 0,
    requests: 0,
    sessions: 0,
    lastUsedAt: null,
  };
}

function sumCounts(items: UsageCounts[]): UsageCounts {
  return items.reduce<UsageCounts>((sum, item) => {
    sum.calls += item.calls;
    sum.loaded += item.loaded;
    sum.failed += item.failed;
    sum.unresolved += item.unresolved;
    sum.requests += item.requests;
    return sum;
  }, emptyCounts());
}

function formatDate(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "未知";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function formatDateTime(value: string | null): string {
  if (!value) return "没有记录";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function addDaysIso(days: number): string {
  return new Date(Date.now() + days * dayMs).toISOString();
}

function isWeeklyReviewDue(lastReviewedAt: string | null): boolean {
  if (!lastReviewedAt) return true;
  const time = new Date(lastReviewedAt).getTime();
  return Number.isNaN(time) || Date.now() - time >= 7 * dayMs;
}

function relativeEvidenceFile(file: string): string {
  const normalized = file.replace(/\\/g, "/");
  const isAbsolute = normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized);
  const safeParts = normalized.split("/").filter((part) => part && part !== "." && part !== "..");
  if (safeParts.length === 0) return "未知文件";
  return isAbsolute ? (safeParts.at(-1) ?? "未知文件") : safeParts.join("/");
}

function eventStatusLabel(event: UsageEvent): string {
  if (event.kind === "request") return "显式请求";
  if (event.status === "loaded") return "成功返回";
  if (event.status === "failed") return "失败";
  return "结果未知";
}

function suggestionKindLabel(kind: UsageView["report"]["suggestions"][number]["kind"]): string {
  const labels = {
    "review-due": "到期复查",
    "identical-content": "内容相同",
    "idle-review": "闲置复查",
    "low-use": "低频复查",
  } satisfies Record<UsageView["report"]["suggestions"][number]["kind"], string>;
  return labels[kind];
}
