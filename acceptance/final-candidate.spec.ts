import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

async function fixture() {
  const require = createRequire(resolve("apps/desktop/package.json"));
  const executablePath: unknown = process.env.KOYORI_EXECUTABLE ?? require("electron");
  if (typeof executablePath !== "string") throw new Error("Missing Electron executable");
  const temporary = await mkdtemp(join(tmpdir(), "koyori-final-acceptance-"));
  const home = join(temporary, "home");
  const userData = join(temporary, "data");
  await mkdir(home, { recursive: true });
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== "ELECTRON_RUN_AS_NODE") env[key] = value;
  }
  env.HOME = home;
  env.CODEX_HOME = join(home, ".codex");
  env.CLAUDE_CONFIG_DIR = join(home, ".claude");
  if (process.env.KOYORI_EXECUTABLE) env.ELECTRON_RENDERER_URL = "https://renderer.invalid";
  const args = [
    ...(process.env.KOYORI_EXECUTABLE ? [] : [resolve("apps/desktop/out/main/index.js")]),
    `--user-data-dir=${userData}`,
    "--disable-auto-update-check",
  ];
  return {
    temporary,
    home,
    userData,
    launch: () => electron.launch({ executablePath, args, env }),
  };
}

test("register a project, preview and deploy a Skill, then revoke into recoverable storage", async () => {
  const isolated = await fixture();
  const source = join(isolated.home, ".claude", "skills", "fixture-deploy");
  const project = join(isolated.temporary, "fixture-project");
  const target = join(project, ".claude", "skills", "fixture-deploy");
  const skill =
    "---\nname: fixture-deploy\ndescription: Synthetic project deployment\n---\nUse fixture assets only.\n";
  await mkdir(join(source, "assets"), { recursive: true });
  await mkdir(project);
  await writeFile(join(source, "SKILL.md"), skill);
  await writeFile(join(source, "assets", "proof.txt"), "synthetic asset\n");
  const app = await isolated.launch();
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "添加来源", exact: true }).click();
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, project);
    await page.getByRole("button", { name: "关联项目" }).click();
    await expect
      .poll(async () =>
        page.evaluate(
          async (projectPath) =>
            (await window.koyori.getWorkspace()).targets.some((item) =>
              item.path.startsWith(projectPath),
            ),
          project,
        ),
      )
      .toBe(true);
    await page.getByRole("button", { name: "同步与备份", exact: true }).click();
    const management = page.getByRole("region", { name: "同步与备份" });
    await management.getByRole("checkbox", { name: /fixture-deploy/ }).check();
    const projectCard = management.getByRole("region", { name: "项目 Skills 部署" });
    const claudeTarget = await projectCard
      .getByLabel("项目目标")
      .locator("option")
      .filter({ hasText: "Claude Code" })
      .first()
      .getAttribute("value");
    expect(claudeTarget).toBeTruthy();
    await projectCard.getByLabel("项目目标").selectOption(claudeTarget ?? "");
    await projectCard.getByRole("button", { name: "预览项目部署" }).click();
    const preview = management.getByRole("region", { name: "操作计划" });
    await expect(preview).toContainText("项目部署计划");
    await expect(preview).toContainText(target);
    await expect(readFile(join(target, "SKILL.md"))).rejects.toMatchObject({ code: "ENOENT" });
    await preview.getByRole("checkbox", { name: "我已检查目标、差异和兼容提示" }).check();
    await preview.getByRole("button", { name: "确认执行项目部署" }).click();
    await expect.poll(() => readFile(join(target, "SKILL.md"), "utf8")).toBe(skill);
    expect(await readFile(join(target, "assets", "proof.txt"), "utf8")).toBe("synthetic asset\n");
    const deployment = await page.evaluate(async () =>
      (await window.koyori.getManagement()).projectDeployments.find(
        (item) => item.status === "active",
      ),
    );
    expect(deployment).toMatchObject({ projectPath: project, targetPath: target });
    await projectCard.getByRole("button", { name: "预览撤销" }).click();
    await expect(preview).toContainText("项目撤销计划");
    expect(await readFile(join(target, "SKILL.md"), "utf8")).toBe(skill);
    await preview.getByRole("checkbox", { name: "我已检查目标、差异和兼容提示" }).check();
    await preview.getByRole("button", { name: "确认执行项目撤销" }).click();
    await expect
      .poll(async () =>
        page.evaluate(
          async () =>
            (await window.koyori.getManagement()).projectDeployments.find((item) =>
              item.targetPath.endsWith("fixture-deploy"),
            )?.status,
        ),
      )
      .toBe("revoked");
    await expect(readFile(join(target, "SKILL.md"))).rejects.toMatchObject({ code: "ENOENT" });
    const state = await page.evaluate(() => window.koyori.getManagement());
    const revoked = state.projectDeployments.find((item) => item.targetPath === target);
    const recoveryPath = revoked?.recoveryPath;
    expect(recoveryPath).toBeTruthy();
    if (!recoveryPath) throw new Error("Missing project recovery path");
    expect(dirname(recoveryPath)).toBe(join(project, ".claude", "skills"));
    expect(basename(recoveryPath)).toMatch(/^\.koyori-recovery-fixture-deploy-[0-9a-f-]{36}$/);
    const revokeOperation = state.operations.find((item) => item.kind === "project-revoke");
    expect(revokeOperation?.status).toBe("succeeded");
    expect(revokeOperation?.items[0]?.recoveryPath).toBe(recoveryPath);
    await expect(projectCard).toContainText(recoveryPath);
    const history = management.getByRole("region", { name: "最近文件操作" });
    await history.locator("summary").first().click();
    await expect(history).toContainText(recoveryPath);
    expect(await readFile(join(recoveryPath, "SKILL.md"), "utf8")).toBe(skill);
    expect(await readFile(join(recoveryPath, "assets", "proof.txt"), "utf8")).toBe(
      "synthetic asset\n",
    );
    expect(await readFile(join(source, "SKILL.md"), "utf8")).toBe(skill);
  } finally {
    await app.close();
    await rm(isolated.temporary, { recursive: true, force: true });
  }
});

