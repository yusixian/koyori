import type { SkillDiscussionDraft } from "@koyori/core";
import {
  Bot,
  CircleStop,
  KeyRound,
  MessageCirclePlus,
  Pencil,
  Plug,
  Send,
  Settings2,
  ShieldAlert,
  Sparkles,
  Trash2,
  Unplug,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentConnectionInput, AgentMessage, AgentView } from "../agent-types";
import "./agent.css";

type BusyAction = "connection" | "session" | "message" | "cancel" | null;

const emptyConnection: AgentConnectionInput = {
  name: "",
  baseUrl: "",
  model: "",
  apiKey: "",
};
const agentMessageCharacterLimit = 65_536;

interface AgentPanelProps {
  pendingDiscussion: SkillDiscussionDraft | null;
  onDismissDiscussion: () => void;
}

function formatTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formatSnapshotTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function messageState(message: AgentMessage) {
  if (message.status === "streaming") return "正在回复";
  if (message.status === "cancelled") return "已停止";
  if (message.status === "failed") return "发送失败";
  if (message.status === "interrupted") return "连接中断";
  if (!message.usage) return message.role === "assistant" ? "用量未知" : "已发送";
  const input = message.usage.inputTokens;
  const output = message.usage.outputTokens;
  if (input === null && output === null) return "用量未知";
  return `输入 ${input ?? "未知"} · 输出 ${output ?? "未知"} tokens`;
}

function latestUserText(messages: AgentMessage[], assistantId: string) {
  const assistantIndex = messages.findIndex((message) => message.id === assistantId);
  for (let index = assistantIndex - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user") return message.content;
  }
  return "";
}

