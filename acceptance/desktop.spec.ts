import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { _electron as electron, expect, test } from "@playwright/test";

test("selected roots, preview, persistence and no source writes", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "koyori-acceptance-"));
  const resource = join(temporary, "skills", "review");
  const userData = join(temporary, "app-data");
  const history = join(temporary, "history");
  await mkdir(resource, { recursive: true });
  await mkdir(userData, { recursive: true });
  await mkdir(history, { recursive: true });
  const content =
    "---\nname: acceptance-review\ndescription: A synthetic read-only acceptance fixture.\n---\n\nNever execute this document.\n<script>throw new Error('unsafe')</script>\n";
  await writeFile(join(resource, "SKILL.md"), content);
  const timestamp = new Date().toISOString();
  const metadata = { timestamp, sessionId: "synthetic-session", version: "2.1.278" };
  const log = [
    ...["loaded", "failed", "unresolved"].map((id) => ({
      ...metadata,
      type: "assistant",
      uuid: `message-${id}`,
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id,
            name: "Skill",
            input: { skill: "acceptance-review", args: "PRIVATE_SENTINEL_DO_NOT_RETAIN" },
          },
        ],
      },
    })),
    ...["loaded", "failed"].map((id) => ({
      ...metadata,
      type: "user",
      uuid: `result-${id}`,
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: id,
            ...(id === "failed" ? { is_error: true } : {}),
            content: "PRIVATE_SENTINEL_DO_NOT_RETAIN",
          },
        ],
      },
    })),
    {
      ...metadata,
      type: "user",
      uuid: "request",
      message: {
        role: "user",
        content:
          "<command-message>acceptance-review</command-message>\n<command-name>/acceptance-review</command-name>",
      },
    },
  ]
    .map((record) => JSON.stringify(record))
    .join("\n");
  await writeFile(join(history, "session.jsonl"), log);
  await writeFile(join(history, "copy.jsonl"), log);
  const require = createRequire(resolve("apps/desktop/package.json"));
  const executablePath: unknown = process.env.KOYORI_EXECUTABLE ?? require("electron");
  if (typeof executablePath !== "string") throw new Error("Missing Electron executable");
  if (process.env.KOYORI_EXECUTABLE) {
    const licenses = resolve(dirname(executablePath), "../Resources/licenses");
    for (const name of [
      "KOYORI-LICENSE",
      "ELECTRON-LICENSE",
      "ELECTRON-THIRD-PARTY-LICENSES.html",
    ]) {
      expect((await stat(join(licenses, name))).size).toBeGreaterThan(0);
    }
  }
  const args = [
    ...(process.env.KOYORI_EXECUTABLE ? [] : [resolve("apps/desktop/out/main/index.js")]),
    `--user-data-dir=${userData}`,
  ];
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== "ELECTRON_RUN_AS_NODE") env[key] = value;
  }
  env.HOME = join(temporary, "home");
  env.CODEX_HOME = join(temporary, "home", ".codex");
  env.CLAUDE_CONFIG_DIR = join(temporary, "home", ".claude");
  await mkdir(env.HOME, { recursive: true });
  // Production must ignore a development renderer URL, including inherited environment values.
  if (process.env.KOYORI_EXECUTABLE) env.ELECTRON_RENDERER_URL = "https://renderer.invalid";
  const launch = () => electron.launch({ args, executablePath, env });
  let app = await launch();
  try {
    let page = await app.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await expect(page.getByRole("heading", { name: "每一份能力，都有来处。" })).toBeVisible();
    expect(page.url()).toBe("koyori://app/index.html");
    await page.getByRole("button", { name: /先看看示例/ }).click();
    await expect(page.getByText("示例模式 · 以下资源为合成示例，没有读取本机文件。")).toBeVisible();
    await page.getByRole("button", { name: "退出示例" }).click();
    await app.evaluate(
      ({ dialog }, directory) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
      },
      join(temporary, "skills"),
    );
    await page.getByRole("button", { name: "添加来源", exact: true }).click();
    await page.getByRole("button", { name: "选择目录", exact: true }).click();
    await expect(page.getByText(join(temporary, "skills"), { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "扫描", exact: true }).click();
    await page.getByRole("button", { name: /acceptance-review/ }).click();
    await expect(page.locator("pre")).toHaveText(content);
    await expect(page.getByLabel("Skill 详情")).toContainText("尚未采集");
    await page.screenshot({ path: "artifacts/desktop-skills.png" });
    await page.setViewportSize({ width: 960, height: 640 });
    await expect(page.getByRole("button", { name: "关闭详情" })).toBeVisible();
    await page.getByRole("button", { name: "关闭详情" }).click();
    await expect(page.getByRole("button", { name: /acceptance-review/ })).toBeVisible();
    await page.getByRole("button", { name: "使用与建议", exact: true }).click();
    await app.evaluate(({ dialog }, directory) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
    }, history);
    await page.getByRole("button", { name: /选择日志目录|连接历史/ }).click();
    const importButton = page.getByRole("button", { name: "导入使用记录" });
    await importButton.click();
    await expect(
      page.locator(".usage-metric").filter({ hasText: "调用尝试" }).locator("strong"),
    ).toHaveText("3");
    await expect(
      page.locator(".usage-metric").filter({ hasText: "成功返回" }).locator("strong"),
    ).toHaveText("1");
    await expect(
      page.locator(".usage-metric").filter({ hasText: "显式请求" }).locator("strong"),
    ).toHaveText("1");
    await importButton.click();
    await expect(importButton).toBeEnabled();
    await expect(
      page.locator(".usage-metric").filter({ hasText: "调用尝试" }).locator("strong"),
    ).toHaveText("3");
    await page.getByRole("checkbox", { name: /保留/ }).click();
    await expect(page.getByRole("checkbox", { name: /保留/ })).toBeChecked();
    await page.getByRole("button", { name: /30 天后复查/ }).click();
    await expect(page.getByRole("button", { name: /清除复查日期/ })).toBeVisible();
    await page.getByRole("button", { name: /证据 4/ }).click();
    await expect(page.getByText("session.jsonl:1", { exact: false }).first()).toBeVisible();
    await page.locator(".usage-panel").screenshot({ path: "artifacts/desktop-usage-960.png" });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.setViewportSize({ width: 1240, height: 820 });
    await page.locator(".usage-panel").screenshot({ path: "artifacts/desktop-usage-1240.png" });
    await page.getByRole("button", { name: /断开/ }).click();
    await expect(page.getByText("已断开", { exact: true })).toBeVisible();
    await expect(importButton).toBeDisabled();
    const ledger = await readFile(join(userData, "usage.json"), "utf8");
    expect(ledger).not.toContain("PRIVATE_SENTINEL_DO_NOT_RETAIN");
    expect(await readFile(join(history, "session.jsonl"), "utf8")).toBe(log);
    await app.close();
    app = await launch();
    page = await app.firstWindow();
    page.on("pageerror", (error) => errors.push(error.message));
    await page.getByRole("button", { name: "扫描", exact: true }).click();
    await expect(page.getByRole("button", { name: /acceptance-review/ })).toContainText("3 次尝试");
    await page.getByRole("button", { name: "使用与建议", exact: true }).click();
    await expect(page.getByRole("checkbox", { name: /保留/ })).toBeChecked();
    await expect(page.getByRole("button", { name: /清除复查日期/ })).toBeVisible();
    await expect(page.getByRole("button", { name: "导入使用记录" })).toBeDisabled();
    await page.getByRole("button", { name: "来源设置", exact: true }).click();
    await expect(page.getByText(join(temporary, "skills"), { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "移除来源", exact: true }).click();
    await expect(page.getByText(join(temporary, "skills"), { exact: true })).toHaveCount(0);
    expect(
      await page.evaluate(async () =>
        (await window.koyori.getUsage()).sources.every((source) => !source.enabled),
      ),
    ).toBe(true);
    expect(await readFile(join(resource, "SKILL.md"), "utf8")).toBe(content);
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("automatic discovery, opt-in evidence, complete-folder sync and restore preview", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "koyori-managed-acceptance-"));
  const home = join(temporary, "home");
  const source = join(home, ".claude", "skills", "writer");
  const history = join(home, ".claude", "projects", "fixture");
  const destination = join(home, ".agents", "skills", "writer");
  const userData = join(temporary, "data");
  await mkdir(join(source, "assets"), { recursive: true });
  await mkdir(history, { recursive: true });
  const content =
    "---\nname: fixture-writer\ndescription: Complete-folder acceptance fixture\n---\nUse the fixture asset.\n";
  await writeFile(join(source, "SKILL.md"), content);
  await writeFile(join(source, "assets", "fixture.txt"), "original asset");
  await writeFile(
    join(history, "session.jsonl"),
    `${JSON.stringify({
      type: "assistant",
      timestamp: new Date().toISOString(),
      sessionId: "fixture-session",
      uuid: "fixture-message",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "fixture-use",
            name: "Skill",
            input: { skill: "fixture-writer", args: "NEVER_RETAIN_RAW_ARGUMENTS" },
          },
        ],
      },
    })}\n`,
  );
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
  ];
  let app = await electron.launch({ executablePath, args, env });
  try {
    let page = await app.firstWindow();
    await expect(page.getByRole("button", { name: /fixture-writer/ })).toBeVisible();
    await expect(
      readFile(join(userData, "usage.json"), "utf8").then((value) => value.includes("fixture-use")),
    ).resolves.toBe(false);
    await page.getByRole("button", { name: "使用与建议", exact: true }).click();
    await page.getByRole("checkbox", { name: /Claude Code projects/ }).check();
    await page.getByRole("button", { name: "开启所选目录的自动统计" }).click();
    await expect(page.getByText("自动采集已开启", { exact: true })).toBeVisible();
    await expect(
      page.locator(".usage-metric").filter({ hasText: "调用尝试" }).locator("strong"),
    ).toHaveText("1");
    for (const name of ["usage.json", "usage.json.cache"])
      expect(await readFile(join(userData, name), "utf8")).not.toContain(
        "NEVER_RETAIN_RAW_ARGUMENTS",
      );
    await page.getByRole("button", { name: "同步与备份", exact: true }).click();
    await page.getByRole("checkbox", { name: /fixture-writer/ }).check();
    await page.getByRole("button", { name: "备份所选 Skills" }).click();
    await expect(page.getByText("已在本机保存 1 项完整目录快照。")).toBeVisible();
    await page.getByRole("button", { name: /预览同步计划/ }).click();
    await expect(page.getByLabel("操作计划")).toContainText("2 个文件");
    await expect(readFile(join(destination, "SKILL.md"))).rejects.toMatchObject({ code: "ENOENT" });
    await page.getByRole("checkbox", { name: "我已检查目标、差异和兼容提示" }).check();
    await page.getByRole("button", { name: "确认执行同步" }).click();
    await expect(page.getByText("已完成 1 项，内容相同跳过 0 项。")).toBeVisible();
    const operationHistory = page.getByRole("region", { name: "最近文件操作" });
    await operationHistory.locator("summary").first().click();
    await expect(operationHistory).toContainText(destination);
    await expect(operationHistory).toContainText("已完成");
    expect(await readFile(join(destination, "assets", "fixture.txt"), "utf8")).toBe(
      "original asset",
    );
    await page.getByRole("button", { name: "预览原位恢复" }).first().click();
    await expect(page.getByLabel("操作计划")).toContainText("内容相同，跳过");
    await page.getByRole("button", { name: "取消计划" }).click();
    await page.setViewportSize({ width: 960, height: 640 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: "artifacts/desktop-management-960.png" });
    const bare = join(temporary, "remote.git");
    await promisify(execFile)("git", ["init", "--bare", bare]);
    await page.getByRole("textbox", { name: "备份仓库地址" }).fill(bare);
    await page.getByRole("button", { name: "连接备份仓库", exact: true }).click();
    await expect(page.getByRole("button", { name: "断开远端", exact: true })).toBeVisible();
    await page
      .getByRole("checkbox", { name: "已检查目录内容，同意将完整 Skill 文件发送到这个远端" })
      .check();
    await page.getByRole("button", { name: "上传所选快照", exact: true }).click();
    await expect(page.getByText("远端已核验", { exact: true })).toBeVisible();
    const remoteHead = (
      await promisify(execFile)("git", [
        "--git-dir",
        bare,
        "rev-parse",
        "refs/heads/koyori-backups",
      ])
    ).stdout.trim();
    expect(remoteHead).toMatch(/^[a-f0-9]{40}$/);
    await page.getByRole("button", { name: "获取最新历史", exact: true }).click();
    await page.getByRole("button", { name: "取回快照", exact: true }).first().click();
    await expect(
      page.getByText("已取回为本地快照。请在本地恢复快照中选择客户端并预览恢复。"),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "预览原位恢复", exact: true })).toHaveCount(2);
    expect(await readFile(join(source, "assets", "fixture.txt"), "utf8")).toBe("original asset");
    await app.close();
    app = await electron.launch({ executablePath, args, env });
    page = await app.firstWindow();
    await expect(page.getByRole("button", { name: /fixture-writer/ })).toHaveCount(2);
    await page.getByRole("button", { name: "同步与备份", exact: true }).click();
    await expect(page.getByRole("button", { name: "预览原位恢复" }).first()).toBeVisible();
    expect(await readFile(join(source, "SKILL.md"), "utf8")).toBe(content);
  } finally {
    await app.close();
    await rm(temporary, { recursive: true, force: true });
  }
});
