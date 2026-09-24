import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { ipcMain, safeStorage } from "electron";
import type {
  AgentConnection,
  AgentConnectionInput,
  AgentConnectionProbeInput,
  AgentConnectionProbeResult,
  AgentMessage,
  AgentProviderRequest,
  AgentSession,
  AgentUsage,
  AgentView,
} from "../agent-types";
import {
  discoverAgentModels,
  ProviderFailure,
  streamAgentResponse,
  validateAgentBaseUrl,
} from "./agent-provider";

export const AGENT_MAX_SESSIONS = 50;
export const AGENT_MAX_MESSAGES_PER_SESSION = 200;
export const AGENT_MAX_MESSAGE_CHARACTERS = 65_536;
export const AGENT_MAX_STORE_BYTES = 16 * 1024 * 1024;

const AGENT_MAX_CONNECTION_NAME_CHARACTERS = 100;
const AGENT_MAX_MODEL_CHARACTERS = 200;
const AGENT_MAX_TITLE_CHARACTERS = 80;
const AGENT_MAX_API_KEY_CHARACTERS = 8_192;
const AGENT_MAX_ERROR_CHARACTERS = 500;
const AGENT_STREAM_PERSIST_INTERVAL_MS = 150;

class AgentPersistenceError extends Error {}

interface StoredConnection {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  encryptedApiKey: string | null;
}

interface AgentSettingsV1 {
  version: 1;
  connection: StoredConnection | null;
  sessions: AgentSession[];
  selectedSessionId: string | null;
  lastError: string | null;
}

export interface AgentCipher {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

export interface AgentControllerDependencies {
  path: string;
  trusted(event: Electron.IpcMainInvokeEvent): void;
  changed(): void;
  cipher?: AgentCipher;
  validateBaseUrl?: (value: string) => string;
  streamResponse?: (request: AgentProviderRequest) => Promise<void>;
  discoverModels?: typeof discoverAgentModels;
  now?: () => Date;
  id?: () => string;
  persist?: (path: string, settings: unknown) => Promise<void>;
  streamPersistIntervalMs?: number;
}

interface ActiveRun {
  sessionId: string;
  assistantMessageId: string;
  controller: AbortController;
  content: string;
  usage: AgentUsage | null;
  callbackError: Error | null;
  persistenceError: Error | null;
  dirty: boolean;
  flushScheduled: boolean;
  flushPromise: Promise<void>;
  settled: Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function boundedString(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length <= maximum;
}

function nonEmptyString(value: unknown, maximum: number): value is string {
  return boundedString(value, maximum) && value.trim().length > 0;
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validUsage(value: unknown): value is AgentUsage | null {
  if (value === null) return true;
  if (!isRecord(value) || !hasOnlyKeys(value, ["inputTokens", "outputTokens"])) return false;
  return [value.inputTokens, value.outputTokens].every(
    (item) =>
      item === null || (typeof item === "number" && Number.isSafeInteger(item) && item >= 0),
  );
}

function validEncryptedValue(value: unknown): value is string {
  return nonEmptyString(value, 32_768) && Buffer.from(value, "base64").toString("base64") === value;
}

function validMessage(value: unknown): value is AgentMessage {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["id", "role", "content", "createdAt", "status", "usage", "error"])
  )
    return false;
  return (
    nonEmptyString(value.id, 100) &&
    (value.role === "user" || value.role === "assistant") &&
    boundedString(value.content, AGENT_MAX_MESSAGE_CHARACTERS) &&
    validTimestamp(value.createdAt) &&
    ["complete", "streaming", "cancelled", "failed", "interrupted"].includes(
      String(value.status),
    ) &&
    validUsage(value.usage) &&
    (value.error === null || boundedString(value.error, AGENT_MAX_ERROR_CHARACTERS))
  );
}

function validSession(value: unknown): value is AgentSession {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "id",
      "connectionId",
      "connectionName",
      "model",
      "title",
      "createdAt",
      "messages",
    ])
  )
    return false;
  return (
    nonEmptyString(value.id, 100) &&
    nonEmptyString(value.connectionId, 100) &&
    nonEmptyString(value.connectionName, AGENT_MAX_CONNECTION_NAME_CHARACTERS) &&
    nonEmptyString(value.model, AGENT_MAX_MODEL_CHARACTERS) &&
    nonEmptyString(value.title, AGENT_MAX_TITLE_CHARACTERS) &&
    validTimestamp(value.createdAt) &&
    Array.isArray(value.messages) &&
    value.messages.length <= AGENT_MAX_MESSAGES_PER_SESSION &&
    value.messages.every(validMessage) &&
    value.messages.length % 2 === 0 &&
    value.messages.every((message, index) =>
      index % 2 === 0
        ? message.role === "user" &&
          message.status === "complete" &&
          message.usage === null &&
          message.error === null
        : message.role === "assistant",
    ) &&
    new Set(value.messages.map((message) => message.id)).size === value.messages.length
  );
}

