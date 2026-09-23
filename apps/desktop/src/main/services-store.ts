import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { isIP } from "node:net";
import { dirname } from "node:path";
import type { RegisteredService } from "../bridge";

export interface ServiceSettingsV1 {
  version: 1;
  services: RegisteredService[];
}

const MAX_SERVICES = 100;
const MAX_NAME_LENGTH = 80;
const MAX_URL_LENGTH = 2048;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string | undefined {
  if (!isRecord(error) || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0);
    return code !== undefined && (code < 0x20 || (code >= 0x7f && code <= 0x9f));
  });
}

function isLoopback(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host === "localhost.") return true;
  if (isIP(host) === 4) return Number(host.split(".")[0]) === 127;
  return isIP(host) === 6 && host === "::1";
}

/** Return a canonical web address, rejecting credentials and ambiguous URL parts. */
export function normalizeServiceUrl(value: unknown): string {
  if (typeof value !== "string") throw new Error("请输入 HTTPS 或本机回环 HTTP 地址。");
  const raw = value.trim();
  if (
    raw.length === 0 ||
    raw.length > MAX_URL_LENGTH ||
    !/^https?:\/\//i.test(raw) ||
    hasControlCharacters(raw)
  ) {
    throw new Error("地址必须以 https:// 或 http:// 开头，并且不超过 2048 个字符。");
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("服务地址格式无效。");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("只允许 HTTPS 或本机回环 HTTP 地址。");
  }
  if (url.username || url.password) throw new Error("服务地址不能包含账号或密码。");
  if (url.href.includes("?") || url.href.includes("#")) {
    throw new Error("服务地址不能包含查询参数或片段。");
  }
  if (url.protocol === "http:" && !isLoopback(url.hostname)) {
    throw new Error("HTTP 仅允许 localhost、127.0.0.0/8 或 ::1 回环地址。");
  }
  return url.toString();
}

function normalizedService(value: unknown): RegisteredService {
  if (
    !isRecord(value) ||
    Object.keys(value).some(
      (key) => !["id", "name", "url", "createdAt", "updatedAt"].includes(key),
    ) ||
    typeof value.id !== "string" ||
    value.id.trim().length === 0 ||
    value.id.length > 100 ||
    typeof value.name !== "string" ||
    value.name.trim().length === 0 ||
    value.name.trim().length > MAX_NAME_LENGTH ||
    hasControlCharacters(value.name) ||
    !validTimestamp(value.createdAt) ||
    !validTimestamp(value.updatedAt)
  ) {
    throw new Error("服务配置格式无效；原文件已保留。");
  }
  let url: string;
  try {
    url = normalizeServiceUrl(value.url);
  } catch {
    throw new Error("服务配置中包含无效或不安全的地址；原文件已保留。");
  }
  return {
    id: value.id,
    name: value.name.trim(),
    url,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

export function parseServiceSettings(value: unknown): ServiceSettingsV1 {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => !["version", "services"].includes(key)) ||
    value.version !== 1 ||
    !Array.isArray(value.services)
  ) {
    throw new Error("服务配置格式不受支持；原文件已保留。");
  }
  if (value.services.length > MAX_SERVICES) {
    throw new Error(`服务配置超过 ${MAX_SERVICES} 项；原文件已保留。`);
  }
  const services = value.services.map(normalizedService);
  if (new Set(services.map((service) => service.id)).size !== services.length) {
    throw new Error("服务配置包含重复标识；原文件已保留。");
  }
  return { version: 1, services };
}

export function emptyServiceSettings(): ServiceSettingsV1 {
  return { version: 1, services: [] };
}

/** Invalid or unreadable settings are reported without replacing the user's file. */
export async function readServiceSettings(path: string): Promise<ServiceSettingsV1> {
  try {
    const file = await stat(path);
    if (file.size > 256 * 1024) throw new Error("SIZE");
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return parseServiceSettings(parsed);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return emptyServiceSettings();
    if (error instanceof Error && error.message.startsWith("服务配置")) throw error;
    const code = error instanceof Error && error.message === "SIZE" ? "SIZE" : errorCode(error);
    const diagnostic = code ?? (error instanceof SyntaxError ? "JSON" : "READ");
    throw new Error(
      `服务设置无法读取（${diagnostic}），原文件已保留。可检查数据目录权限或恢复 services.json.bak。`,
    );
  }
}

/** Back up the previous settings, then atomically replace the file. */
export async function writeServiceSettings(path: string, next: ServiceSettingsV1): Promise<void> {
  const parsed = parseServiceSettings(next);
  const temporary = `${path}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    await mkdir(dirname(path), { recursive: true });
    handle = await open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    await handle.writeFile(`${JSON.stringify(parsed, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await stat(path);
      await copyFile(path, `${path}.bak`);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
    await rename(temporary, path);
  } catch (error) {
    const code = errorCode(error) ?? "WRITE";
    throw new Error(`服务设置保存失败（${code}），原有数据已保留。请检查应用数据目录权限。`);
  } finally {
    if (handle) await handle.close().catch(() => {});
    await unlink(temporary).catch((error: unknown) => {
      if (errorCode(error) !== "ENOENT") throw error;
    });
  }
}

export function createRegisteredService(input: {
  id?: string;
  name: string;
  url: string;
  createdAt?: string;
  updatedAt?: string;
}): RegisteredService {
  const name = input.name.trim();
  if (!name || name.length > MAX_NAME_LENGTH || hasControlCharacters(name)) {
    throw new Error(`名称不能为空、不能含控制字符且不得超过 ${MAX_NAME_LENGTH} 个字符。`);
  }
  const now = new Date().toISOString();
  return {
    id: input.id ?? randomUUID(),
    name,
    url: normalizeServiceUrl(input.url),
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? now,
  };
}
