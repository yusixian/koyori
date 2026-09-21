import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

test("selected roots, preview, persistence and no source writes", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "koyori-acceptance-"));
  const resource = join(temporary, "skills", "review");
  const userData = join(temporary, "app-data");
  await mkdir(resource, { recursive: true });
  await mkdir(userData, { recursive: true });
  const content =
    "---\nname: acceptance-review\ndescription: A synthetic read-only acceptance fixture.\n---\n\nNever execute this document.\n<script>throw new Error('unsafe')</script>\n";
  await writeFile(join(resource, "SKILL.md"), content);
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
    await app.close();
    app = await launch();
    page = await app.firstWindow();
    page.on("pageerror", (error) => errors.push(error.message));
    await page.getByRole("button", { name: "来源设置", exact: true }).click();
    await expect(page.getByText(join(temporary, "skills"), { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "移除来源", exact: true }).click();
    await expect(page.getByText(join(temporary, "skills"), { exact: true })).toHaveCount(0);
    expect(await readFile(join(resource, "SKILL.md"), "utf8")).toBe(content);
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    await rm(temporary, { recursive: true, force: true });
  }
});
