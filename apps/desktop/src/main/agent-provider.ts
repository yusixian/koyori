import { lookup } from "node:dns/promises";
import type { ClientRequest, IncomingMessage, RequestOptions } from "node:http";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import type { AgentProviderRequest, AgentUsage } from "../agent-types";

const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_EVENT_BYTES = 256 * 1024;
const TOTAL_TIMEOUT_MS = 2 * 60 * 1000;
const IDLE_TIMEOUT_MS = 30 * 1000;

const forbiddenIpv4 = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  forbiddenIpv4.addSubnet(network, prefix, "ipv4");
}

const forbiddenIpv6 = new BlockList();
for (const [network, prefix] of [
  ["::", 128],
  ["::ffff:0:0", 96],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  forbiddenIpv6.addSubnet(network, prefix, "ipv6");
}

const loopbackIpv4 = new BlockList();
loopbackIpv4.addSubnet("127.0.0.0", 8, "ipv4");

const metadataHostnames = new Set([
  "instance-data.ec2.internal",
  "metadata.azure.internal",
  "metadata.google.internal",
  "metadata.goog",
]);

class ProviderFailure extends Error {}

interface ValidatedAddress {
  address: string;
  family: 4 | 6;
}

function normalizedHostname(url: URL): string {
  return url.hostname
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
    .toLowerCase();
}

function isLoopback(address: string, family: 4 | 6): boolean {
  if (family === 4) return loopbackIpv4.check(address, "ipv4");
  return address === "::1";
}

function ipFamily(address: string): 0 | 4 | 6 {
  const family = isIP(address);
  return family === 4 || family === 6 ? family : 0;
}

function isPublicAddress(address: string, family: 4 | 6): boolean {
  if (family === 4) return !forbiddenIpv4.check(address, "ipv4") && !isLoopback(address, 4);
  return !forbiddenIpv6.check(address, "ipv6") && !isLoopback(address, 6);
}

function isExplicitHttpLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function parseBaseUrl(value: string): URL {
  const trimmed = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new ProviderFailure("服务地址格式无效。");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new ProviderFailure("服务地址只支持 HTTPS；本机回环地址可使用 HTTP。");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new ProviderFailure("服务地址不能包含账号信息、查询参数或片段。");
  }
  const hostname = normalizedHostname(parsed);
  if (!hostname || metadataHostnames.has(hostname)) {
    throw new ProviderFailure("该服务地址不可使用。");
  }
  if (parsed.protocol === "http:" && !isExplicitHttpLoopback(hostname)) {
    throw new ProviderFailure("HTTP 只允许明确的本机回环地址。");
  }
  const family = ipFamily(hostname);
  if (family !== 0 && !isLoopback(hostname, family) && !isPublicAddress(hostname, family)) {
    throw new ProviderFailure("该服务地址指向不允许访问的网络。");
  }
  return parsed;
}

export function validateAgentBaseUrl(value: string): string {
  const parsed = parseBaseUrl(value);
  const pathname = parsed.pathname.replace(/\/+$/, "");
  return `${parsed.origin}${pathname === "/" ? "" : pathname}`;
}

async function resolveEndpoint(endpoint: URL): Promise<ValidatedAddress[]> {
  const hostname = normalizedHostname(endpoint);
  const directFamily = ipFamily(hostname);
  const addresses = directFamily
    ? [{ address: hostname, family: directFamily }]
    : await lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0) throw new ProviderFailure("无法解析模型服务地址。");

  const allowLoopback =
    hostname === "localhost" || (directFamily !== 0 && isLoopback(hostname, directFamily));
  const validated: ValidatedAddress[] = [];
  for (const entry of addresses) {
    if (entry.family !== 4 && entry.family !== 6) {
      throw new ProviderFailure("模型服务地址解析结果无效。");
    }
    const allowed = allowLoopback
      ? isLoopback(entry.address, entry.family)
      : isPublicAddress(entry.address, entry.family);
    if (!allowed) throw new ProviderFailure("模型服务地址解析到了不允许访问的网络。");
    validated.push({ address: entry.address, family: entry.family });
  }
  return validated;
}

async function resolveEndpointForRequest(
  endpoint: URL,
  signal: AbortSignal,
): Promise<ValidatedAddress[]> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    };
    const abort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new ProviderFailure("请求已取消。"));
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new ProviderFailure("模型请求超时，请稍后重试。"));
    }, TOTAL_TIMEOUT_MS);
    signal.addEventListener("abort", abort, { once: true });
    void resolveEndpoint(endpoint).then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(
          error instanceof ProviderFailure
            ? error
            : new ProviderFailure("无法连接模型服务，请检查地址和网络。"),
        );
      },
    );
  });
}

function pinnedLookup(addresses: readonly ValidatedAddress[]): LookupFunction {
  const snapshot = addresses.map((entry) => ({ ...entry }));
  return (_hostname, options, callback) => {
    queueMicrotask(() => {
      if (options.all) {
        callback(
          null,
          snapshot.map((entry) => ({ ...entry })),
        );
        return;
      }
      const first = snapshot[0];
      if (!first) {
        callback(new Error("No validated addresses"), "", 0);
        return;
      }
      callback(null, first.address, first.family);
    });
  };
}

