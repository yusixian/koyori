import { once } from "node:events";
import { createServer, type RequestListener, type Server } from "node:http";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentProviderRequest, AgentUsage } from "../agent-types";

const dns = vi.hoisted(() => ({
  lookup: vi.fn(),
}));
vi.mock("node:dns/promises", () => ({ lookup: dns.lookup }));

import { streamAgentResponse, validateAgentBaseUrl } from "./agent-provider";

const servers: Server[] = [];

beforeEach(() => {
  dns.lookup.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
});

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    ),
  );
  vi.useRealTimers();
  vi.clearAllMocks();
});

async function listen(handler: RequestListener): Promise<number> {
  const server = createServer(handler);
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test server address");
  return address.port;
}

function request(
  port: number,
  overrides: Partial<AgentProviderRequest> = {},
): { input: AgentProviderRequest; text: string[]; usage: AgentUsage[] } {
  const text: string[] = [];
  const usage: AgentUsage[] = [];
  return {
    text,
    usage,
    input: {
      baseUrl: `http://localhost:${port}/v1`,
      model: "fixture-model",
      apiKey: "fixture-key",
      messages: [{ role: "user", content: "你好" }],
      signal: new AbortController().signal,
      onText: (value) => text.push(value),
      onUsage: (value) => usage.push(value),
      ...overrides,
    },
  };
}

it("normalizes supported base URLs and rejects unsafe structures", () => {
  expect(validateAgentBaseUrl(" https://service.example/v1/ ")).toBe("https://service.example/v1");
  expect(validateAgentBaseUrl("http://127.0.0.1:8080/v1")).toBe("http://127.0.0.1:8080/v1");
  expect(validateAgentBaseUrl("http://[::1]:8080/v1/")).toBe("http://[::1]:8080/v1");
  expect(() => validateAgentBaseUrl("http://service.example/v1")).toThrow("HTTP 只允许");
  expect(() => validateAgentBaseUrl("https://user:pass@service.example/v1")).toThrow(
    "不能包含账号信息",
  );
  expect(() => validateAgentBaseUrl("https://service.example/v1?key=secret")).toThrow(
    "不能包含账号信息",
  );
  expect(() => validateAgentBaseUrl("https://169.254.169.254/v1")).toThrow("不允许访问");
  expect(() => validateAgentBaseUrl("https://metadata.google.internal/v1")).toThrow("不可使用");
});

it("posts to chat completions and parses split UTF-8, CRLF, multiline data, text and usage", async () => {
  let receivedPath = "";
  let receivedAuthorization = "";
  let receivedBody = "";
  const port = await listen((incoming, response) => {
    receivedPath = incoming.url ?? "";
    receivedAuthorization = incoming.headers.authorization ?? "";
    incoming.setEncoding("utf8");
    incoming.on("data", (chunk) => {
      receivedBody += chunk;
    });
    incoming.on("end", () => {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      const first = Buffer.from(
        'data: {"choices":[{"index":0,"delta":{"content":"你"}}],\r\ndata: "usage":{"prompt_tokens":3,"completion_tokens":1}}\r\n\r\n',
      );
      const split = first.indexOf(Buffer.from("你")) + 1;
      response.write(first.subarray(0, split));
      response.write(first.subarray(split));
      response.write(
        'data: {"choices":[{"index":0,"delta":{"reasoning_content":"hidden","tool_calls":[{"id":"hidden"}],"content":"好"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\n',
      );
      response.end("data: [DONE]\n\n");
    });
  });
  const fixture = request(port);

  await streamAgentResponse(fixture.input);

  expect(receivedPath).toBe("/v1/chat/completions");
  expect(receivedAuthorization).toBe("Bearer fixture-key");
  expect(JSON.parse(receivedBody)).toMatchObject({
    model: "fixture-model",
    stream: true,
    stream_options: { include_usage: true },
    messages: [{ role: "user", content: "你好" }],
  });
  expect(fixture.text.join("")).toBe("你好");
  expect(fixture.text.join("")).not.toContain("hidden");
  expect(fixture.usage).toEqual([{ inputTokens: 3, outputTokens: 2 }]);
});

