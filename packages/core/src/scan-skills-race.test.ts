import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { scanSkillsWithRuntimeForTest } from "./scan-skills.ts";

let temporaryDirectory: string | undefined;

afterEach(async () => {
  if (temporaryDirectory) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = undefined;
  }
});

describe("scanSkills file-boundary races", () => {
  it("does not read a target swapped outside the authorized root", async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "koyori-scan-race-test-"));
    const rootPath = join(temporaryDirectory, "selected");
    const authorizedTarget = join(rootPath, "authorized.md");
    const outsideTarget = join(temporaryDirectory, "outside.md");
    const skillPath = join(rootPath, "SKILL.md");
    await mkdir(rootPath);
    await writeFile(
      authorizedTarget,
      "---\nname: allowed\ndescription: Authorized fixture\n---\n",
      "utf8",
    );
    await writeFile(
      outsideTarget,
      "---\nname: outside\ndescription: Must not be read\n---\nprivate content",
      "utf8",
    );
    await symlink(authorizedTarget, skillPath);
    let readStarted = false;

    const inventory = await scanSkillsWithRuntimeForTest(
      [{ id: "selected", client: "codex", path: rootPath, label: "Selected" }],
      {},
      {
        async beforeOpen(path) {
          await unlink(path);
          await symlink(outsideTarget, path);
        },
        beforeRead() {
          readStarted = true;
        },
      },
    );

    expect(readStarted).toBe(false);
    expect(inventory.skills).toEqual([]);
    expect(inventory.issues).toContainEqual(
      expect.objectContaining({ code: "cross-root-link", path: skillPath }),
    );
  });
});