export function AgentPanel({ pendingDiscussion, onDismissDiscussion }: AgentPanelProps) {
  const [view, setView] = useState<AgentView | null>(null);
  const [busy, setBusy] = useState<BusyAction>(null);
  const [error, setError] = useState("");
  const [showConnection, setShowConnection] = useState(false);
  const [connectionDraft, setConnectionDraft] = useState<AgentConnectionInput>(emptyConnection);
  const [draft, setDraft] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [discussionError, setDiscussionError] = useState("");
  const requestRef = useRef(0);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const deleteCancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    void loadAttempt;
    let disposed = false;
    const refresh = () => {
      const requestId = ++requestRef.current;
      void window.koyori
        .getAgent()
        .then((next) => {
          if (disposed || requestId !== requestRef.current) return;
          setView(next);
          setError("");
        })
        .catch(() => {
          if (!disposed && requestId === requestRef.current)
            setError("Agent 暂时无法打开，请稍后重试。");
        });
    };
    refresh();
    const unsubscribe = window.koyori.onAgentChanged(refresh);
    return () => {
      disposed = true;
      requestRef.current += 1;
      unsubscribe();
    };
  }, [loadAttempt]);

  useEffect(() => {
    if (!renamingId) return;
    const frame = requestAnimationFrame(() => renameInputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [renamingId]);

  useEffect(() => {
    if (!deletingId) return;
    const frame = requestAnimationFrame(() => deleteCancelRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [deletingId]);

  const selectedSession = useMemo(
    () => view?.sessions.find((session) => session.id === view.selectedSessionId) ?? null,
    [view],
  );
  const sessionIsCurrent = Boolean(
    view?.connection && selectedSession?.connectionId === view.connection.id,
  );
  const selectedIsRunning = view?.runningSessionId === selectedSession?.id;
  const canSend = Boolean(
    selectedSession && sessionIsCurrent && !view?.runningSessionId && draft.trim() && busy === null,
  );
  const discussionDraft = pendingDiscussion
    ? draft.length > 0
      ? `${draft}\n\n${pendingDiscussion.text}`
      : pendingDiscussion.text
    : "";
  const discussionTooLong = discussionDraft.length > agentMessageCharacterLimit;
  const canAppendDiscussion = Boolean(
    pendingDiscussion &&
      selectedSession &&
      sessionIsCurrent &&
      !view?.runningSessionId &&
      busy === null,
  );

  let discussionBlockedReason = "";
  if (pendingDiscussion) {
    if (!view?.connection) discussionBlockedReason = "先保存连接；摘要会继续留在这里。";
    else if (!selectedSession) discussionBlockedReason = "先为当前连接新建一段会话。";
    else if (!sessionIsCurrent)
      discussionBlockedReason = "当前是历史只读会话，请新建或切回当前连接的会话。";
    else if (view.runningSessionId)
      discussionBlockedReason = "当前回复结束或停止后，才能把摘要加入草稿。";
    else if (busy !== null) discussionBlockedReason = "Agent 正在处理其他操作，请稍后加入。";
  }

  function accept(next: AgentView) {
    requestRef.current += 1;
    setView(next);
    setError("");
  }

  async function recoverAfterFailure(fallback: string) {
    try {
      const latest = await window.koyori.getAgent();
      accept(latest);
      if (!latest.error) setError(fallback);
    } catch {
      setError(fallback);
    }
  }

  function openConnection() {
    setConnectionDraft({
      name: view?.connection?.name ?? "",
      baseUrl: view?.connection?.baseUrl ?? "",
      model: view?.connection?.model ?? "",
      apiKey: "",
    });
    setShowConnection(true);
  }

  async function saveConnection(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const input = {
      name: connectionDraft.name.trim(),
      baseUrl: connectionDraft.baseUrl.trim(),
      model: connectionDraft.model.trim(),
      apiKey: connectionDraft.apiKey,
    };
    let url: URL;
    try {
      url = new URL(input.baseUrl);
    } catch {
      setError("服务地址需要填写完整的 http 或 https 地址。");
      return;
    }
    if (!/^https?:$/.test(url.protocol)) {
      setError("服务地址需要使用 http 或 https。");
      return;
    }
    setConnectionDraft((current) => ({ ...current, apiKey: "" }));
    setBusy("connection");
    setError("");
    try {
      accept(await window.koyori.saveAgentConnection(input));
      setShowConnection(false);
      setDraft("");
    } catch {
      await recoverAfterFailure("连接设置没有保存，原来的连接保持不变。");
    } finally {
      setBusy(null);
    }
  }

  async function disconnect() {
    setBusy("connection");
    setError("");
    try {
      accept(await window.koyori.disconnectAgent());
      setShowConnection(false);
      setDraft("");
    } catch {
      await recoverAfterFailure("连接没有断开，请稍后重试。");
    } finally {
      setBusy(null);
    }
  }

  async function createSession() {
    setBusy("session");
    setError("");
    try {
      accept(await window.koyori.createAgentSession());
      setDraft("");
    } catch {
      await recoverAfterFailure("新会话没有创建，请稍后重试。");
    } finally {
      setBusy(null);
    }
  }

  async function selectSession(id: string) {
    if (id === view?.selectedSessionId) return;
    setBusy("session");
    setError("");
    setRenamingId(null);
    setDeletingId(null);
    try {
      accept(await window.koyori.selectAgentSession(id));
      setDraft("");
    } catch {
      await recoverAfterFailure("会话没有打开，请稍后重试。");
    } finally {
      setBusy(null);
    }
  }

  async function renameSession(event: React.FormEvent<HTMLFormElement>, sessionId: string) {
    event.preventDefault();
    const title = renameDraft.trim();
    if (!title) return;
    setBusy("session");
    setError("");
    try {
      accept(await window.koyori.renameAgentSession(sessionId, title));
      setRenamingId(null);
    } catch {
      await recoverAfterFailure("会话名称没有保存，请稍后重试。");
    } finally {
      setBusy(null);
    }
  }

  async function deleteSession(sessionId: string) {
    setBusy("session");
    setError("");
    try {
      accept(await window.koyori.deleteAgentSession(sessionId));
      setDeletingId(null);
      if (view?.selectedSessionId === sessionId) setDraft("");
    } catch {
      await recoverAfterFailure("本地会话没有删除，请稍后重试。");
    } finally {
      setBusy(null);
    }
  }

  async function sendMessage() {
    if (!selectedSession || !canSend) return;
    const text = draft.trim();
    setDraft("");
    setBusy("message");
    setError("");
    try {
      accept(await window.koyori.sendAgentMessage(selectedSession.id, text));
    } catch {
      setDraft(text);
      await recoverAfterFailure("消息没有发出。内容已保留，你可以检查连接后再次发送。");
    } finally {
      setBusy(null);
    }
  }

  async function cancelRun() {
    setBusy("cancel");
    setError("");
    try {
      accept(await window.koyori.cancelAgentRun());
    } catch {
      await recoverAfterFailure("停止请求没有完成，请稍后重试。当前回复状态仍以消息记录为准。");
    } finally {
      setBusy(null);
    }
  }

  function editFailedMessage(message: AgentMessage) {
    if (!selectedSession) return;
    setDraft(latestUserText(selectedSession.messages, message.id));
    requestAnimationFrame(() => composerRef.current?.focus());
  }

  function appendDiscussion() {
    if (!pendingDiscussion || !canAppendDiscussion) return;
    if (discussionTooLong) {
      setDiscussionError(
        `加入后将超过 ${agentMessageCharacterLimit.toLocaleString("zh-CN")} 个字符。请先缩短当前草稿，或丢弃这份摘要。`,
      );
      return;
    }
    setDraft(discussionDraft);
    setDiscussionError("");
    onDismissDiscussion();
    requestAnimationFrame(() => composerRef.current?.focus());
  }

  function dismissDiscussion() {
    setDiscussionError("");
    onDismissDiscussion();
  }

  if (!view) {
    return (
      <section className="agent-panel agent-loading" aria-busy={!error}>
        <Sparkles size={22} />
        <div>
          <h1>{error ? "Agent 未能打开" : "正在打开 Agent"}</h1>
          <p>{error || "正在读取本机会话与连接设置…"}</p>
          {error && (
            <button
              type="button"
              className="agent-button"
              onClick={() => {
                setError("");
                setLoadAttempt((value) => value + 1);
              }}
            >
              重新读取
            </button>
          )}
        </div>
      </section>
    );
  }

  return (
    <section className="agent-panel" aria-labelledby="agent-title">
      <header className="agent-heading">
        <div>
          <p className="agent-kicker">PERSONAL AGENT</p>
          <h1 id="agent-title">一处安静的文字对话。</h1>
          <p>消息只会在你按下发送后交给当前服务；仅主动加入的摘要会随文字发送。</p>
        </div>
        <div className="agent-heading-actions">
          {view.runningSessionId && (
            <button
              type="button"
              className="agent-button agent-stop-button"
              disabled={busy !== null}
              onClick={() => void cancelRun()}
            >
              <CircleStop size={16} />
              {busy === "cancel" ? "正在停止" : "停止生成"}
            </button>
          )}
          <button type="button" className="agent-button" onClick={openConnection}>
            <Settings2 size={16} />
            连接设置
          </button>
        </div>
      </header>

      {(error || view.error) && (
        <div className="agent-alert" role="alert">
          <span>{error || view.error}</span>
          {error && (
            <button type="button" aria-label="关闭提示" onClick={() => setError("")}>
              <X size={15} />
            </button>
          )}
        </div>
      )}

      {(showConnection || !view.connection) && (
        <section className="agent-connection-editor" aria-labelledby="agent-connection-title">
          <div className="agent-section-heading">
            <div>
              <p className="agent-kicker">OPENAI-COMPATIBLE</p>
              <h2 id="agent-connection-title">
                {view.connection ? "更改当前连接" : "配置文字模型"}
              </h2>
            </div>
            {view.connection && (
              <button
                type="button"
                className="agent-icon-button"
                aria-label="关闭连接设置"
                disabled={busy === "connection"}
                onClick={() => setShowConnection(false)}
              >
                <X size={17} />
              </button>
            )}
          </div>
          <p className="agent-connection-note">
            保存只记录设置，不会探测服务或调用模型。更改连接后会新建会话；已有会话仍可查看，但不会发送给新目标。
          </p>
          {view.secureStorageAvailable === false && (
            <div className="agent-storage-warning" role="status">
              <ShieldAlert size={17} />
              <span>
                上次访问系统安全存储未成功。解锁钥匙串后可重新保存；无需密钥的本机服务仍可配置。
              </span>
            </div>
          )}
          <form className="agent-connection-form" onSubmit={(event) => void saveConnection(event)}>
            <label>
              <span>连接名称</span>
              <input
                required
                disabled={busy === "connection"}
                value={connectionDraft.name}
                placeholder="例如：本机模型"
                onChange={(event) =>
                  setConnectionDraft((current) => ({ ...current, name: event.target.value }))
                }
              />
            </label>
            <label className="agent-wide-field">
              <span id="agent-base-url-label">服务地址</span>
              <input
                required
                type="url"
                disabled={busy === "connection"}
                aria-labelledby="agent-base-url-label"
                aria-describedby="agent-base-url-help"
                value={connectionDraft.baseUrl}
                placeholder="http://127.0.0.1:11434/v1"
                onChange={(event) =>
                  setConnectionDraft((current) => ({ ...current, baseUrl: event.target.value }))
                }
              />
              <small id="agent-base-url-help">填写服务提供方给出的完整 API 基址，例如 /v1。</small>
            </label>
            <label>
              <span>模型</span>
              <input
                required
                disabled={busy === "connection"}
                value={connectionDraft.model}
                placeholder="模型 ID"
                onChange={(event) =>
                  setConnectionDraft((current) => ({ ...current, model: event.target.value }))
                }
              />
            </label>
            <label>
              <span id="agent-key-label">API Key</span>
              <span className="agent-key-field">
                <KeyRound size={15} />
                <input
                  type="password"
                  autoComplete="new-password"
                  disabled={busy === "connection"}
                  aria-labelledby="agent-key-label"
                  aria-describedby="agent-key-help"
                  value={connectionDraft.apiKey}
                  placeholder={
                    view.connection?.keyConfigured
                      ? "已保存；如需沿用请重新填写"
                      : "保存后不会再次显示"
                  }
                  onChange={(event) =>
                    setConnectionDraft((current) => ({ ...current, apiKey: event.target.value }))
                  }
                />
              </span>
              <small id="agent-key-help">
                保存密钥或使用已保存的密钥发送消息时，系统可能请求钥匙串授权。
              </small>
            </label>
            <div className="agent-connection-actions">
              {view.connection && (
                <button
                  type="button"
                  className="agent-text-button agent-danger-text"
                  disabled={busy !== null}
                  onClick={() => void disconnect()}
                >
                  <Unplug size={15} />
                  断开连接
                </button>
              )}
              <button
                type="submit"
                className="agent-button agent-primary-button"
                disabled={busy !== null}
              >
                <Plug size={16} />
                {busy === "connection" ? "正在保存" : "保存连接"}
              </button>
            </div>
          </form>
        </section>
      )}

      <section className="agent-status-strip" aria-label="当前连接信息">
        {view.connection ? (
          <>
            <span className="agent-status-dot" aria-hidden="true" />
            <strong>{view.connection.name}</strong>
            <span>数据去向：{view.connection.baseUrl}</span>
            <span>模型：{view.connection.model}</span>
            <span>{view.connection.keyConfigured ? "密钥已安全保存" : "未使用密钥"}</span>
          </>
        ) : (
          <>
            <span className="agent-status-dot agent-status-dot-muted" aria-hidden="true" />
            <strong>尚未配置连接</strong>
            <span>当前不会向任何模型服务发送消息。</span>
          </>
        )}
      </section>

      {pendingDiscussion && (
        <section className="agent-discussion-preview" aria-label="Skill 讨论摘要">
          <div className="agent-discussion-heading">
            <div>
              <p className="agent-kicker">LOCAL PREVIEW</p>
              <h2>{pendingDiscussion.skillName} · 使用证据摘要</h2>
            </div>
            <span>近 {pendingDiscussion.windowDays} 天</span>
          </div>
          <p className="agent-discussion-boundary">
            这是本机预览，尚未发送。摘要只含 Skill
            名称、使用统计、保留或复查偏好与整理规则，不附加全文、路径或会话原文；名称本身可能私密，加入后仍可编辑。
          </p>
          <dl className="agent-discussion-meta">
            <div>
              <dt>快照时间</dt>
              <dd>{formatSnapshotTime(pendingDiscussion.generatedAt)}</dd>
            </div>
            <div>
              <dt>数据去向</dt>
              <dd>
                {view.connection
                  ? `${view.connection.name} · ${view.connection.baseUrl} · ${view.connection.model}`
                  : "尚未配置连接；当前不会发送"}
              </dd>
            </div>
          </dl>
          <details open className="agent-discussion-details">
            <summary>查看完整待发送摘要</summary>
            <pre>{pendingDiscussion.text}</pre>
          </details>
          {(discussionBlockedReason || discussionTooLong || discussionError) && (
            <p className="agent-discussion-warning" role="status">
              {discussionError ||
                discussionBlockedReason ||
                `当前草稿加入摘要后将超过 ${agentMessageCharacterLimit.toLocaleString("zh-CN")} 个字符。`}
            </p>
          )}
          <div className="agent-discussion-actions">
            <button
              type="button"
              className="agent-button agent-primary-button"
              disabled={!canAppendDiscussion}
              onClick={appendDiscussion}
            >
              加入当前草稿
            </button>
            <button
              type="button"
              className="agent-text-button agent-danger-text"
              onClick={dismissDiscussion}
            >
              丢弃摘要
            </button>
          </div>
        </section>
      )}

      <div className="agent-workspace">
        <aside className="agent-sessions" aria-label="Agent 会话">
          <div className="agent-section-heading">
            <div>
              <p className="agent-kicker">SESSIONS</p>
              <h2>会话</h2>
            </div>
            <button
              type="button"
              className="agent-icon-button agent-new-session"
              aria-label="新建会话"
              title="新建会话"
              disabled={!view.connection || busy !== null}
              onClick={() => void createSession()}
            >
              <MessageCirclePlus size={18} />
            </button>
          </div>
          {view.sessions.length === 0 ? (
            <div className="agent-sessions-empty">
              <p>还没有会话。</p>
              <button
                type="button"
                className="agent-text-button"
                disabled={!view.connection || busy !== null}
                onClick={() => void createSession()}
              >
                新建第一段对话
              </button>
            </div>
          ) : (
            <div className="agent-session-list">
              {view.sessions.map((session) => {
                const selected = session.id === view.selectedSessionId;
                const current = session.connectionId === view.connection?.id;
                return (
                  <div
                    className={`agent-session-row${selected ? " agent-selected" : ""}`}
                    key={session.id}
                  >
                    {renamingId === session.id ? (
                      <form
                        className="agent-rename-form"
                        onSubmit={(event) => void renameSession(event, session.id)}
                      >
                        <label>
                          <span className="agent-visually-hidden">会话名称</span>
                          <input
                            ref={renameInputRef}
                            disabled={busy !== null}
                            value={renameDraft}
                            onChange={(event) => setRenameDraft(event.target.value)}
                            onKeyDown={(event) => {
                              if (event.key === "Escape") setRenamingId(null);
                            }}
                          />
                        </label>
                        <button type="submit" disabled={!renameDraft.trim() || busy !== null}>
                          保存
                        </button>
                        <button
                          type="button"
                          disabled={busy !== null}
                          onClick={() => setRenamingId(null)}
                        >
                          取消
                        </button>
                      </form>
                    ) : deletingId === session.id ? (
                      <div className="agent-delete-confirm" role="alert">
                        <p>删除这段本地历史？删除后无法恢复。</p>
                        <span>
                          <button
                            ref={deleteCancelRef}
                            type="button"
                            disabled={busy !== null}
                            onClick={() => setDeletingId(null)}
                          >
                            保留
                          </button>
                          <button
                            type="button"
                            className="agent-danger-text"
                            disabled={busy !== null}
                            onClick={() => void deleteSession(session.id)}
                          >
                            确认删除
                          </button>
                        </span>
                      </div>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="agent-session-select"
                          aria-current={selected ? "page" : undefined}
                          disabled={busy !== null}
                          onClick={() => void selectSession(session.id)}
                        >
                          <strong>{session.title}</strong>
                          <span>
                            {formatTime(session.createdAt)} · {session.model}
                          </span>
                          {!current && <small>历史连接 · 只读</small>}
                          {view.runningSessionId === session.id && <small>正在回复</small>}
                        </button>
                        <span className="agent-session-actions">
                          <button
                            type="button"
                            aria-label="重命名会话"
                            title={`重命名“${session.title}”`}
                            disabled={busy !== null}
                            onClick={() => {
                              setRenamingId(session.id);
                              setDeletingId(null);
                              setRenameDraft(session.title);
                            }}
                          >
                            <Pencil size={13} />
                          </button>
                          <button
                            type="button"
                            aria-label="删除会话"
                            title={`删除“${session.title}”`}
                            disabled={busy !== null || view.runningSessionId === session.id}
                            onClick={() => {
                              setDeletingId(session.id);
                              setRenamingId(null);
                            }}
                          >
                            <Trash2 size={13} />
                          </button>
                        </span>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </aside>

        <section className="agent-conversation" aria-label="当前会话">
          {!selectedSession ? (
            <div className="agent-empty-state">
              <span className="agent-empty-mark">
                <Bot size={30} />
              </span>
              <h2>{view.connection ? "新建一段对话" : "先配置你的文字模型"}</h2>
              <p>
                {view.connection
                  ? "会话会绑定当前连接。你可以随时停止回复，也可以回看旧连接留下的历史。"
                  : "填写服务地址与模型后再开始。保存设置本身不会访问网络。"}
              </p>
              <button
                type="button"
                className="agent-button agent-primary-button"
                onClick={view.connection ? () => void createSession() : openConnection}
              >
                {view.connection ? <MessageCirclePlus size={16} /> : <Plug size={16} />}
                {view.connection ? "新建会话" : "连接设置"}
              </button>
            </div>
          ) : (
            <>
              <header className="agent-conversation-heading">
                <div>
                  <h2>{selectedSession.title}</h2>
                  <p>
                    {selectedSession.connectionName} · {selectedSession.model}
                  </p>
                </div>
                {!sessionIsCurrent && <span className="agent-readonly-badge">历史只读</span>}
              </header>

              <div className="agent-messages" aria-live="polite">
                {selectedSession.messages.length === 0 ? (
                  <div className="agent-message-empty">
                    <Sparkles size={19} />
                    <p>
                      写下第一条消息。仅主动加入的摘要会随文字发送，其余 Skill 内容不会自动附带。
                    </p>
                  </div>
                ) : (
                  selectedSession.messages.map((message) => (
                    <article
                      key={message.id}
                      className={`agent-message agent-message-${message.role}`}
                    >
                      <header>
                        <strong>{message.role === "user" ? "你" : "Agent"}</strong>
                        <time dateTime={message.createdAt}>{formatTime(message.createdAt)}</time>
                      </header>
                      <div className="agent-message-content">{message.content}</div>
                      <footer>
                        <span data-status={message.status}>{messageState(message)}</span>
                        {message.error && (
                          <span className="agent-message-error">{message.error}</span>
                        )}
                        {(message.status === "failed" || message.status === "interrupted") &&
                          sessionIsCurrent &&
                          !view.runningSessionId && (
                            <button type="button" onClick={() => editFailedMessage(message)}>
                              重新编辑并发送
                            </button>
                          )}
                      </footer>
                    </article>
                  ))
                )}
              </div>

              <div className="agent-composer">
                {!sessionIsCurrent && (
                  <p className="agent-composer-note">
                    这段会话属于“{selectedSession.connectionName}”，只能查看，不能发送给当前连接。
                  </p>
                )}
                {view.runningSessionId && !selectedIsRunning && (
                  <p className="agent-composer-note">
                    另一段会话正在回复。停止或等待完成后再发送。
                  </p>
                )}
                <label>
                  <span id="agent-message-label" className="agent-visually-hidden">
                    消息
                  </span>
                  <textarea
                    ref={composerRef}
                    aria-labelledby="agent-message-label"
                    rows={3}
                    value={draft}
                    disabled={!sessionIsCurrent || Boolean(view.runningSessionId) || busy !== null}
                    placeholder={sessionIsCurrent ? "写一条消息…" : "历史会话为只读"}
                    onChange={(event) => {
                      setDraft(event.target.value);
                      if (discussionError) setDiscussionError("");
                    }}
                    onKeyDown={(event) => {
                      if (
                        event.key === "Enter" &&
                        !event.shiftKey &&
                        !event.nativeEvent.isComposing &&
                        canSend
                      ) {
                        event.preventDefault();
                        void sendMessage();
                      }
                    }}
                  />
                </label>
                <div className="agent-composer-footer">
                  <span>Enter 发送 · Shift + Enter 换行</span>
                  {selectedIsRunning ? (
                    <button
                      type="button"
                      className="agent-button agent-stop-button"
                      disabled={busy !== null}
                      onClick={() => void cancelRun()}
                    >
                      <CircleStop size={16} />
                      停止生成
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="agent-button agent-primary-button"
                      disabled={!canSend}
                      onClick={() => void sendMessage()}
                    >
                      <Send size={16} />
                      {busy === "message" ? "正在发送" : "发送"}
                    </button>
                  )}
                </div>
              </div>
            </>
          )}
        </section>
      </div>
    </section>
  );
}
