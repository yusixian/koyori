import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConnectionProbeResult, AgentProviderRequest, AgentView } from "../agent-types";

type Handler = (event: unknown, ...args: unknown[]) => unknown;

const electronMocks = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  handle: vi.fn((name: string, handler: Handler) => {
    electronMocks.handlers.set(name, handler);
  }),
}));

vi.mock("electron", () => ({
  ipcMain: { handle: electronMocks.handle },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => {
      throw new Error("safeStorage should be injected in tests");
    },
    decryptString: () => {
      throw new Error("safeStorage should be injected in tests");
    },
  },
}));

import type { AgentCipher } from "./agent-controller";
import { createAgentController } from "./agent-controller";
import type { discoverAgentModels } from "./agent-provider";

const availableCipher: AgentCipher = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(`sealed:${value}`, "utf8"),
  decryptString: (value) => value.toString("utf8").replace(/^sealed:/, ""),
};

const connectionInput = {
  name: "Personal",
  baseUrl: "https://provider.example/v1/",
  model: "test-model",
  apiKey: "private-key",
};

let roots: string[] = [];

beforeEach(() => {
  electronMocks.handlers.clear();
  electronMocks.handle.mockClear();
});

afterEach(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  roots = [];
});

async function fixture(
  options: {
    cipher?: AgentCipher;
    streamResponse?: (request: AgentProviderRequest) => Promise<void>;
    discoverModels?: typeof discoverAgentModels;
    persist?: (path: string, settings: unknown) => Promise<void>;
    validateBaseUrl?: (value: string) => string;
    streamPersistIntervalMs?: number;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "koyori-agent-controller-"));
  roots.push(root);
  const path = join(root, "agent.json");
  let sequence = 0;
  const trusted = vi.fn();
  const changed = vi.fn();
  const controller = await createAgentController({
    path,
    trusted,
    changed,
    cipher: options.cipher ?? availableCipher,
    validateBaseUrl: options.validateBaseUrl ?? ((value) => value.replace(/\/+$/, "")),
    streamResponse: options.streamResponse ?? (async () => {}),
    discoverModels: options.discoverModels,
    persist: options.persist,
    streamPersistIntervalMs: options.streamPersistIntervalMs ?? 0,
    now: () => new Date("2026-09-22T00:00:00.000Z"),
    id: () => `id-${++sequence}`,
  });
  return { root, path, controller, trusted, changed };
}

async function invoke<T>(name: string, ...args: unknown[]): Promise<T> {
  const handler = electronMocks.handlers.get(name);
  if (!handler) throw new Error(`Missing IPC handler: ${name}`);
  return (await handler({ sender: "trusted-test-sender" }, ...args)) as T;
}

async function saveConnection(): Promise<AgentView> {
  return invoke<AgentView>("agent:connection:save", connectionInput);
}

async function waitForIdle(controller: { isBusy(): boolean }): Promise<void> {
  await vi.waitFor(() => expect(controller.isBusy()).toBe(false));
}

function selectedSessionId(view: AgentView): string {
  if (!view.selectedSessionId) throw new Error("Expected a selected session");
  return view.selectedSessionId;
}

function sessionFrom(view: AgentView, sessionId: string) {
  const session = view.sessions.find((candidate) => candidate.id === sessionId);
  if (!session) throw new Error(`Expected session ${sessionId}`);
  return session;
}

function hasCompletedAssistant(value: unknown): boolean {
  if (typeof value !== "object" || value === null || !("sessions" in value)) return false;
  const sessions = value.sessions;
  if (!Array.isArray(sessions)) return false;
  return sessions.some((session) => {
    if (typeof session !== "object" || session === null || !("messages" in session)) return false;
    const messages = session.messages;
    return (
      Array.isArray(messages) &&
      messages.some(
        (message) =>
          typeof message === "object" &&
          message !== null &&
          "role" in message &&
          message.role === "assistant" &&
          "status" in message &&
          message.status === "complete",
      )
    );
  });
}