function safeStatusError(status: number): ProviderFailure {
  if (status === 401 || status === 403) return new ProviderFailure("模型服务拒绝了身份验证。");
  if (status === 429) return new ProviderFailure("模型服务当前请求过多，请稍后重试。");
  if (status >= 400 && status < 500) return new ProviderFailure("模型服务拒绝了本次请求。");
  if (status >= 500) return new ProviderFailure("模型服务暂时不可用，请稍后重试。");
  if (status >= 300 && status < 400) return new ProviderFailure("模型服务返回了不允许的重定向。");
  return new ProviderFailure("模型服务返回了异常状态。");
}

function usageFrom(value: unknown): AgentUsage | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const token = (candidate: unknown) =>
    typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate >= 0
      ? candidate
      : null;
  return {
    inputTokens: token(record.prompt_tokens),
    outputTokens: token(record.completion_tokens),
  };
}

function responseChoice(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  const choices = (value as Record<string, unknown>).choices;
  if (!Array.isArray(choices)) return null;
  const choice = choices.find(
    (candidate) =>
      candidate !== null &&
      typeof candidate === "object" &&
      ((candidate as Record<string, unknown>).index === 0 ||
        (candidate as Record<string, unknown>).index === undefined),
  );
  return choice && typeof choice === "object" ? (choice as Record<string, unknown>) : null;
}

function finishError(reason: string | null): ProviderFailure | null {
  if (reason === "stop") return null;
  if (reason === null) return new ProviderFailure("模型响应缺少完成状态，结果可能不完整。");
  if (reason === "length") return new ProviderFailure("模型输出因长度限制而截断。");
  if (reason === "content_filter") return new ProviderFailure("模型输出被内容策略中止。");
  if (reason === "tool_calls" || reason === "function_call") {
    return new ProviderFailure("模型请求了当前版本不支持的工具调用。");
  }
  return new ProviderFailure("模型返回了当前版本不支持的完成状态。");
}

