import type {
  ClientId,
  DiscoveryIssue,
  ResourceRoot,
  SkillDiscussionDraft,
  SkillInventory,
  SkillRecord,
  SkillUsage,
  UsageView,
} from "@koyori/core";
import {
  ArrowUpRight,
  BookOpen,
  ChevronRight,
  FolderPlus,
  Layers3,
  Link2,
  MessageCircle,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import logo from "../../../../brand/logo.png";
import type { SourceTarget } from "../bridge";
import "./style.css";
import { AgentPanel } from "./AgentPanel";
import { CollectionPanel } from "./CollectionPanel";
import { ManagementPanel } from "./ManagementPanel";
import { UpdatePanel } from "./UpdatePanel";
import { UsagePanel } from "./UsagePanel";

type Page = "skills" | "agent" | "services";
const names = { "claude-code": "Claude Code", codex: "Codex" };
function usageLabel(usage: SkillUsage | undefined) {
  if (!usage || usage.status === "not-connected") return "尚未采集";
  if (usage.status === "unknown") return "证据不足";
  if (usage.status === "ambiguous") return "同名待归属";
  return `${usage.calls} 次尝试 · ${usage.loaded} 次成功返回`;
}
const sample: SkillInventory = {
  scannedAt: new Date(0).toISOString(),
  issues: [],
  skills: [
    {
      id: "sample-design",
      name: "design-review",
      description: "从布局、可读性与交互状态检查一份界面设计。",
      client: "claude-code",
      path: "示例 / design-review / SKILL.md",
      rootId: "example",
      isSymlink: false,
      contentTruncated: false,
      content:
        "---\nname: design-review\ndescription: 检查界面设计\n---\n\n# Design review\n\n检查信息层级、键盘操作、空状态与错误提示。\n\n这是内置示例，没有读取本机文件。",
    },
    {
      id: "sample-release",
      name: "release-checklist",
      description: "发布前确认版本、变更记录和安装包验收。",
      client: "codex",
      path: "示例 / release-checklist / SKILL.md",
      rootId: "example",
      isSymlink: false,
      contentTruncated: false,
      content:
        "# Release checklist\n\n- 核对版本\n- 阅读更新说明\n- 验证同一份安装包\n\n这是合成示例。",
    },
    {
      id: "sample-notes",
      name: "project-notes",
      description: "把本次工作中需要保留的决定整理为项目笔记。",
      client: "codex",
      path: "示例 / project-notes / SKILL.md",
      rootId: "example",
      isSymlink: false,
      contentTruncated: false,
      content:
        "# Project notes\n\n记录有证据的决定和未解决的问题，区分完成与计划。\n\n这是合成示例。",
    },
  ],
};
function App() {
  const [page, setPage] = useState<Page>("skills");
  const [roots, setRoots] = useState<ResourceRoot[]>([]);
  const [targets, setTargets] = useState<SourceTarget[]>([]);
  const [automaticDiscovery, setAutomaticDiscovery] = useState(true);
  const [discoveryIssues, setDiscoveryIssues] = useState<DiscoveryIssue[]>([]);
  const [managementSkill, setManagementSkill] = useState<string | null>(null);
  const [inventory, setInventory] = useState<SkillInventory | null>(null);
  const [example, setExample] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | ClientId>("all");
  const [client, setClient] = useState<ClientId>("claude-code");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [showSources, setShowSources] = useState(false);
  const [usage, setUsage] = useState<UsageView | null>(null);
  const [skillView, setSkillView] = useState<"inventory" | "usage" | "manage">("inventory");
  const [pendingDiscussion, setPendingDiscussion] = useState<SkillDiscussionDraft | null>(null);
  const [discussionBusyId, setDiscussionBusyId] = useState<string | null>(null);
  const workspaceRequestRef = useRef(0);
  useEffect(() => {
    let disposed = false;
    const update = () => {
      const requestId = ++workspaceRequestRef.current;
      void window.koyori
        .getWorkspace()
        .then((view) => {
          if (disposed || requestId !== workspaceRequestRef.current) return;
          setRoots(view.roots);
          setTargets(view.targets);
          setAutomaticDiscovery(view.automaticDiscovery);
          setDiscoveryIssues(view.discoveryIssues);
          setInventory(view.inventory);
          setBusy(view.busy);
          if (view.error) setError(view.error);
        })
        .catch(() => {
          if (!disposed && requestId === workspaceRequestRef.current)
            setError("来源设置读取失败，请重启后重试。");
        });
    };
    update();
    const unsubscribe = window.koyori.onWorkspaceChanged(update);
    return () => {
      disposed = true;
      workspaceRequestRef.current += 1;
      unsubscribe();
    };
  }, []);
  async function refreshWorkspace() {
    const requestId = ++workspaceRequestRef.current;
    const view = await window.koyori.getWorkspace();
    if (requestId !== workspaceRequestRef.current) return;
    setRoots(view.roots);
    setTargets(view.targets);
    setInventory(view.inventory);
    setAutomaticDiscovery(view.automaticDiscovery);
    setDiscoveryIssues(view.discoveryIssues);
  }
  const current = example ? sample : inventory;
  const skills = useMemo(
    () =>
      (current?.skills ?? []).filter(
        (item) =>
          (filter === "all" || item.client === filter) &&
          `${item.name} ${item.description} ${item.path}`
            .toLowerCase()
            .includes(query.toLowerCase()),
      ),
    [current, filter, query],
  );
  const detail = skills.find((item) => item.id === selected);
  async function prepareDiscussion(skillId: string) {
    if (example || pendingDiscussion || discussionBusyId) return;
    setDiscussionBusyId(skillId);
    setError("");
    try {
      const windowDays = usage?.report.windowDays === 30 ? 30 : 90;
      const next = await window.koyori.prepareSkillDiscussion(skillId, windowDays);
      setPendingDiscussion(next);
      setPage("agent");
    } catch {
      setError("使用证据摘要没有准备好。原有资源和会话保持不变，可以稍后重试。");
    } finally {
      setDiscussionBusyId(null);
    }
  }
  async function scan() {
    setBusy(true);
    setError("");
    setExample(false);
    setSelected(null);
    try {
      setInventory(await window.koyori.scan());
    } catch {
      setError("扫描未完成或已取消。上次扫描结果已保留，可以重新扫描。");
    } finally {
      setBusy(false);
    }
  }
  async function addSource() {
    setBusy(true);
    setError("");
    try {
      const root = await window.koyori.addRoot(client);
      if (root) {
        await refreshWorkspace();
        setExample(false);
        setSelected(null);
        setShowSources(true);
      }
    } catch {
      setError("无法添加来源，请检查目录和应用数据目录权限。");
    } finally {
      setBusy(false);
    }
  }
  async function removeSource(id: string) {
    setBusy(true);
    setError("");
    try {
      await window.koyori.removeRoot(id);
      await refreshWorkspace();
      setSelected(null);
    } catch {
      setError("来源移除失败，请稍后重试。");
    } finally {
      setBusy(false);
    }
  }
  function tryExample() {
    setExample(true);
    setSkillView("inventory");
    setSelected(null);
    setQuery("");
    setFilter("all");
  }
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="drag-zone" />
        <div className="brand">
          <img src={logo} alt="Koyori 角色" />
          <div>
            <strong>
              Koyori<span>こより</span>
            </strong>
            <small>自己的工作台</small>
          </div>
        </div>
        <p className="nav-label">WORKSPACE</p>
        <nav aria-label="工作台导航">
          <button
            type="button"
            className={page === "skills" ? "nav-item active" : "nav-item"}
            onClick={() => setPage("skills")}
          >
            <Layers3 size={18} />
            Skills
            <span className="nav-dot" />
          </button>
          <button
            type="button"
            className={page === "agent" ? "nav-item active" : "nav-item"}
            onClick={() => setPage("agent")}
          >
            <MessageCircle size={18} />
            Agent
          </button>
          <button
            type="button"
            className={page === "services" ? "nav-item active" : "nav-item"}
            onClick={() => setPage("services")}
          >
            <Link2 size={18} />
            我的服务<small>筹备中</small>
          </button>
        </nav>
        <div className="sidebar-note">
          <span className="leaf">✦</span>
          <p>
            从一份清楚的清单开始，
            <br />
            慢慢长成你的工作台。
          </p>
        </div>
        <div className="sidebar-bottom">
          <button
            type="button"
            className="nav-item"
            onClick={() => {
              setPage("skills");
              setShowSources((value) => !value);
            }}
          >
            <Settings2 size={17} />
            来源设置
          </button>
          <button
            type="button"
            className="nav-item"
            onClick={() => {
              void window.koyori.openProject().catch(() => setError("无法打开项目页面。"));
            }}
          >
            <BookOpen size={17} />
            项目与文档
            <ArrowUpRight size={13} />
          </button>
          <UpdatePanel />
        </div>
      </aside>
      <main>
        <header className="topbar">
          <span>
            Koyori <ChevronRight size={13} />{" "}
            {page === "skills" ? "Skills" : page === "agent" ? "Agent" : "我的服务"}
          </span>
          <span className="local">
            <span />
            本机工作台
          </span>
        </header>
        <div hidden={page !== "agent"}>
          <AgentPanel
            pendingDiscussion={pendingDiscussion}
            onDismissDiscussion={() => setPendingDiscussion(null)}
          />
        </div>
        {page === "skills" ? (
          <>
            <section className="page-heading">
              <div>
                <p className="eyebrow">YOUR TOOLKIT</p>
                <h1>每一份能力，都有来处。</h1>
                <p>把 Skills 放在一起看清楚，再决定怎么整理。</p>
              </div>
              <div className="heading-mark">
                <Layers3 size={29} />
              </div>
            </section>
            {!example && (
              <nav className="skill-views" aria-label="Skills 视图">
                <button
                  type="button"
                  aria-pressed={skillView === "inventory"}
                  onClick={() => setSkillView("inventory")}
                >
                  资源清单
                </button>
                <button
                  type="button"
                  aria-pressed={skillView === "usage"}
                  onClick={() => setSkillView("usage")}
                >
                  使用与建议
                </button>
                <button
                  type="button"
                  aria-pressed={skillView === "manage"}
                  onClick={() => setSkillView("manage")}
                >
                  同步与备份
                </button>
              </nav>
            )}
            <div className="toolbar">
              {skillView === "inventory" && (
                <>
                  <label className="search">
                    <Search size={17} />
                    <input
                      aria-label="搜索 Skills"
                      placeholder="搜索名称、描述或路径…"
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                    />
                  </label>
                  <select
                    aria-label="筛选客户端"
                    value={filter}
                    onChange={(event) => {
                      const value = event.target.value;
                      if (value === "all" || value === "claude-code" || value === "codex")
                        setFilter(value);
                    }}
                  >
                    <option value="all">全部客户端</option>
                    <option value="claude-code">Claude Code</option>
                    <option value="codex">Codex</option>
                  </select>
                </>
              )}
              <button
                type="button"
                className="button"
                disabled={busy || roots.length === 0}
                onClick={() => {
                  void scan();
                }}
              >
                <RefreshCw size={15} className={busy ? "spinning" : ""} />
                扫描
              </button>
              <button
                type="button"
                className="button primary"
                disabled={busy}
                onClick={() => setShowSources(true)}
              >
                <FolderPlus size={16} />
                添加来源
              </button>
            </div>
            {showSources && (
              <section className="sources" aria-label="来源设置">
                <div className="section-title">
                  <h2>已自动发现本机来源</h2>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label="关闭来源设置"
                    onClick={() => setShowSources(false)}
                  >
                    <X size={16} />
                  </button>
                </div>
                <p>自动检测 Claude Code 和 Codex 的常用目录。自定义位置和项目也可以添加。</p>
                {discoveryIssues.length > 0 && (
                  <details>
                    <summary>{discoveryIssues.length} 条自动检测提示</summary>
                    {discoveryIssues.map((issue) => (
                      <div className="issue" key={`${issue.path}-${issue.code}-${issue.message}`}>
                        <strong>{issue.code}</strong>
                        <span>{issue.message}</span>
                        <code>{issue.path}</code>
                      </div>
                    ))}
                  </details>
                )}
                <div className="source-controls">
                  <label className="management-check">
                    <input
                      type="checkbox"
                      checked={automaticDiscovery}
                      disabled={busy}
                      onChange={(event) => {
                        void window.koyori
                          .setAutomaticDiscovery(event.target.checked)
                          .then(refreshWorkspace)
                          .catch(() => setError("无法保存自动发现设置。"));
                      }}
                    />
                    启动时与运行期间自动检测
                  </label>
                  <button
                    className="button"
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void window.koyori
                        .discoverSources()
                        .then(refreshWorkspace)
                        .catch(() => setError("自动检测未完成。"))
                    }
                  >
                    重新检测目录
                  </button>
                  <button
                    className="text-button"
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void window.koyori
                        .discoverSources(true)
                        .then(refreshWorkspace)
                        .catch(() => setError("无法恢复已忽略来源。"))
                    }
                  >
                    重新发现已忽略目录
                  </button>
                  <button
                    className="button"
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void window.koyori
                        .addProject()
                        .then(refreshWorkspace)
                        .catch(() => setError("无法添加项目。"))
                    }
                  >
                    关联项目
                  </button>
                </div>
                <div className="source-controls">
                  <select
                    aria-label="添加来源的客户端"
                    value={client}
                    onChange={(event) => {
                      if (event.target.value === "claude-code" || event.target.value === "codex")
                        setClient(event.target.value);
                    }}
                  >
                    <option value="claude-code">Claude Code</option>
                    <option value="codex">Codex</option>
                  </select>
                  <button
                    type="button"
                    className="button primary"
                    disabled={busy}
                    onClick={() => {
                      void addSource();
                    }}
                  >
                    <FolderPlus size={15} />
                    选择目录
                  </button>
                </div>
                {roots.map((root) => (
                  <div className="source-row" key={root.id}>
                    <div>
                      <strong>{names[root.client]}</strong>
                      <code>{root.path}</code>
                    </div>
                    <button
                      type="button"
                      className="text-button"
                      disabled={busy}
                      onClick={() => {
                        void removeSource(root.id);
                      }}
                    >
                      移除来源
                    </button>
                  </div>
                ))}
                <small>移除后不会自动重新连接，原文件保留。需要时可重新发现已忽略目录。</small>
              </section>
            )}
            {error && (
              <div role="alert" className="notice error">
                {error}
                <button
                  type="button"
                  className="icon-button"
                  aria-label="关闭错误提示"
                  onClick={() => setError("")}
                >
                  <X size={15} />
                </button>
              </div>
            )}
            {example && (
              <div className="notice">
                <Sparkles size={16} />
                <span>示例模式 · 以下资源为合成示例，没有读取本机文件。</span>
                <button
                  type="button"
                  className="text-button"
                  onClick={() => {
                    setExample(false);
                    setSelected(null);
                  }}
                >
                  退出示例
                </button>
              </div>
            )}
            {busy && (
              <div role="status" className="notice">
                <span>正在处理目录…</span>
                <button
                  type="button"
                  className="text-button"
                  onClick={() => {
                    void window.koyori
                      .cancelScan()
                      .catch(() => setError("取消请求失败，请稍后重试。"));
                  }}
                >
                  取消扫描
                </button>
              </div>
            )}
            <div hidden={skillView !== "inventory"}>
              <div className={detail ? "workspace with-detail" : "workspace"}>
                <section className="inventory" aria-label="Skills 清单">
                  <div className="list-caption">
                    <span>
                      SKILLS <b>{skills.length}</b>
                    </span>
                    <span>{example ? "合成示例" : `${roots.length} 个已连接来源`}</span>
                  </div>
                  {skills.length ? (
                    <div className="skill-list">
                      {skills.map((item) => (
                        <button
                          type="button"
                          key={item.id}
                          className={`skill-row ${selected === item.id ? "selected" : ""}`}
                          onClick={() => setSelected(item.id)}
                        >
                          <span className="skill-symbol">
                            <Layers3 size={20} />
                          </span>
                          <span className="skill-info">
                            <strong>{item.name}</strong>
                            <span>{item.description || "暂无描述，可打开查看原文。"}</span>
                            <small>
                              {names[item.client]}
                              {item.isSymlink ? " · 链接资源" : ""}
                            </small>
                          </span>
                          <span className="usage">
                            {example ? "使用情况" : `近 ${usage?.report.windowDays ?? 90} 天`}
                            <small>
                              {example
                                ? "合成示例"
                                : usageLabel(
                                    usage?.report.skills.find((entry) => entry.skillId === item.id),
                                  )}
                            </small>
                          </span>
                          <ChevronRight size={16} />
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div className="empty">
                      <div className="empty-symbol">
                        <FolderPlus size={33} />
                      </div>
                      <h2>
                        {query || filter !== "all"
                          ? "没有匹配的 Skill"
                          : current
                            ? "这次没有发现 Skill"
                            : "正在发现本机 Skills"}
                      </h2>
                      <p>
                        {query || filter !== "all"
                          ? "试试另一个关键词，或者切换客户端。"
                          : current
                            ? "常用目录中暂未发现 Skill。可以添加自定义来源，或查看扫描提示。"
                            : "正在检查 Claude Code 和 Codex 的常用目录。原文件会留在原处。"}
                      </p>
                      {(!current || current.skills.length === 0) && (
                        <div className="empty-actions">
                          <button
                            type="button"
                            className="button primary"
                            disabled={busy}
                            onClick={() => setShowSources(true)}
                          >
                            <FolderPlus size={16} />
                            连接本机资源
                          </button>
                          <button type="button" className="text-button" onClick={tryExample}>
                            先看看示例 <ArrowUpRight size={14} />
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                  <div className="inventory-footer">
                    <ShieldCheck size={14} />
                    <span>只读扫描 · 发现资源不代表客户端已经加载</span>
                  </div>
                </section>
                {detail && (
                  <Detail
                    skill={detail}
                    usage={
                      example
                        ? undefined
                        : usage?.report.skills.find((entry) => entry.skillId === detail.id)
                    }
                    close={() => setSelected(null)}
                    manage={
                      example
                        ? undefined
                        : () => {
                            setManagementSkill(detail.id);
                            setSkillView("manage");
                          }
                    }
                    discuss={
                      example
                        ? undefined
                        : () => {
                            void prepareDiscussion(detail.id);
                          }
                    }
                    discussionBusy={discussionBusyId !== null}
                    pendingDiscussionName={pendingDiscussion?.skillName}
                    goToAgent={() => setPage("agent")}
                  />
                )}
              </div>
              {!example && inventory && (
                <section className="scan-report">
                  <p>
                    最近扫描：{new Date(inventory.scannedAt).toLocaleString("zh-CN")} ·
                    次数来自另行选择的会话目录，尚未连接时保留未知状态。
                  </p>
                  {inventory.issues.length > 0 && (
                    <details>
                      <summary>{inventory.issues.length} 条扫描提示</summary>
                      {inventory.issues.map((issue) => (
                        <div className="issue" key={`${issue.path}-${issue.code}-${issue.message}`}>
                          <strong>{issue.code}</strong>
                          <span>{issue.message}</span>
                          <code>{issue.path}</code>
                        </div>
                      ))}
                    </details>
                  )}
                </section>
              )}
            </div>
            {!example && (
              <div hidden={skillView !== "usage"}>
                <CollectionPanel />
                <UsagePanel inventory={inventory} roots={roots} onChange={setUsage} />
              </div>
            )}
            {!example && (
              <div hidden={skillView !== "manage"}>
                <ManagementPanel
                  inventory={inventory}
                  targets={targets}
                  initialSkillId={managementSkill}
                  onChanged={() =>
                    void refreshWorkspace().catch(() => setError("无法刷新资源状态。"))
                  }
                />
              </div>
            )}
          </>
        ) : page === "services" ? (
          <section className="coming">
            <img src={logo} alt="Koyori" />
            <p className="eyebrow">YOUR CONNECTIONS</p>
            <h1>常用的服务，也可以在这里。</h1>
            <p>计划先接入 cos-tool-bot，让桌面成为自己的服务入口。私有能力和凭据继续留在服务器。</p>
            <div className="planned">
              <span>当前状态</span>
              <strong>尚未接入</strong>
              <p>Bot 桌面通道仍待实现。现在可以在 Agent 中配置自己的模型，开始文字对话。</p>
            </div>
            <button type="button" className="button" onClick={() => setPage("skills")}>
              先整理 Skills <ChevronRight size={15} />
            </button>
          </section>
        ) : null}
      </main>
    </div>
  );
}
function Detail({
  skill,
  usage,
  close,
  manage,
  discuss,
  discussionBusy,
  pendingDiscussionName,
  goToAgent,
}: {
  skill: SkillRecord;
  usage?: SkillUsage;
  close: () => void;
  manage?: () => void;
  discuss?: () => void;
  discussionBusy: boolean;
  pendingDiscussionName?: string;
  goToAgent: () => void;
}) {
  return (
    <aside className="detail" aria-label="Skill 详情">
      <div className="section-title">
        <p className="eyebrow">SKILL DETAIL</p>
        <button type="button" className="icon-button" aria-label="关闭详情" onClick={close}>
          <X size={17} />
        </button>
      </div>
      <h2>{skill.name}</h2>
      <p>{skill.description || "未提供描述"}</p>
      <div className="detail-actions">
        {discuss && (
          <button
            className="button primary"
            type="button"
            disabled={discussionBusy || Boolean(pendingDiscussionName)}
            onClick={discuss}
          >
            <MessageCircle size={15} />
            {discussionBusy ? "正在准备摘要…" : "和 Koyori 讨论"}
          </button>
        )}
        {pendingDiscussionName && (
          <button className="text-button" type="button" onClick={goToAgent}>
            前往 Agent 处理摘要 <ChevronRight size={14} />
          </button>
        )}
        {manage && (
          <button className="button" type="button" onClick={manage}>
            同步或备份这份 Skill <ChevronRight size={15} />
          </button>
        )}
      </div>
      {pendingDiscussionName && (
        <p className="detail-pending-note">
          “{pendingDiscussionName}”的摘要正在 Agent 中等待处理，不会被新的摘要覆盖。
        </p>
      )}
      <dl>
        <dt>客户端</dt>
        <dd>{names[skill.client]}</dd>
        <dt>使用证据</dt>
        <dd>{usageLabel(usage)}</dd>
        <dt>来源路径</dt>
        <dd className="path">{skill.path}</dd>
      </dl>
      <div className="preview-heading">
        SKILL.md <span>纯文本预览</span>
      </div>
      <pre>{skill.content}</pre>
      {skill.contentTruncated && <p className="muted">文件较大，仅显示前段内容。</p>}
      <p className="detail-note">浏览保持只读。同步与恢复会先展示计划，再由你确认。</p>
    </aside>
  );
}
const root = document.getElementById("root");
if (!root) throw new Error("Missing application root");
createRoot(root).render(<App />);