it("falls back from IPv6 to an IPv4-only localhost without replaying the POST", async () => {
  dns.lookup.mockResolvedValue([
    { address: "::1", family: 6 },
    { address: "127.0.0.1", family: 4 },
  ]);
  let requests = 0;
  const authorizations: Array<string | undefined> = [];
  const bodies: string[] = [];
  const port = await listen((incoming, response) => {
    requests += 1;
    authorizations.push(incoming.headers.authorization);
    incoming.setEncoding("utf8");
    incoming.on("data", (chunk) => bodies.push(chunk));
    incoming.on("end", () => {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end(
        'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      );
    });
  });
  const fixture = request(port, { apiKey: "only-this-request" });

  await streamAgentResponse(fixture.input);

  expect(dns.lookup).toHaveBeenCalledOnce();
  expect(requests).toBe(1);
  expect(authorizations).toEqual(["Bearer only-this-request"]);
  expect(bodies.join("")).toContain('"model":"fixture-model"');
  expect(fixture.text).toEqual(["ok"]);
});

it("reports unknown usage once rather than inventing or accumulating it", async () => {
  let authorization: string | undefined;
  const port = await listen((incoming, response) => {
    authorization = incoming.headers.authorization;
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(
      'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    );
  });
  const fixture = request(port, { apiKey: "" });

  await streamAgentResponse(fixture.input);

  expect(authorization).toBeUndefined();
  expect(fixture.usage).toEqual([{ inputTokens: null, outputTokens: null }]);
});

it("validates every DNS result before opening a connection", async () => {
  dns.lookup.mockResolvedValue([
    { address: "93.184.216.34", family: 4 },
    { address: "10.0.0.8", family: 4 },
  ]);
  const fixture = request(443, { baseUrl: "https://service.example/v1" });

  await expect(streamAgentResponse(fixture.input)).rejects.toThrow("解析到了不允许访问的网络");
  expect(fixture.text).toEqual([]);
});

it("includes DNS resolution in the whole-request timeout", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  dns.lookup.mockReturnValue(new Promise(() => {}));
  const fixture = request(443, { baseUrl: "https://service.example/v1" });
  const running = streamAgentResponse(fixture.input);
  const timeoutFailure = expect(running).rejects.toThrow("模型请求超时");

  await vi.advanceTimersByTimeAsync(2 * 60 * 1000);

  await timeoutFailure;
});

it("does not follow redirects or forward credentials", async () => {
  let redirectedRequests = 0;
  const redirectedPort = await listen((_incoming, response) => {
    redirectedRequests += 1;
    response.end();
  });
  const redirectPort = await listen((_incoming, response) => {
    response.writeHead(307, { Location: `http://localhost:${redirectedPort}/capture` });
    response.end("fixture-key secret response");
  });
  const fixture = request(redirectPort);

  const failure = streamAgentResponse(fixture.input);
  await expect(failure).rejects.toThrow("不允许的重定向");
  await expect(failure).rejects.not.toThrow("fixture-key");
  expect(redirectedRequests).toBe(0);
});

it("rejects malformed frames, stream errors, missing finish reasons, and truncated streams", async () => {
  const variants = [
    ["data: not-json\n\n", "无法解析"],
    ['data: {"error":{"message":"fixture-key private detail"}}\n\n', "流式错误"],
    ['data: {"choices":[{"delta":{"content":"partial"}}]}\n\ndata: [DONE]\n\n', "缺少完成状态"],
    [
      'data: {"choices":[{"delta":{"content":"partial"},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n',
      "长度限制",
    ],
    [
      'data: {"choices":[{"delta":{"tool_calls":[{"id":"hidden"}]},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n',
      "不支持的工具调用",
    ],
    ['data: {"choices":[{"delta":{"content":"partial"},"finish_reason":"stop"}]}\n\n', "意外中断"],
  ] as const;

  for (const [body, expected] of variants) {
    const port = await listen((_incoming, response) => {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end(body);
    });
    const fixture = request(port);
    const failure = streamAgentResponse(fixture.input);
    await expect(failure).rejects.toThrow(expected);
    await expect(failure).rejects.not.toThrow("fixture-key private detail");
    if (body.includes("[DONE]")) {
      expect(fixture.usage).toEqual([{ inputTokens: null, outputTokens: null }]);
    }
  }
});

it("bounds request messages and individual SSE frames", async () => {
  const oversizedRequest = request(1, {
    messages: [{ role: "user", content: "x".repeat(1024 * 1024) }],
  });
  await expect(streamAgentResponse(oversizedRequest.input)).rejects.toThrow("消息过大");
  expect(dns.lookup).not.toHaveBeenCalled();

  const port = await listen((_incoming, response) => {
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(`data: ${"x".repeat(256 * 1024)}\n\n`);
  });
  const oversizedFrame = request(port);
  await expect(streamAgentResponse(oversizedFrame.input)).rejects.toThrow("单个数据帧过大");
});

it("times out an idle stream and closes its socket", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let peerClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    peerClosed = resolve;
  });
  let started!: () => void;
  const connected = new Promise<void>((resolve) => {
    started = resolve;
  });
  const port = await listen((incoming, response) => {
    incoming.once("close", peerClosed);
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write(": keep-alive\n\n");
    started();
  });
  const fixture = request(port);
  const running = streamAgentResponse(fixture.input);
  const timeoutFailure = expect(running).rejects.toThrow("模型响应超时");
  await connected;

  await vi.advanceTimersByTimeAsync(30_000);

  await timeoutFailure;
  await closed;
});

it("destroys the active request when cancelled", async () => {
  let peerClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    peerClosed = resolve;
  });
  let started!: () => void;
  const connected = new Promise<void>((resolve) => {
    started = resolve;
  });
  const port = await listen((incoming, response) => {
    incoming.once("close", peerClosed);
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write(": keep-alive\n\n");
    started();
  });
  const controller = new AbortController();
  const fixture = request(port, { signal: controller.signal });
  const running = streamAgentResponse(fixture.input);
  await connected;

  controller.abort();

  await expect(running).rejects.toThrow("请求已取消");
  await closed;
});
