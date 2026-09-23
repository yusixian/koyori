import { ipcMain } from "electron";
import type { RegisteredService } from "../bridge";
import type { ServiceSettingsV1 } from "./services-store";
import {
  createRegisteredService,
  normalizeServiceUrl,
  readServiceSettings,
  writeServiceSettings,
} from "./services-store";

interface Dependencies {
  path: string;
  trusted(event: Electron.IpcMainInvokeEvent): void;
  openExternal(url: string): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseInput(value: unknown): { id?: string; name: string; url: string } {
  if (!isRecord(value)) throw new Error("服务输入格式无效。");
  if (Object.keys(value).some((key) => !["id", "name", "url"].includes(key))) {
    throw new Error("服务输入包含不支持的字段。");
  }
  if (
    (value.id !== undefined &&
      (typeof value.id !== "string" || value.id.trim().length === 0 || value.id.length > 100)) ||
    typeof value.name !== "string" ||
    typeof value.url !== "string"
  ) {
    throw new Error("请提供有效的服务名称和地址。");
  }
  return {
    ...(typeof value.id === "string" ? { id: value.id } : {}),
    name: value.name,
    url: value.url,
  };
}

function idInput(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 100) {
    throw new Error("服务标识无效，请刷新服务列表后重试。");
  }
  return value;
}

function errorCode(error: unknown): string | undefined {
  if (!isRecord(error) || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

export async function createServicesController(deps: Dependencies) {
  let state: ServiceSettingsV1 | undefined;
  let mutationBusy = false;
  let loadError = "服务设置尚未读取。";
  try {
    state = await readServiceSettings(deps.path);
  } catch (error) {
    loadError = error instanceof Error ? error.message : "服务设置读取失败；原文件已保留。";
  }

  function current(): ServiceSettingsV1 {
    if (!state) throw new Error(loadError);
    return state;
  }

  async function persist(next: ServiceSettingsV1): Promise<RegisteredService[]> {
    if (mutationBusy) throw new Error("另一项服务设置正在保存，请稍后重试。");
    mutationBusy = true;
    try {
      await writeServiceSettings(deps.path, next);
      state = next;
      return [...next.services];
    } finally {
      mutationBusy = false;
    }
  }

  ipcMain.handle("services:get", (event) => {
    deps.trusted(event);
    return [...current().services];
  });

  ipcMain.handle("services:save", async (event, raw: unknown) => {
    deps.trusted(event);
    const input = parseInput(raw);
    const before = current();
    const existing = input.id
      ? before.services.find((service) => service.id === input.id)
      : undefined;
    if (input.id && !existing) throw new Error("服务已不存在，请刷新后重试。");
    if (!existing && before.services.length >= 100) {
      throw new Error("最多登记 100 项服务，请先移除不再使用的项目。");
    }
    const saved = createRegisteredService({
      ...(input.id ? { id: input.id } : {}),
      name: input.name,
      url: input.url,
      ...(existing ? { createdAt: existing.createdAt } : {}),
      updatedAt: new Date().toISOString(),
    });
    const services = existing
      ? before.services.map((service) => (service.id === saved.id ? saved : service))
      : [...before.services, saved];
    return persist({ version: 1, services });
  });

  ipcMain.handle("services:remove", async (event, rawId: unknown) => {
    deps.trusted(event);
    const id = idInput(rawId);
    const before = current();
    if (!before.services.some((service) => service.id === id)) {
      throw new Error("服务已不存在，请刷新后重试。");
    }
    return persist({
      version: 1,
      services: before.services.filter((service) => service.id !== id),
    });
  });

  ipcMain.handle("services:open", async (event, rawId: unknown) => {
    deps.trusted(event);
    const id = idInput(rawId);
    const service = current().services.find((item) => item.id === id);
    if (!service) throw new Error("服务已不存在，请刷新后重试。");
    const url = normalizeServiceUrl(service.url);
    try {
      await deps.openExternal(url);
    } catch (error) {
      throw new Error(
        `无法调用系统默认浏览器（${errorCode(error) ?? "OPEN"}）。请检查默认浏览器和系统 URL 处理设置。`,
      );
    }
  });
}
