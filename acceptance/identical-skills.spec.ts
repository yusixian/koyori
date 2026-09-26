import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

test("same-content suggestions compare authorized sources and open both details", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "koyori-identical-skills-"));
  const home = join(temporary, "home");
  const claudeSkill = join(home, ".claude", "skills", "comparison");
  const codexSkill = join(home, ".agents", "skills", "comparison");
  const manualOne = join(home, "custom", "one");
  const manualTwo = join(home, "custom", "two");
  const data = join(temporary, "data");
  const content =
    "---\nname: fixture-compare\ndescription: Synthetic Skill comparison fixture\n---\n\n# Fixture\n";
  const manualContent =
    "---\nname: fixture-manual\ndescription: Synthetic same-client comparison fixture\n---\n\n# Fixture\n";
  await mkdir(claudeSkill, { recursive: true });
  await mkdir(codexSkill, { recursive: true });
  await mkdir(manualOne, { recursive: true });
  await mkdir(manualTwo, { recursive: true });
  await mkdir(data, { recursive: true });
  await writeFile(join(claudeSkill, "SKILL.md"), content);
  await writeFile(join(codexSkill, "SKILL.md"), content);
  await writeFile(join(manualOne, "SKILL.md"), manualContent);
  await writeFile(join(manualTwo, "SKILL.md"), manualContent);
  await writeFile(
    join(data, "sources.json"),
    JSON.stringify({
      version: 2,
      roots: [
        { id: "manual-one", client: "claude-code", path: manualOne, label: "相同来源" },
        { id: "manual-two", client: "claude-code", path: manualTwo, label: "相同来源" },
      ],
      ignoredPaths: [],
      automaticDiscovery: true,
      projects: [],
    }),
  );
  const require = createRequire(resolve("apps/desktop/package.json"));
  const executablePath: unknown = require("electron");
  if (typeof executablePath !== "string") throw new Error("Missing Electron executable");
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== "ELECTRON_RUN_AS_NODE") env[key] = value;
  }
  env.HOME = home;
  env.CODEX_HOME = join(home, ".codex");
  env.CLAUDE_CONFIG_DIR = join(home, ".claude");
  const app = await electron.launch({
    args: [
      resolve("apps/desktop/out/main/index.js"),
      `--user-data-dir=${data}`,
      "--disable-auto-update-check",
      "--koyori-acceptance-hidden",
    ],
    executablePath,
    env,
  });
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setViewportSize({ width: 1240, height: 820 });
    await page.getByRole("button", { name: "使用与建议", exact: true }).click();
    const candidate = page.locator(".usage-suggestion-comparison").filter({
      hasText: "fixture-compare",
    });
    await expect(candidate).toContainText("内容相同");
    if (process.env.KOYORI_SHOT_DIR && process.env.KOYORI_SHOT_NAME) {
      await candidate.screenshot({
        path: join(process.env.KOYORI_SHOT_DIR, process.env.KOYORI_SHOT_NAME),
      });
    }
    await expect(candidate.locator(".usage-candidate")).toHaveCount(2);
    await expect(candidate).toContainText("Claude Code / 用户级");
    await expect(candidate).toContainText("Codex / 用户级");
    await expect(candidate).toContainText("Claude Code Skills");
    await expect(candidate).toContainText("Shared Skills");
    await expect(candidate).toContainText(join(claudeSkill, "SKILL.md"));
    await expect(candidate).toContainText(join(codexSkill, "SKILL.md"));
    await expect(candidate).toContainText("未知 · 未连接历史来源");
    await expect(candidate).toContainText("未知 · 暂不采集调用记录");
    await expect(candidate).toContainText("非链接 · 本组候选为不同实际文件");
    await page.setViewportSize({ width: 960, height: 640 });
    const cards = candidate.locator(".usage-candidate");
    const left = await cards.nth(0).boundingBox();
    const right = await cards.nth(1).boundingBox();
    expect(left?.y).toBe(right?.y);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    if (process.env.KOYORI_SHOT_DIR) {
      await candidate.screenshot({ path: join(process.env.KOYORI_SHOT_DIR, "after-960.png") });
    }
    await page.setViewportSize({ width: 1240, height: 820 });
    const paths = new Set<string>();
    for (const path of [join(claudeSkill, "SKILL.md"), join(codexSkill, "SKILL.md")]) {
      await candidate.getByRole("button", { name: `查看 fixture-compare 详情（${path}）` }).click();
      const detail = page.getByLabel("Skill 详情");
      await expect(detail).toBeVisible();
      paths.add(await detail.locator(".path").innerText());
      await page.getByRole("button", { name: "使用与建议", exact: true }).click();
    }
    expect(paths).toEqual(new Set([join(claudeSkill, "SKILL.md"), join(codexSkill, "SKILL.md")]));
    const manualCandidate = page.locator(".usage-suggestion-comparison").filter({
      hasText: "fixture-manual",
    });
    await expect(manualCandidate.locator(".usage-candidate")).toHaveCount(2);
    await expect(manualCandidate).toContainText("Claude Code / 未知");
    for (const path of [join(manualOne, "SKILL.md"), join(manualTwo, "SKILL.md")]) {
      await expect(manualCandidate).toContainText(path);
      await expect(
        manualCandidate.getByRole("button", { name: `查看 fixture-manual 详情（${path}）` }),
      ).toBeVisible();
    }
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    await rm(temporary, { recursive: true, force: true });
  }
});