test("service bookmarks add, edit and remove without visiting the saved URL", async () => {
  const isolated = await fixture();
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.writeHead(200).end("synthetic service");
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture port");
  const first = `http://127.0.0.1:${address.port}/first`;
  const edited = `http://127.0.0.1:${address.port}/edited`;
  let app = await isolated.launch();
  try {
    let page = await app.firstWindow();
    await page.getByRole("button", { name: "我的服务" }).click();
    await expect(page.getByText("还没有服务入口")).toBeVisible();
    await page.getByLabel("名称", { exact: true }).fill("合成入口");
    await page.getByLabel("HTTPS 或本机地址").fill(first);
    await page.getByRole("button", { name: "添加到我的服务" }).click();
    const card = page.locator(".service-card");
    await expect(card).toContainText(first);
    expect(requests).toBe(0);
    await card.getByRole("button", { name: "编辑" }).click();
    await page.getByLabel("名称", { exact: true }).fill("已编辑入口");
    await page.getByLabel("HTTPS 或本机地址").fill(edited);
    await page.getByRole("button", { name: "保存修改" }).click();
    await expect(card).toContainText(edited);
    expect(requests).toBe(0);
    await app.close();
    app = await isolated.launch();
    page = await app.firstWindow();
    await page.getByRole("button", { name: "我的服务" }).click();
    await expect(page.locator(".service-card")).toContainText("已编辑入口");
    await expect(page.locator(".service-card")).toContainText(edited);
    expect(requests).toBe(0);
    const saved = JSON.parse(await readFile(join(isolated.userData, "services.json"), "utf8"));
    expect(saved.services).toMatchObject([{ name: "已编辑入口", url: edited }]);
    await page.locator(".service-card").getByRole("button", { name: "移除" }).click();
    await expect(page.getByText("还没有服务入口")).toBeVisible();
    expect((await page.evaluate(() => window.koyori.getServices())).length).toBe(0);
    expect(requests).toBe(0);
  } finally {
    await app.close();
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    await rm(isolated.temporary, { recursive: true, force: true });
  }
});

test("Skill preference card previews and confirms both local choices", async () => {
  const isolated = await fixture();
  const source = join(isolated.home, ".claude", "skills", "fixture-preference");
  const content =
    "---\nname: fixture-preference\ndescription: Synthetic preference fixture\n---\nNo provider needed.\n";
  await mkdir(source, { recursive: true });
  await writeFile(join(source, "SKILL.md"), content);
  const app = await isolated.launch();
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: /fixture-preference/ }).click();
    await page.getByRole("button", { name: "和 Koyori 讨论" }).click();
    const card = page.getByRole("region", { name: "Skill 本地操作卡" });
    await expect(card).toBeVisible();
    const skillId = await page.evaluate(
      async () =>
        (await window.koyori.getWorkspace()).inventory?.skills.find(
          (item) => item.name === "fixture-preference",
        )?.id,
    );
    expect(skillId).toBeTruthy();
    await card.getByRole("button", { name: "30 天后复查" }).click();
    await expect(card).toContainText("确认后：未标记始终保留");
    await card.getByRole("button", { name: "确认保存偏好" }).click();
    await expect(card).toContainText("已保存“fixture-preference”的偏好。");
    const review = await page.evaluate(
      async (id) => (await window.koyori.getUsage()).preferences[id],
      skillId ?? "",
    );
    expect(review?.keep).toBe(false);
    expect(review?.reviewAfter).toBeTruthy();
    await card.getByRole("button", { name: "始终保留" }).click();
    await expect(card).toContainText("确认后：始终保留 · 无复查日期");
    await card.getByRole("button", { name: "确认保存偏好" }).click();
    await expect(card).toContainText("已保存“fixture-preference”的偏好。");
    const kept = await page.evaluate(
      async (id) => (await window.koyori.getUsage()).preferences[id],
      skillId ?? "",
    );
    expect(kept).toMatchObject({ keep: true, reviewAfter: null });
    expect(await readFile(join(source, "SKILL.md"), "utf8")).toBe(content);
  } finally {
    await app.close();
    await rm(isolated.temporary, { recursive: true, force: true });
  }
});
