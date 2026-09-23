import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

test("agent conversation streams, cancels, persists and isolates connections", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "koyori-agent-acceptance-"));
  const userData = join(temporary, "app-data");
  const requests: string[] = [];
  let cancelledRequests = 0;
  const server = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    let body = "";
    for await (const chunk of request) body += String(chunk);
    requests.push(body);
    if (body.includes("模拟错误")) {
      response.writeHead(503).end("PRIVATE_PROVIDER_ERROR_DO_NOT_DISPLAY");
      return;
    }
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const text = (content: string) =>
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
    text("你好，");
    if (body.includes("慢速回复")) {
      const timer = setInterval(() => text("正在回复。"), 100);
      response.on("close", () => {
        clearInterval(timer);
        cancelledRequests += 1;
      });
      return;
    }
    text("这是合成模型回复。<script>unsafe()</script>");
    response.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing synthetic server port");
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  const require = createRequire(resolve("apps/desktop/package.json"));
  const executablePath: unknown = process.env.KOYORI_EXECUTABLE ?? require("electron");
  if (typeof executablePath !== "string") throw new Error("Missing Electron executable");
  const args = [
    ...(process.env.KOYORI_EXECUTABLE ? [] : [resolve("apps/desktop/out/main/index.js")]),
    `--user-data-dir=${userData}`,
    "--disable-auto-update-check",
    "--koyori-acceptance-hidden",
  ];
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== "ELECTRON_RUN_AS_NODE") env[key] = value;
  }
  env.HOME = join(temporary, "home");
  env.CODEX_HOME = join(env.HOME, ".codex");
  env.CLAUDE_CONFIG_DIR = join(env.HOME, ".claude");
  await mkdir(env.HOME, { recursive: true });
  const launch = () => electron.launch({ args, executablePath, env });
  let app = await launch();
  try {
    let page = await app.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.getByRole("button", { name: "Agent", exact: true }).click();
    expect(
      await page.evaluate(async () => (await window.koyori.getAgent()).secureStorageAvailable),
    ).toBeNull();
    await page.locator(".agent-heading").getByRole("button", { name: "连接设置" }).click();
    await page.getByLabel("连接名称", { exact: true }).fill("合成连接 A");
    await page.getByLabel("服务地址", { exact: true }).fill(baseUrl);
    await page.getByLabel("模型", { exact: true }).fill("synthetic-model");
    await page.getByRole("button", { name: "保存连接", exact: true }).click();
    expect(requests).toHaveLength(0);
    await page.getByLabel("消息", { exact: true }).fill("第一次测试消息");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(
      page.getByText("你好，这是合成模型回复。<script>unsafe()</script>", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText("用量未知", { exact: true })).toBeVisible();
    expect(requests).toHaveLength(1);
    expect(requests[0]).not.toContain("skills");
    await page.screenshot({ path: "artifacts/desktop-agent-1240.png" });
    await page.setViewportSize({ width: 960, height: 640 });
    await page.getByLabel("消息", { exact: true }).fill("慢速回复");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(page.getByText(/正在回复。/).last()).toBeVisible();
    await page
      .getByRole("region", { name: "当前会话" })
      .getByRole("button", { name: "停止生成", exact: true })
      .click();
    await expect.poll(() => cancelledRequests).toBe(1);
    await expect(page.getByText("已停止", { exact: true })).toBeVisible();
    await page.screenshot({ path: "artifacts/desktop-agent-960.png" });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.getByLabel("消息", { exact: true }).fill("未发送草稿");
    await page.getByRole("button", { name: "Skills", exact: true }).click();
    await page.getByRole("button", { name: "Agent", exact: true }).click();
    expect(errors).toEqual([]);
    expect(
      await page.evaluate(async () => (await window.koyori.getAgent()).secureStorageAvailable),
    ).toBeNull();
    try {
      await expect(page.getByLabel("消息", { exact: true })).toHaveValue("未发送草稿");
    } catch (error) {
      await test.info().attach("agent-navigation", {
        body: await page.locator("body").innerText(),
        contentType: "text/plain",
      });
      await page.screenshot({ path: "artifacts/desktop-agent-navigation.png" });
      throw error;
    }
    await app.close();
    app = await launch();
    page = await app.firstWindow();
    page.on("pageerror", (error) => errors.push(error.message));
    await page.getByRole("button", { name: "Agent", exact: true }).click();
    await expect(
      page.getByText("你好，这是合成模型回复。<script>unsafe()</script>", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "连接设置", exact: true }).click();
    await page.getByLabel("连接名称", { exact: true }).fill("合成连接 B");
    await page.getByRole("button", { name: "保存连接", exact: true }).click();
    await page.getByLabel("消息", { exact: true }).fill("新的独立消息");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(page.getByText("用量未知", { exact: true })).toBeVisible();
    expect(requests.at(-1)).toContain("新的独立消息");
    expect(requests.at(-1)).not.toContain("第一次测试消息");
    expect(requests.at(-1)).not.toContain("慢速回复");
    await page.getByLabel("消息", { exact: true }).fill("模拟错误");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(page.getByText("发送失败", { exact: true })).toBeVisible();
    expect(await page.locator("body").innerText()).not.toContain(
      "PRIVATE_PROVIDER_ERROR_DO_NOT_DISPLAY",
    );
    expect(await readFile(join(userData, "agent.json"), "utf8")).not.toContain(
      "PRIVATE_PROVIDER_ERROR_DO_NOT_DISPLAY",
    );
    await page.getByLabel("消息", { exact: true }).fill("删除其他会话后保留");
    const oldSession = page.locator(".agent-session-row").filter({ hasText: "历史连接 · 只读" });
    await oldSession.getByRole("button", { name: "删除会话", exact: true }).click();
    await page.getByRole("button", { name: "确认删除", exact: true }).click();
    await expect(page.locator(".agent-session-row")).toHaveCount(1);
    await expect(page.getByLabel("消息", { exact: true })).toHaveValue("删除其他会话后保留");
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(temporary, { recursive: true, force: true });
  }
});