function makeRequestOptions(
  endpoint: URL,
  addresses: readonly ValidatedAddress[],
  bodyBytes: number,
  apiKey: string,
): RequestOptions {
  const hostname = normalizedHostname(endpoint);
  const first = addresses[0];
  if (!first) throw new ProviderFailure("模型服务地址解析结果无效。");
  return {
    protocol: endpoint.protocol,
    hostname,
    port: endpoint.port || undefined,
    path: `${endpoint.pathname}${endpoint.search}`,
    method: "POST",
    agent: false,
    lookup: pinnedLookup(addresses),
    ...(addresses.length > 1
      ? { autoSelectFamily: true, autoSelectFamilyAttemptTimeout: 100 }
      : { family: first.family }),
    headers: {
      Accept: "text/event-stream",
      "Content-Type": "application/json",
      "Content-Length": bodyBytes,
      Host: endpoint.host,
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    ...(endpoint.protocol === "https:" && ipFamily(hostname) === 0 ? { servername: hostname } : {}),
  };
}

export async function streamAgentResponse(request: AgentProviderRequest): Promise<void> {
  const startedAt = Date.now();
  if (request.signal.aborted) throw new ProviderFailure("请求已取消。");
  if (/[\r\n]/.test(request.apiKey)) {
    throw new ProviderFailure("API 密钥格式无效。");
  }
  const baseUrl = validateAgentBaseUrl(request.baseUrl);
  const endpoint = new URL(`${baseUrl}/chat/completions`);
  const body = JSON.stringify({
    model: request.model,
    messages: request.messages,
    stream: true,
    stream_options: { include_usage: true },
  });
  const bodyBytes = Buffer.byteLength(body);
  if (bodyBytes > MAX_REQUEST_BYTES) throw new ProviderFailure("发送给模型的消息过大。");

  const resolved = await resolveEndpointForRequest(endpoint, request.signal);
  if (request.signal.aborted) throw new ProviderFailure("请求已取消。");
  const remainingTotalTime = Math.max(1, TOTAL_TIMEOUT_MS - (Date.now() - startedAt));

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let response: IncomingMessage | undefined;
    let totalTimer: NodeJS.Timeout | undefined;
    let idleTimer: NodeJS.Timeout | undefined;
    let responseBytes = 0;
    let lineBuffer = "";
    let eventData: string[] = [];
    let eventBytes = 0;
    let finishReason: string | null = null;
    let latestUsage: AgentUsage | null = null;
    const decoder = new TextDecoder("utf-8", { fatal: true });

    const options = makeRequestOptions(endpoint, resolved, bodyBytes, request.apiKey);
    const send = endpoint.protocol === "https:" ? httpsRequest : httpRequest;

    let outgoing: ClientRequest | undefined;
    const cleanup = () => {
      if (totalTimer) clearTimeout(totalTimer);
      if (idleTimer) clearTimeout(idleTimer);
      request.signal.removeEventListener("abort", abort);
    };
    const fail = (error: ProviderFailure) => {
      if (settled) return;
      settled = true;
      cleanup();
      response?.destroy();
      outgoing?.destroy();
      reject(error);
    };
    const succeed = () => {
      if (settled) return;
      const error = finishError(finishReason);
      try {
        request.onUsage(latestUsage ?? { inputTokens: null, outputTokens: null });
      } catch {
        fail(new ProviderFailure("处理模型响应失败。"));
        return;
      }
      if (error) {
        fail(error);
        return;
      }
      settled = true;
      cleanup();
      response?.destroy();
      outgoing?.destroy();
      resolve();
    };
    const abort = () => fail(new ProviderFailure("请求已取消。"));
    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(
        () => fail(new ProviderFailure("模型响应超时，请稍后重试。")),
        IDLE_TIMEOUT_MS,
      );
    };

    const handleEvent = () => {
      const data = eventData.join("\n");
      eventData = [];
      eventBytes = 0;
      if (!data) return;
      if (data.trim() === "[DONE]") {
        succeed();
        return;
      }
      let payload: unknown;
      try {
        payload = JSON.parse(data);
      } catch {
        fail(new ProviderFailure("模型服务返回了无法解析的流式数据。"));
        return;
      }
      if (!payload || typeof payload !== "object") {
        fail(new ProviderFailure("模型服务返回了无法解析的流式数据。"));
        return;
      }
      const record = payload as Record<string, unknown>;
      if (record.error !== undefined) {
        fail(new ProviderFailure("模型服务返回了流式错误。"));
        return;
      }
      const usage = usageFrom(record.usage);
      if (usage) latestUsage = usage;
      const choice = responseChoice(record);
      if (!choice) return;
      if (typeof choice.finish_reason === "string") finishReason = choice.finish_reason;
      const delta = choice.delta;
      if (!delta || typeof delta !== "object") return;
      const content = (delta as Record<string, unknown>).content;
      if (typeof content === "string" && content) {
        try {
          request.onText(content);
        } catch {
          fail(new ProviderFailure("处理模型响应失败。"));
        }
      }
    };

    const handleText = (text: string) => {
      lineBuffer += text;
      while (!settled) {
        const newline = lineBuffer.indexOf("\n");
        if (newline < 0) {
          if (Buffer.byteLength(lineBuffer) + eventBytes > MAX_EVENT_BYTES) {
            fail(new ProviderFailure("模型服务返回的单个数据帧过大。"));
          }
          return;
        }
        let line = lineBuffer.slice(0, newline);
        lineBuffer = lineBuffer.slice(newline + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        eventBytes += Buffer.byteLength(line) + 1;
        if (eventBytes > MAX_EVENT_BYTES) {
          fail(new ProviderFailure("模型服务返回的单个数据帧过大。"));
          return;
        }
        if (line === "") {
          handleEvent();
        } else if (line === "data" || line.startsWith("data:")) {
          const value = line === "data" ? "" : line.slice(5).replace(/^ /, "");
          eventData.push(value);
        }
      }
    };

    try {
      outgoing = send(options, (incoming) => {
        response = incoming;
        if (settled) {
          incoming.destroy();
          return;
        }
        const status = incoming.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          fail(safeStatusError(status));
          return;
        }
        const contentType = incoming.headers["content-type"];
        if (
          typeof contentType !== "string" ||
          contentType.split(";", 1)[0]?.trim().toLowerCase() !== "text/event-stream"
        ) {
          fail(new ProviderFailure("模型服务未返回受支持的流式响应。"));
          return;
        }
        const declaredLength = Number(incoming.headers["content-length"]);
        if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
          fail(new ProviderFailure("模型服务返回的数据过大。"));
          return;
        }
        resetIdleTimer();
        incoming.on("data", (chunk: Buffer) => {
          if (settled) return;
          responseBytes += chunk.byteLength;
          if (responseBytes > MAX_RESPONSE_BYTES) {
            fail(new ProviderFailure("模型服务返回的数据过大。"));
            return;
          }
          resetIdleTimer();
          try {
            handleText(decoder.decode(chunk, { stream: true }));
          } catch {
            fail(new ProviderFailure("模型服务返回了无效的文本编码。"));
          }
        });
        incoming.on("end", () => {
          if (settled) return;
          try {
            handleText(decoder.decode());
          } catch {
            fail(new ProviderFailure("模型服务返回了无效的文本编码。"));
            return;
          }
          fail(new ProviderFailure("模型响应意外中断，结果可能不完整。"));
        });
        incoming.on("aborted", () =>
          fail(new ProviderFailure("模型响应意外中断，结果可能不完整。")),
        );
        incoming.on("error", () => fail(new ProviderFailure("读取模型响应失败，请稍后重试。")));
      });
    } catch {
      fail(new ProviderFailure("无法连接模型服务，请检查地址和网络。"));
      return;
    }
    outgoing.on("error", () => {
      if (!settled) fail(new ProviderFailure("无法连接模型服务，请检查地址和网络。"));
    });
    request.signal.addEventListener("abort", abort, { once: true });
    totalTimer = setTimeout(
      () => fail(new ProviderFailure("模型请求超时，请稍后重试。")),
      remainingTotalTime,
    );
    resetIdleTimer();
    outgoing.end(body);
  });
}
