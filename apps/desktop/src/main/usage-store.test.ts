import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUsageState } from "@koyori/core";
import { afterEach, describe, expect, it } from "vitest";
import { isPreferencePatch, isUsageRules, readUsageState, writeUsageState } from "./usage-store";

const directories: string[] = [];
async function location() {
  const directory = await mkdtemp(join(tmpdir(), "koyori-ledger-"));
  directories.push(directory);
  return join(directory, "usage.json");
}
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("usage ledger persistence", () => {
  it("retains preferences and the previous valid state across restart", async () => {
    const path = await location();
    const initial = await readUsageState(path, createUsageState);
    await writeUsageState(path, initial);
    const next = {
      ...initial,
      preferences: {
        sample: { keep: true, reviewAfter: null, firstSeenAt: "2026-09-22T00:00:00.000Z" },
      },
    };
    await writeUsageState(path, next);
    expect(await readUsageState(path, createUsageState)).toEqual(next);
    expect(JSON.parse(await readFile(`${path}.bak`, "utf8"))).toEqual(initial);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("preserves corrupt and future-version files instead of resetting them", async () => {
    const path = await location();
    for (const content of ["{invalid", JSON.stringify({ ...createUsageState(), version: 2 })]) {
      await writeFile(path, content);
      await expect(readUsageState(path, createUsageState)).rejects.toThrow();
      expect(await readFile(path, "utf8")).toBe(content);
    }
  });

  it("keeps the existing ledger when backup cannot be written", async () => {
    const path = await location();
    const initial = createUsageState();
    await writeUsageState(path, initial);
    await mkdir(`${path}.bak`);
    await expect(
      writeUsageState(path, { ...initial, lastReviewedAt: "2026-09-22T00:00:00.000Z" }),
    ).rejects.toThrow();
    expect(await readUsageState(path, createUsageState)).toEqual(initial);
    expect((await readdir(join(path, ".."))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("rejects invalid rules and attempts to change first-observed evidence", () => {
    expect(isUsageRules({ idleDays: 0, lowUseThreshold: 2, graceDays: 30 })).toBe(false);
    expect(isUsageRules({ idleDays: 90, lowUseThreshold: 2.5, graceDays: 30 })).toBe(false);
    expect(isPreferencePatch({ firstSeenAt: "2020-01-01" })).toBe(false);
    expect(isPreferencePatch({ keep: true })).toBe(true);
    expect(isPreferencePatch({ reviewAfter: "invalid" })).toBe(false);
  });
});