function validConnection(value: unknown): value is StoredConnection {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["id", "name", "baseUrl", "model", "encryptedApiKey"])
  )
    return false;
  return (
    nonEmptyString(value.id, 100) &&
    nonEmptyString(value.name, AGENT_MAX_CONNECTION_NAME_CHARACTERS) &&
    nonEmptyString(value.baseUrl, 2_048) &&
    nonEmptyString(value.model, AGENT_MAX_MODEL_CHARACTERS) &&
    (value.encryptedApiKey === null || validEncryptedValue(value.encryptedApiKey))
  );
}

function parseSettings(value: unknown): AgentSettingsV1 {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["version", "connection", "sessions", "selectedSessionId", "lastError"]) ||
    value.version !== 1 ||
    (value.connection !== null && !validConnection(value.connection)) ||
    !Array.isArray(value.sessions) ||
    value.sessions.length > AGENT_MAX_SESSIONS ||
    !value.sessions.every(validSession) ||
    (value.selectedSessionId !== null && !nonEmptyString(value.selectedSessionId, 100)) ||
    (value.lastError !== null && !boundedString(value.lastError, AGENT_MAX_ERROR_CHARACTERS))
  ) {
    throw new Error("无法读取 Agent 数据：文件格式或版本无效，原文件已保留。");
  }
  const sessions = value.sessions;
  if (new Set(sessions.map((session) => session.id)).size !== sessions.length) {
    throw new Error("无法读取 Agent 数据：会话标识重复，原文件已保留。");
  }
  if (
    value.selectedSessionId !== null &&
    !sessions.some((session) => session.id === value.selectedSessionId)
  ) {
    throw new Error("无法读取 Agent 数据：选中的会话不存在，原文件已保留。");
  }
  return {
    version: 1,
    connection: value.connection,
    sessions,
    selectedSessionId: value.selectedSessionId,
    lastError: value.lastError,
  };
}

function emptySettings(): AgentSettingsV1 {
  return { version: 1, connection: null, sessions: [], selectedSessionId: null, lastError: null };
}

function errorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}

async function readSettings(path: string): Promise<AgentSettingsV1> {
  try {
    const metadata = await stat(path);
    if (metadata.size > AGENT_MAX_STORE_BYTES) {
      throw new Error("无法读取 Agent 数据：文件超过容量限制，原文件已保留。");
    }
    const raw = await readFile(path, "utf8");
    return parseSettings(JSON.parse(raw) as unknown);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return emptySettings();
    if (error instanceof SyntaxError) {
      throw new Error("无法读取 Agent 数据：JSON 已损坏，原文件已保留。", { cause: error });
    }
    throw error;
  }
}

