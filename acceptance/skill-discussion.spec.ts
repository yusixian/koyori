import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

test("skill discussion previews selected evidence and sends only the edited draft", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "koyori-discussion-acceptance-"));
  const home = join(temporary, "home");
  const source = join(home, ".claude", "skills", "discussion-writer");
  const other = join(home, ".claude", "skills", "other-private-skill");
  const history = join(home, ".claude", "projects", "private-project-name");
  const userData = join(temporary, "data");
  await mkdir(source, { recursive: true });
  await mkdir(other, { recursive: true });
  await mkdir(history, { recursive: true });
  const content =
    "---\nname: discussion-writer\ndescription: PRIVATE_DESCRIPTION\n---\nPRIVATE_SKILL_BODY\n";
  await writeFile(join(source, "SKILL.md"), content);
  await writeFile(
    join(other, "SKILL.md"),
    "---\nname: other-private-skill\n---\nOTHER_PRIVATE_BODY\n",
  );
  await writeFile(
    join(history, "private-session.jsonl"),
    `${JSON.stringify({
      type: "assistant",
      timestamp: new Date().toISOString(),
      sessionId: "private-session-id",
      uuid: "private-message-id",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "private-invocation-id",
            name: "Skill",
            input: { skill: "discussion-writer", args: "PRIVATE_TOOL_ARGUMENTS" },
          },
        ],
      },
    })}\n`,
  );
  const requests: string[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += String(chunk);
    requests.push(body);
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write(
      `data: ${JSON.stringify({ choices: [{ delta: { content: "合成建议：证据有限，先保留并复查。" } }] })}\n\n`,
    );
    response.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture server port");
  const require = createRequire(resolve("apps/desktop/package.json"));
  const executablePath: unknown = process.env.KOYORI_EXECUTABLE ?? require("electron");
  if (typeof executablePath !== "string") throw new Error("Missing Electron executable");
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env))
    if (value !== undefined && key !== "ELECTRON_RUN_AS_NODE") env[key] = value;
  env.HOME = home;
  env.CODEX_HOME = join(home, ".codex");
  env.CLAUDE_CONFIG_DIR = join(home, ".claude");
  const args = [
    ...(process.env.KOYORI_EXECUTABLE ? [] : [resolve("apps/desktop/out/main/index.js")]),
    `--user-data-dir=${userData}`,
    "--disable-auto-update-check",
    "--koyori-acceptance-hidden",
  ];
  const launch = () => electron.launch({ executablePath, args, env });
  let app = await launch();
  try {
    let page = await app.firstWindow();
    await page.setViewportSize({ width: 960, height: 640 });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.getByRole("button", { name: /discussion-writer/ }).click();
    await page.getByRole("button", { name: "和 Koyori 讨论", exact: true }).click();
    let preview = page.getByRole("region", { name: "Skill 讨论摘要" });
    await expect(preview).toBeVisible();
    await expect(preview.locator("pre")).toContainText("未连接");
    await expect(preview.getByRole("button", { name: "加入当前草稿" })).toBeDisabled();
    expect(requests).toHaveLength(0);
    await preview.getByRole("button", { name: "丢弃摘要" }).click();
    await expect(preview).not.toBeVisible();
    await page.getByLabel("连接名称", { exact: true }).fill("摘要验收连接");
    await page.getByLabel("服务地址", { exact: true }).fill(`http://127.0.0.1:${address.port}/v1`);
    await page.getByLabel("模型", { exact: true }).fill("synthetic-discussion-model");
    await page.getByRole("button", { name: "保存连接", exact: true }).click();
    await page.getByLabel("消息", { exact: true }).fill("已有草稿：请先核对证据。");
    await page.getByRole("button", { name: "Skills", exact: true }).click();
    await page.getByRole("button", { name: "使用与建议", exact: true }).click();
    await page.getByRole("checkbox", { name: /Claude Code projects/ }).check();
    await page.getByRole("button", { name: "开启所选目录的自动统计" }).click();
    await expect(page.getByText("自动采集已开启", { exact: true })).toBeVisible();
    await expect(
      page.locator(".usage-metric").filter({ hasText: "调用尝试" }).locator("strong"),
    ).toHaveText("1");
    const inventoryTab = page.getByRole("button", { name: "资源清单", exact: true });
    await inventoryTab.focus();
    await inventoryTab.press("Enter");
    await expect(inventoryTab).toHaveAttribute("aria-pressed", "true");
    await expect(
      page.getByRole("heading", { name: "discussion-writer", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "和 Koyori 讨论", exact: true }).click();
    preview = page.getByRole("region", { name: "Skill 讨论摘要" });
    await expect(preview).toBeVisible();
    const snapshot = await preview.locator("pre").innerText();
    expect(snapshot).toContain("discussion-writer");
    expect(snapshot).toMatch(/调用尝试[^\n]*1/);
    expect(requests).toHaveLength(0);
    await page.getByRole("button", { name: "Skills", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "discussion-writer", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "和 Koyori 讨论", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "Agent", exact: true }).click();
    await expect(preview.locator("pre")).toHaveText(snapshot);
    await expect(page.getByLabel("消息", { exact: true })).toHaveValue("已有草稿：请先核对证据。");
    await page.setViewportSize({ width: 1240, height: 820 });
    await page.screenshot({ path: "artifacts/desktop-discussion-1240.png" });
    await page.setViewportSize({ width: 960, height: 640 });
    await page.screenshot({ path: "artifacts/desktop-discussion-960.png" });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    const draft = page.getByLabel("消息", { exact: true });
    await draft.fill("x".repeat(65_536));
    await preview.getByRole("button", { name: "加入当前草稿" }).click();
    await expect(preview).toBeVisible();
    await expect(draft).toHaveValue("x".repeat(65_536));
    await draft.fill("已有草稿：请先核对证据。");
    await preview.getByRole("button", { name: "加入当前草稿" }).focus();
    await preview.getByRole("button", { name: "加入当前草稿" }).press("Enter");
    await expect(preview).not.toBeVisible();
    await expect(draft).toHaveValue(`已有草稿：请先核对证据。\n\n${snapshot}`);
    expect(requests).toHaveLength(0);
    const edited = `${await draft.inputValue()}\n请再列出目前无法判断的事项。`;
    await draft.fill(edited);
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(
      page.getByText("合成建议：证据有限，先保留并复查。", { exact: true }),
    ).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const view = await window.koyori.getAgent();
          return view.sessions
            .find((session) => session.id === view.selectedSessionId)
            ?.messages.at(-1)?.status;
        }),
      )
      .toBe("complete");
    expect(requests).toHaveLength(1);
    expect(JSON.parse(requests[0] ?? "{}")).toMatchObject({
      messages: [{ role: "user", content: edited }],
    });
    for (const excluded of [
      temporary,
      "PRIVATE_DESCRIPTION",
      "PRIVATE_SKILL_BODY",
      "OTHER_PRIVATE_BODY",
      "other-private-skill",
      "private-session-id",
      "private-message-id",
      "private-invocation-id",
      "private-project-name",
      "private-session.jsonl",
      "PRIVATE_TOOL_ARGUMENTS",
    ])
      expect(requests[0]).not.toContain(excluded);
    expect(await readFile(join(source, "SKILL.md"), "utf8")).toBe(content);
    expect(
      await page.evaluate(async () => (await window.koyori.getAgent()).secureStorageAvailable),
    ).toBeNull();
    expect(errors).toEqual([]);
    await app.close();
    app = await launch();
    page = await app.firstWindow();
    await page.getByRole("button", { name: "Agent", exact: true }).click();
    await expect(page.getByText(edited, { exact: true })).toBeVisible();
    expect(requests).toHaveLength(1);
  } catch (error) {
    const page = app.windows()[0];
    if (page && !page.isClosed()) {
      await Promise.allSettled([
        page
          .screenshot()
          .then((body) =>
            test.info().attach("discussion-page", { body, contentType: "image/png" }),
          ),
        page
          .locator("body")
          .ariaSnapshot()
          .then((body) =>
            test.info().attach("discussion-accessibility", { body, contentType: "text/plain" }),
          ),
        page
          .evaluate(() => window.koyori.getWorkspace())
          .then((view) =>
            test.info().attach("discussion-workspace", {
              body: JSON.stringify(view),
              contentType: "application/json",
            }),
          ),
      ]);
    }
    throw error;
  } finally {
    await app.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(temporary, { recursive: true, force: true });
  }
});