describe("agent controller", () => {
  it("tests a draft without saving it and reuses a stored key only for the same URL", async () => {
    const discoverModels = vi.fn(async () => ({ status: 200, models: ["fixture-model"] }));
    const { path, controller, changed } = await fixture({ discoverModels });
    await saveConnection();
    const before = await readFile(path, "utf8");
    changed.mockClear();

    const result = await invoke<AgentConnectionProbeResult>("agent:connection:probe", {
      baseUrl: connectionInput.baseUrl,
      apiKey: "",
    });
    expect(result).toEqual({ ok: true, status: 200, models: ["fixture-model"], error: null });
    expect(discoverModels).toHaveBeenCalledWith({
      baseUrl: "https://provider.example/v1",
      apiKey: "private-key",
    });
    expect(changed).not.toHaveBeenCalled();
    expect(await readFile(path, "utf8")).toBe(before);

    const changedUrl = await invoke<AgentConnectionProbeResult>("agent:connection:probe", {
      baseUrl: "https://other.example/v1",
      apiKey: "",
    });
    expect(changedUrl.ok).toBe(false);
    expect(changedUrl.error).toContain("重新填写 API Key");
    expect(discoverModels).toHaveBeenCalledTimes(1);

    const saved = await invoke<AgentView>("agent:connection:save", {
      ...connectionInput,
      model: "other-model",
      apiKey: "",
    });
    expect(saved.connection?.keyConfigured).toBe(true);
    expect(await readFile(path, "utf8")).toContain(
      Buffer.from("sealed:private-key").toString("base64"),
    );
    await controller.stop();
  });
  it("encrypts the API key at rest, never returns it, and writes a backup", async () => {
    const { path, controller } = await fixture();

    const saved = await saveConnection();
    expect(JSON.stringify(saved)).not.toContain(connectionInput.apiKey);
    expect(saved.connection).toMatchObject({
      name: "Personal",
      baseUrl: "https://provider.example/v1",
      keyConfigured: true,
    });

    const raw = await readFile(path, "utf8");
    expect(raw).not.toContain(connectionInput.apiKey);
    expect(raw).toContain(Buffer.from(`sealed:${connectionInput.apiKey}`).toString("base64"));

    await invoke("agent:session:rename", saved.selectedSessionId, "Renamed");
    const backup = await readFile(`${path}.bak`, "utf8");
    expect(backup).toBe(raw);
    await controller.stop();
  });

  it("rejects a non-empty API key when secure storage is unavailable", async () => {
    const isEncryptionAvailable = vi
      .fn<AgentCipher["isEncryptionAvailable"]>()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    const unavailableCipher: AgentCipher = {
      isEncryptionAvailable,
      encryptString: vi.fn((value) => Buffer.from(`sealed:${value}`, "utf8")),
      decryptString: vi.fn((value) => value.toString("utf8").replace(/^sealed:/, "")),
    };
    const { controller } = await fixture({ cipher: unavailableCipher });

    await expect(saveConnection()).rejects.toThrow("系统安全存储不可用");
    expect(controller.getView().connection).toBeNull();
    expect(controller.getView().error).toBe("系统安全存储不可用，无法保存 API Key。");
    expect(unavailableCipher.encryptString).not.toHaveBeenCalled();
    expect(isEncryptionAvailable).toHaveBeenCalledTimes(1);

    const retried = await saveConnection();
    expect(retried.connection?.keyConfigured).toBe(true);
    expect(retried.secureStorageAvailable).toBe(true);
    expect(isEncryptionAvailable).toHaveBeenCalledTimes(2);
    await controller.stop();
  });

  it("does not touch secure storage for startup, views, or an empty-key connection", async () => {
    const cipher: AgentCipher = {
      isEncryptionAvailable: vi.fn(() => true),
      encryptString: vi.fn((value) => Buffer.from(value, "utf8")),
      decryptString: vi.fn((value) => value.toString("utf8")),
    };
    const streamResponse = vi.fn(async (request: AgentProviderRequest) => {
      expect(request.apiKey).toBe("");
      request.onText("no key needed");
    });
    const { controller } = await fixture({ cipher, streamResponse });

    expect(controller.getView().secureStorageAvailable).toBeNull();
    expect(controller.getView().secureStorageAvailable).toBeNull();
    const saved = await invoke<AgentView>("agent:connection:save", {
      ...connectionInput,
      apiKey: "",
    });
    expect(saved.connection?.keyConfigured).toBe(false);
    expect(saved.secureStorageAvailable).toBeNull();
    await invoke("agent:send", selectedSessionId(saved), "without key");
    await waitForIdle(controller);
    await invoke("agent:session:rename", selectedSessionId(saved), "Local session");
    await invoke("agent:session:create");
    controller.getView();
    await controller.stop();

    expect(cipher.isEncryptionAvailable).not.toHaveBeenCalled();
    expect(cipher.encryptString).not.toHaveBeenCalled();
    expect(cipher.decryptString).not.toHaveBeenCalled();
  });

  it("does not probe a stored key on restart until an explicit send", async () => {
    const cipher: AgentCipher = {
      isEncryptionAvailable: vi.fn(() => true),
      encryptString: vi.fn((value) => Buffer.from(`sealed:${value}`, "utf8")),
      decryptString: vi.fn((value) => value.toString("utf8").replace(/^sealed:/, "")),
    };
    const first = await fixture({ cipher });
    const saved = await saveConnection();
    await first.controller.stop();
    vi.mocked(cipher.isEncryptionAvailable)
      .mockClear()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    vi.mocked(cipher.encryptString).mockClear();
    vi.mocked(cipher.decryptString).mockClear();

    const streamResponse = vi.fn(async (request: AgentProviderRequest) => {
      expect(request.apiKey).toBe(connectionInput.apiKey);
      request.onText("after restart");
    });
    const restarted = await createAgentController({
      path: first.path,
      trusted: vi.fn(),
      changed: vi.fn(),
      cipher,
      validateBaseUrl: (value) => value,
      streamResponse,
      streamPersistIntervalMs: 0,
    });

    expect(restarted.getView().secureStorageAvailable).toBeNull();
    expect(restarted.getView().connection?.keyConfigured).toBe(true);
    expect(cipher.isEncryptionAvailable).not.toHaveBeenCalled();
    expect(cipher.decryptString).not.toHaveBeenCalled();

    await expect(invoke("agent:send", selectedSessionId(saved), "first retry")).rejects.toThrow(
      "系统安全存储当前不可用",
    );
    expect(restarted.getView().secureStorageAvailable).toBe(false);
    expect(cipher.isEncryptionAvailable).toHaveBeenCalledTimes(1);
    expect(cipher.decryptString).not.toHaveBeenCalled();

    await invoke("agent:send", selectedSessionId(saved), "use stored key");
    await waitForIdle(restarted);
    expect(cipher.isEncryptionAvailable).toHaveBeenCalledTimes(2);
    expect(cipher.decryptString).toHaveBeenCalledTimes(1);
    expect(restarted.getView().secureStorageAvailable).toBe(true);
    await restarted.stop();
  });

  it("sends only successful dialogue from the selected current-connection session", async () => {
    const requests: AgentProviderRequest[] = [];
    let call = 0;
    const streamResponse = vi.fn(async (request: AgentProviderRequest) => {
      requests.push(request);
      call += 1;
      if (call === 1) {
        request.onText("answer-one");
        return;
      }
      if (call === 2) throw new Error("synthetic provider failure");
      request.onText("answer-three");
    });
    const { controller } = await fixture({ streamResponse });
    const saved = await saveConnection();
    const sessionId = selectedSessionId(saved);

    await invoke("agent:send", sessionId, "question-one");
    await waitForIdle(controller);
    await invoke("agent:send", sessionId, "question-two");
    await waitForIdle(controller);
    await invoke("agent:send", sessionId, "question-three");
    await waitForIdle(controller);

    expect(requests[2]?.messages).toEqual([
      { role: "user", content: "question-one" },
      { role: "assistant", content: "answer-one" },
      { role: "user", content: "question-three" },
    ]);
    const session = sessionFrom(controller.getView(), sessionId);
    expect(session.messages[1]).toMatchObject({
      content: "answer-one",
      status: "complete",
      usage: null,
    });
    expect(session.messages[3]).toMatchObject({ status: "failed" });
    expect(JSON.stringify(requests.map((request) => request.messages))).not.toContain(
      "synthetic provider failure",
    );
    await controller.stop();
  });

  it("cancels and drains an active request before replacing the connection", async () => {
    let firstRequest: AgentProviderRequest | undefined;
    let releaseFirst!: () => void;
    const firstSettled = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const requests: AgentProviderRequest[] = [];
    const streamResponse = vi.fn(async (request: AgentProviderRequest) => {
      requests.push(request);
      if (!firstRequest) {
        firstRequest = request;
        await firstSettled;
        if (request.signal.aborted) throw request.signal.reason;
      } else {
        request.onText("new-answer");
      }
    });
    const { controller } = await fixture({ streamResponse });
    const first = await saveConnection();
    const oldSessionId = selectedSessionId(first);

    await invoke("agent:send", oldSessionId, "old-question");
    const replacement = invoke<AgentView>("agent:connection:save", {
      ...connectionInput,
      name: "Replacement",
      apiKey: "replacement-key",
    });
    await vi.waitFor(() => expect(firstRequest?.signal.aborted).toBe(true));
    let replacementResolved = false;
    void replacement.then(() => {
      replacementResolved = true;
    });
    await Promise.resolve();
    expect(replacementResolved).toBe(false);

    releaseFirst();
    const replaced = await replacement;
    expect(replaced.connection?.id).not.toBe(first.connection?.id);
    expect(replaced.sessions.find((item) => item.id === oldSessionId)?.messages[1]?.status).toBe(
      "cancelled",
    );
    await expect(invoke("agent:send", oldSessionId, "must-not-send")).rejects.toThrow(
      "旧连接的会话为只读",
    );

    const newSessionId = selectedSessionId(replaced);
    await invoke("agent:send", newSessionId, "new-question");
    await waitForIdle(controller);
    expect(requests[1]?.messages).toEqual([{ role: "user", content: "new-question" }]);
    expect(requests[1]?.apiKey).toBe("replacement-key");
    await controller.stop();
  });

  it("cancels and drains before deleting the active session", async () => {
    let request!: AgentProviderRequest;
    let release!: () => void;
    const settled = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { controller } = await fixture({
      streamResponse: async (nextRequest) => {
        request = nextRequest;
        await settled;
        if (nextRequest.signal.aborted) throw nextRequest.signal.reason;
      },
    });
    const saved = await saveConnection();
    const sessionId = selectedSessionId(saved);
    await invoke("agent:send", sessionId, "delete-me");

    const deletion = invoke<AgentView>("agent:session:delete", sessionId);
    await vi.waitFor(() => expect(request.signal.aborted).toBe(true));
    let deletionResolved = false;
    void deletion.then(() => {
      deletionResolved = true;
    });
    await Promise.resolve();
    expect(deletionResolved).toBe(false);
    release();

    const deleted = await deletion;
    expect(deleted.sessions.some((session) => session.id === sessionId)).toBe(false);
    expect(controller.isBusy()).toBe(false);
    await controller.stop();
  });

  it("recovers persisted streaming messages as interrupted on restart", async () => {
    const first = await fixture();
    const saved = await saveConnection();
    await first.controller.stop();
    const stored = JSON.parse(await readFile(first.path, "utf8")) as {
      sessions: Array<{ messages: unknown[] }>;
    };
    const firstStoredSession = stored.sessions[0];
    if (!firstStoredSession) throw new Error("Expected a persisted session");
    firstStoredSession.messages = [
      {
        id: "user-recovery",
        role: "user",
        content: "unfinished",
        createdAt: "2026-09-22T00:00:00.000Z",
        status: "complete",
        usage: null,
        error: null,
      },
      {
        id: "assistant-recovery",
        role: "assistant",
        content: "partial",
        createdAt: "2026-09-22T00:00:00.000Z",
        status: "streaming",
        usage: null,
        error: null,
      },
    ];
    await writeFile(first.path, `${JSON.stringify(stored, null, 2)}\n`, "utf8");

    const trusted = vi.fn();
    const recovered = await createAgentController({
      path: first.path,
      trusted,
      changed: vi.fn(),
      cipher: availableCipher,
      validateBaseUrl: (value) => value,
      streamResponse: async () => {},
    });
    const assistant = sessionFrom(recovered.getView(), selectedSessionId(saved)).messages[1];
    expect(assistant).toMatchObject({
      content: "partial",
      status: "interrupted",
      usage: null,
      error: "应用在生成完成前退出。",
    });
    expect(await readFile(`${first.path}.bak`, "utf8")).toContain('"status": "streaming"');
    await recovered.stop();
  });

  it("settles the run after a coalesced streaming write fails", async () => {
    let failWrites = false;
    const persist = vi.fn(async (path: string, settings: unknown) => {
      if (failWrites) throw new Error(`synthetic EIO at ${path}`);
      await writeFile(path, `${JSON.stringify(settings)}\n`, "utf8");
    });
    const streamResponse = vi.fn(async (request: AgentProviderRequest) => {
      failWrites = true;
      request.onText("first ");
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      request.onText("second");
      await new Promise<void>((_resolve, reject) => {
        request.signal.addEventListener("abort", () => reject(request.signal.reason), {
          once: true,
        });
      });
    });
    const { path, controller } = await fixture({
      persist,
      streamResponse,
      streamPersistIntervalMs: 20,
    });
    const saved = await saveConnection();

    await invoke("agent:send", selectedSessionId(saved), "trigger failure");
    await waitForIdle(controller);

    const failed = sessionFrom(controller.getView(), selectedSessionId(saved)).messages[1];
    expect(failed).toMatchObject({
      content: "first second",
      status: "failed",
      error: "Agent 数据保存失败，请检查应用数据目录。",
    });
    expect(controller.getView().error).not.toContain(path);
    expect(persist).toHaveBeenCalledTimes(4);
    await expect(controller.cancel()).resolves.toMatchObject({ runningSessionId: null });
    await expect(controller.stop()).rejects.toThrow("Agent 数据保存失败，请检查应用数据目录。");
  });

  it("keeps a final persistence failure pending so shutdown reports it", async () => {
    let rejectCompletedAssistant = false;
    const persist = vi.fn(async (path: string, settings: unknown) => {
      const serialized = JSON.stringify(settings);
      if (rejectCompletedAssistant && hasCompletedAssistant(settings)) {
        throw new Error(`rename failed for ${path}`);
      }
      await writeFile(path, `${serialized}\n`, "utf8");
    });
    const { path, controller } = await fixture({
      persist,
      streamResponse: async (request) => {
        request.onText("complete response");
        rejectCompletedAssistant = true;
      },
    });
    const saved = await saveConnection();

    await invoke("agent:send", selectedSessionId(saved), "final write");
    await waitForIdle(controller);

    expect(sessionFrom(controller.getView(), selectedSessionId(saved)).messages[1]?.status).toBe(
      "failed",
    );
    expect(await readFile(path, "utf8")).toContain('"status":"streaming"');
    await expect(controller.stop()).rejects.toThrow("Agent 数据保存失败，请检查应用数据目录。");
  });

  it("checks sender trust and rejects unknown IPC argument shapes", async () => {
    const { controller, trusted } = await fixture();

    await expect(invoke("agent:get", "extra")).rejects.toThrow("无效的 Agent 请求参数");
    await expect(invoke("agent:session:rename", "id-only")).rejects.toThrow(
      "无效的 Agent 请求参数",
    );
    expect(trusted).toHaveBeenCalledTimes(2);
    expect(controller.getView().error).toBe("无效的 Agent 请求参数。");
    await controller.stop();
  });
});