async function writeSettings(path: string, settings: AgentSettingsV1): Promise<void> {
  const parsed = parseSettings(settings);
  const serialized = `${JSON.stringify(parsed, null, 2)}\n`;
  if (Buffer.byteLength(serialized) > AGENT_MAX_STORE_BYTES) {
    throw new Error("Agent 数据超过本地容量限制，请删除旧会话。");
  }
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const backupTemporary = `${path}.${randomUUID()}.bak.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await stat(path);
      await copyFile(path, backupTemporary);
      await rename(backupTemporary, `${path}.bak`);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
    await rename(temporary, path);
  } finally {
    if (handle) await handle.close().catch(() => {});
    await unlink(temporary).catch((error: unknown) => {
      if (errorCode(error) !== "ENOENT") throw error;
    });
    await unlink(backupTemporary).catch((error: unknown) => {
      if (errorCode(error) !== "ENOENT") throw error;
    });
  }
}

function publicConnection(connection: StoredConnection | null): AgentConnection | null {
  if (!connection) return null;
  return {
    id: connection.id,
    name: connection.name,
    baseUrl: connection.baseUrl,
    model: connection.model,
    keyConfigured: connection.encryptedApiKey !== null,
  };
}

function safeMessage(error: unknown, secrets: readonly string[] = []): string {
  let message = error instanceof Error ? error.message : "Agent 请求失败。";
  for (const secret of secrets) {
    if (secret) message = message.split(secret).join("[REDACTED]");
  }
  return message.slice(0, AGENT_MAX_ERROR_CHARACTERS) || "Agent 请求失败。";
}

function sessionWithMessage(
  settings: AgentSettingsV1,
  sessionId: string,
  messageId: string,
  update: (message: AgentMessage) => AgentMessage,
): AgentSettingsV1 {
  return {
    ...settings,
    sessions: settings.sessions.map((session) =>
      session.id === sessionId
        ? {
            ...session,
            messages: session.messages.map((message) =>
              message.id === messageId ? update(message) : message,
            ),
          }
        : session,
    ),
  };
}

function successfulHistory(session: AgentSession): AgentProviderRequest["messages"] {
  const messages: AgentProviderRequest["messages"] = [];
  for (let index = 0; index + 1 < session.messages.length; index += 2) {
    const user = session.messages[index];
    const assistant = session.messages[index + 1];
    if (
      user?.role === "user" &&
      user.status === "complete" &&
      assistant?.role === "assistant" &&
      assistant.status === "complete"
    ) {
      messages.push(
        { role: "user", content: user.content },
        { role: "assistant", content: assistant.content },
      );
    }
  }
  return messages;
}

function requireNoArguments(args: unknown[]): void {
  if (args.length !== 0) throw new Error("无效的 Agent 请求参数。");
}

function requireId(value: unknown): string {
  if (!nonEmptyString(value, 100)) throw new Error("无效的会话标识。");
  return value;
}

function requireText(value: unknown, maximum: number, label: string): string {
  if (!nonEmptyString(value, maximum)) throw new Error(`${label}不能为空或超过长度限制。`);
  return value.trim();
}

function requireConnectionInput(value: unknown): AgentConnectionInput {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["name", "baseUrl", "model", "apiKey"]) ||
    !nonEmptyString(value.name, AGENT_MAX_CONNECTION_NAME_CHARACTERS) ||
    !nonEmptyString(value.baseUrl, 2_048) ||
    !nonEmptyString(value.model, AGENT_MAX_MODEL_CHARACTERS) ||
    !boundedString(value.apiKey, AGENT_MAX_API_KEY_CHARACTERS)
  ) {
    throw new Error("无效的 Agent 连接配置。");
  }
  return {
    name: value.name.trim(),
    baseUrl: value.baseUrl.trim(),
    model: value.model.trim(),
    apiKey: value.apiKey,
  };
}

function requireProbeInput(value: unknown): AgentConnectionProbeInput {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["baseUrl", "apiKey"]) ||
    !nonEmptyString(value.baseUrl, 2_048) ||
    !boundedString(value.apiKey, AGENT_MAX_API_KEY_CHARACTERS)
  ) {
    throw new Error("无效的连接测试参数。");
  }
  return { baseUrl: value.baseUrl.trim(), apiKey: value.apiKey };
}

function requireUsage(value: AgentUsage): AgentUsage {
  if (!validUsage(value) || value === null) throw new Error("Provider 返回了无效的用量信息。");
  return { inputTokens: value.inputTokens, outputTokens: value.outputTokens };
}

export async function createAgentController(deps: AgentControllerDependencies) {
  const cipher = deps.cipher ?? safeStorage;
  const validateBaseUrl = deps.validateBaseUrl ?? validateAgentBaseUrl;
  const streamResponse = deps.streamResponse ?? streamAgentResponse;
  const discoverModels = deps.discoverModels ?? discoverAgentModels;
  const now = deps.now ?? (() => new Date());
  const id = deps.id ?? randomUUID;
  const persist =
    deps.persist ?? ((path: string, value: unknown) => writeSettings(path, parseSettings(value)));
  const streamPersistIntervalMs = deps.streamPersistIntervalMs ?? AGENT_STREAM_PERSIST_INTERVAL_MS;
  if (!Number.isSafeInteger(streamPersistIntervalMs) || streamPersistIntervalMs < 0) {
    throw new Error("Agent 流式保存间隔无效。");
  }
  let settings = await readSettings(deps.path);
  let stopped = false;
  let active: ActiveRun | undefined;
  let writeTail = Promise.resolve();
  let operationTail = Promise.resolve();
  let pendingPersistenceError: AgentPersistenceError | undefined;
  let secureStorageAvailable: boolean | null = null;

  let recoveredStreaming = false;
  const recoveredSessions = settings.sessions.map((session) => {
    const messages = session.messages.map((message) => {
      if (message.status !== "streaming") return message;
      recoveredStreaming = true;
      return {
        ...message,
        status: "interrupted" as const,
        error: "应用在生成完成前退出。",
      };
    });
    return messages.some((message, index) => message !== session.messages[index])
      ? { ...session, messages }
      : session;
  });
  if (recoveredStreaming) {
    settings = { ...settings, sessions: recoveredSessions };
    await persist(deps.path, settings);
  }

  function probeEncryptionAvailability(): boolean {
    try {
      secureStorageAvailable = cipher.isEncryptionAvailable();
    } catch {
      secureStorageAvailable = false;
    }
    return secureStorageAvailable;
  }

  function view(): AgentView {
    return {
      connection: publicConnection(settings.connection),
      sessions: settings.sessions.map((session) => ({
        ...session,
        messages: session.messages.map((message) => ({
          ...message,
          usage: message.usage ? { ...message.usage } : null,
        })),
      })),
      selectedSessionId: settings.selectedSessionId,
      runningSessionId: active?.sessionId ?? null,
      secureStorageAvailable,
      error: settings.lastError,
    };
  }

  function commit(update: (current: AgentSettingsV1) => AgentSettingsV1): Promise<AgentSettingsV1> {
    const job = writeTail.then(async () => {
      const next = parseSettings(update(settings));
      await persist(deps.path, next);
      settings = next;
      pendingPersistenceError = undefined;
      deps.changed();
      return next;
    });
    writeTail = job.then(
      () => undefined,
      () => undefined,
    );
    return job.catch((error: unknown) => {
      const diagnostic = "Agent 数据保存失败，请检查应用数据目录。";
      const persistenceError = new AgentPersistenceError(diagnostic, { cause: error });
      pendingPersistenceError = persistenceError;
      settings = { ...settings, lastError: diagnostic };
      deps.changed();
      throw persistenceError;
    });
  }

  function exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = operationTail.then(operation);
    operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  function ensureRunning(): void {
    if (stopped) throw new Error("Agent controller 已停止。");
  }

  function findSession(sessionId: string): AgentSession {
    const session = settings.sessions.find((candidate) => candidate.id === sessionId);
    if (!session) throw new Error("会话不存在。");
    return session;
  }

  function decryptApiKey(connection: StoredConnection): string {
    if (!connection.encryptedApiKey) return "";
    if (!probeEncryptionAvailability()) {
      throw new Error("系统安全存储当前不可用，无法使用此连接。");
    }
    try {
      return cipher.decryptString(Buffer.from(connection.encryptedApiKey, "base64"));
    } catch (error) {
      throw new Error("无法解密 Agent API Key，请重新保存连接。", { cause: error });
    }
  }

  function applyRunSnapshot(current: AgentSettingsV1, run: ActiveRun): AgentSettingsV1 {
    return sessionWithMessage(current, run.sessionId, run.assistantMessageId, (message) => ({
      ...message,
      content: run.content,
      usage: run.usage,
    }));
  }

  function scheduleRunPersist(run: ActiveRun): void {
    run.dirty = true;
    if (run.flushScheduled || run.persistenceError) return;
    run.flushScheduled = true;
    run.flushPromise = (async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, streamPersistIntervalMs));
      if (run.dirty && !run.persistenceError) {
        run.dirty = false;
        await commit((current) => applyRunSnapshot(current, run));
      }
    })()
      .catch((error: unknown) => {
        run.persistenceError = error instanceof Error ? error : new Error("Agent 数据保存失败。");
        run.dirty = false;
        run.controller.abort(run.persistenceError);
      })
      .finally(() => {
        run.flushScheduled = false;
        if (run.dirty && !run.persistenceError) scheduleRunPersist(run);
      });
  }

  async function flushRunPersist(run: ActiveRun): Promise<void> {
    while (run.flushScheduled || run.dirty) {
      if (run.persistenceError) throw run.persistenceError;
      if (run.dirty && !run.flushScheduled) scheduleRunPersist(run);
      await run.flushPromise;
    }
    if (run.persistenceError) throw run.persistenceError;
  }

  async function finishRun(
    run: ActiveRun,
    status: "complete" | "cancelled" | "failed",
    error: string | null,
  ): Promise<void> {
    try {
      await commit((current) => ({
        ...sessionWithMessage(current, run.sessionId, run.assistantMessageId, (message) => ({
          ...message,
          content: run.content,
          status,
          usage: run.usage,
          error,
        })),
        lastError: status === "failed" ? error : null,
      }));
    } catch (persistError) {
      const diagnostic =
        persistError instanceof AgentPersistenceError
          ? persistError.message
          : "Agent 数据保存失败，请检查应用数据目录。";
      settings = {
        ...sessionWithMessage(settings, run.sessionId, run.assistantMessageId, (message) => ({
          ...message,
          content: run.content,
          status: "failed",
          usage: run.usage,
          error: diagnostic,
        })),
        lastError: diagnostic,
      };
      deps.changed();
    }
  }

  async function executeRun(
    run: ActiveRun,
    request: Omit<AgentProviderRequest, "apiKey" | "signal" | "onText" | "onUsage">,
    apiKey: string,
  ): Promise<void> {
    let status: "complete" | "cancelled" | "failed" = "complete";
    let error: string | null = null;
    try {
      await streamResponse({
        ...request,
        apiKey,
        signal: run.controller.signal,
        onText(text) {
          if (run.controller.signal.aborted || active !== run) return;
          if (typeof text !== "string") {
            run.callbackError = new Error("Provider 返回了无效的文本增量。");
            run.controller.abort(run.callbackError);
            throw run.callbackError;
          }
          if (run.content.length + text.length > AGENT_MAX_MESSAGE_CHARACTERS) {
            run.callbackError = new Error("Agent 回复超过本地消息容量限制。");
            run.controller.abort(run.callbackError);
            throw run.callbackError;
          }
          run.content += text;
          scheduleRunPersist(run);
        },
        onUsage(usage) {
          if (run.controller.signal.aborted || active !== run) return;
          try {
            run.usage = requireUsage(usage);
            scheduleRunPersist(run);
          } catch (usageError) {
            run.callbackError =
              usageError instanceof Error ? usageError : new Error("Provider 用量信息无效。");
            run.controller.abort(run.callbackError);
            throw run.callbackError;
          }
        },
      });
      await flushRunPersist(run);
      if (run.controller.signal.aborted) status = run.callbackError ? "failed" : "cancelled";
      if (status === "failed") {
        error = safeMessage(run.callbackError ?? run.persistenceError, [apiKey]);
      }
    } catch (requestError) {
      await flushRunPersist(run).catch(() => {});
      if (run.callbackError || run.persistenceError) {
        status = "failed";
        error = safeMessage(run.callbackError ?? run.persistenceError, [apiKey]);
      } else if (run.controller.signal.aborted) {
        status = "cancelled";
      } else {
        status = "failed";
        error = safeMessage(requestError, [apiKey]);
      }
    }
    await finishRun(run, status, error);
    if (active === run) active = undefined;
    deps.changed();
  }

  async function cancelActive(): Promise<void> {
    const run = active;
    if (!run) return;
    run.controller.abort(new Error("Agent 请求已取消。"));
    await run.settled;
  }

  async function saveConnection(value: unknown): Promise<AgentView> {
    return exclusive(async () => {
      ensureRunning();
      const input = requireConnectionInput(value);
      const baseUrl = validateBaseUrl(input.baseUrl);
      if (settings.sessions.length >= AGENT_MAX_SESSIONS) {
        throw new Error(`会话数量已达到 ${AGENT_MAX_SESSIONS} 个上限，请先删除旧会话。`);
      }
      let encryptedApiKey: string | null = null;
      if (input.apiKey.length > 0) {
        if (!probeEncryptionAvailability()) {
          throw new Error("系统安全存储不可用，无法保存 API Key。");
        }
        try {
          encryptedApiKey = cipher.encryptString(input.apiKey).toString("base64");
        } catch (error) {
          throw new Error("无法使用系统安全存储保存 API Key。", { cause: error });
        }
      } else if (settings.connection?.baseUrl === baseUrl) {
        encryptedApiKey = settings.connection.encryptedApiKey;
      }
      await cancelActive();
      const connectionId = id();
      const session: AgentSession = {
        id: id(),
        connectionId,
        connectionName: input.name,
        model: input.model,
        title: "新会话",
        createdAt: now().toISOString(),
        messages: [],
      };
      await commit((current) => ({
        version: 1,
        connection: {
          id: connectionId,
          name: input.name,
          baseUrl,
          model: input.model,
          encryptedApiKey,
        },
        sessions: [session, ...current.sessions],
        selectedSessionId: session.id,
        lastError: null,
      }));
      return view();
    });
  }

  async function probeConnection(value: unknown): Promise<AgentConnectionProbeResult> {
    ensureRunning();
    const input = requireProbeInput(value);
    let apiKey = input.apiKey;
    try {
      const baseUrl = validateBaseUrl(input.baseUrl);
      if (!apiKey && settings.connection?.encryptedApiKey) {
        if (baseUrl !== settings.connection.baseUrl) {
          throw new Error("测试新服务地址时，请重新填写 API Key。");
        }
        apiKey = decryptApiKey(settings.connection);
      }
      const result = await discoverModels({ baseUrl, apiKey });
      return { ok: true, status: result.status, models: result.models, error: null };
    } catch (error) {
      return {
        ok: false,
        status: error instanceof ProviderFailure ? error.status : null,
        models: [],
        error: safeMessage(error, [apiKey]),
      };
    }
  }

  async function disconnect(): Promise<AgentView> {
    return exclusive(async () => {
      ensureRunning();
      await cancelActive();
      await commit((current) => ({ ...current, connection: null, lastError: null }));
      return view();
    });
  }

  async function createSession(): Promise<AgentView> {
    return exclusive(async () => {
      ensureRunning();
      const connection = settings.connection;
      if (!connection) throw new Error("请先保存 Agent 连接。");
      if (settings.sessions.length >= AGENT_MAX_SESSIONS) {
        throw new Error(`会话数量已达到 ${AGENT_MAX_SESSIONS} 个上限，请先删除旧会话。`);
      }
      const session: AgentSession = {
        id: id(),
        connectionId: connection.id,
        connectionName: connection.name,
        model: connection.model,
        title: "新会话",
        createdAt: now().toISOString(),
        messages: [],
      };
      await commit((current) => ({
        ...current,
        sessions: [session, ...current.sessions],
        selectedSessionId: session.id,
        lastError: null,
      }));
      return view();
    });
  }

  async function selectSession(value: unknown): Promise<AgentView> {
    return exclusive(async () => {
      ensureRunning();
      const sessionId = requireId(value);
      findSession(sessionId);
      await commit((current) => ({ ...current, selectedSessionId: sessionId, lastError: null }));
      return view();
    });
  }

  async function renameSession(idValue: unknown, titleValue: unknown): Promise<AgentView> {
    return exclusive(async () => {
      ensureRunning();
      const sessionId = requireId(idValue);
      const title = requireText(titleValue, AGENT_MAX_TITLE_CHARACTERS, "会话名称");
      findSession(sessionId);
      await commit((current) => ({
        ...current,
        sessions: current.sessions.map((session) =>
          session.id === sessionId ? { ...session, title } : session,
        ),
        lastError: null,
      }));
      return view();
    });
  }

  async function deleteSession(value: unknown): Promise<AgentView> {
    return exclusive(async () => {
      ensureRunning();
      const sessionId = requireId(value);
      findSession(sessionId);
      if (active?.sessionId === sessionId) await cancelActive();
      await commit((current) => {
        const sessions = current.sessions.filter((session) => session.id !== sessionId);
        const selectedSessionId =
          current.selectedSessionId === sessionId
            ? (sessions.find((session) => session.connectionId === current.connection?.id)?.id ??
              sessions[0]?.id ??
              null)
            : current.selectedSessionId;
        return { ...current, sessions, selectedSessionId, lastError: null };
      });
      return view();
    });
  }

  async function send(sessionValue: unknown, textValue: unknown): Promise<AgentView> {
    return exclusive(async () => {
      ensureRunning();
      if (active) throw new Error("已有 Agent 请求正在进行，请先取消或等待完成。");
      const sessionId = requireId(sessionValue);
      const text = requireText(textValue, AGENT_MAX_MESSAGE_CHARACTERS, "消息");
      const connection = settings.connection;
      if (!connection) throw new Error("请先保存 Agent 连接。");
      const session = findSession(sessionId);
      if (session.connectionId !== connection.id) {
        throw new Error("旧连接的会话为只读，请在当前连接中新建会话。");
      }
      if (session.messages.length + 2 > AGENT_MAX_MESSAGES_PER_SESSION) {
        throw new Error(`此会话已达到 ${AGENT_MAX_MESSAGES_PER_SESSION} 条消息上限，请新建会话。`);
      }
      const apiKey = decryptApiKey(connection);
      const createdAt = now().toISOString();
      const userMessage: AgentMessage = {
        id: id(),
        role: "user",
        content: text,
        createdAt,
        status: "complete",
        usage: null,
        error: null,
      };
      const assistantMessage: AgentMessage = {
        id: id(),
        role: "assistant",
        content: "",
        createdAt,
        status: "streaming",
        usage: null,
        error: null,
      };
      const messages = [...successfulHistory(session), { role: "user" as const, content: text }];
      await commit((current) => ({
        ...current,
        sessions: current.sessions.map((candidate) =>
          candidate.id === sessionId
            ? { ...candidate, messages: [...candidate.messages, userMessage, assistantMessage] }
            : candidate,
        ),
        selectedSessionId: sessionId,
        lastError: null,
      }));
      const run: ActiveRun = {
        sessionId,
        assistantMessageId: assistantMessage.id,
        controller: new AbortController(),
        content: "",
        usage: null,
        callbackError: null,
        persistenceError: null,
        dirty: false,
        flushScheduled: false,
        flushPromise: Promise.resolve(),
        settled: Promise.resolve(),
      };
      active = run;
      run.settled = executeRun(
        run,
        { baseUrl: connection.baseUrl, model: connection.model, messages },
        apiKey,
      );
      deps.changed();
      return view();
    });
  }

  async function cancel(): Promise<AgentView> {
    return exclusive(async () => {
      await cancelActive();
      return view();
    });
  }

  async function stop(): Promise<void> {
    await exclusive(async () => {
      if (stopped) {
        if (pendingPersistenceError) throw pendingPersistenceError;
        return;
      }
      await cancelActive();
      stopped = true;
      await writeTail;
      if (pendingPersistenceError) throw pendingPersistenceError;
    });
  }

  function register(name: string, count: number, handler: (...args: unknown[]) => unknown): void {
    ipcMain.handle(name, async (event, ...args: unknown[]) => {
      deps.trusted(event);
      try {
        if (args.length !== count) throw new Error("无效的 Agent 请求参数。");
        return await handler(...args);
      } catch (error) {
        const message =
          error instanceof AgentPersistenceError
            ? error.message
            : safeMessage(error).includes(dirname(deps.path))
              ? "Agent 操作失败，请检查应用数据目录。"
              : safeMessage(error);
        settings = { ...settings, lastError: message };
        deps.changed();
        throw new Error(message, { cause: error });
      }
    });
  }

  register("agent:get", 0, (...args) => {
    requireNoArguments(args);
    return view();
  });
  register("agent:connection:save", 1, saveConnection);
  register("agent:connection:probe", 1, probeConnection);
  register("agent:disconnect", 0, disconnect);
  register("agent:session:create", 0, createSession);
  register("agent:session:select", 1, selectSession);
  register("agent:session:rename", 2, renameSession);
  register("agent:session:delete", 1, deleteSession);
  register("agent:send", 2, send);
  register("agent:cancel", 0, cancel);

  return {
    getView: view,
    cancel,
    stop,
    isBusy: () => active !== undefined,
  };
}
