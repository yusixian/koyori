import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { scanSkills } from "./scan-skills.ts";
import type { ClientId, ResourceRoot } from "./types.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function createTemporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "koyori-scan-test-"));
  temporaryDirectories.push(path);
  return path;
}

async function writeSkill(
  root: string,
  directory: string,
  name: string,
  description: string,
  entry = "SKILL.md",
  body = "# Instructions\n",
): Promise<string> {
  const skillDirectory = join(root, directory);
  await mkdir(skillDirectory, { recursive: true });
  const path = join(skillDirectory, entry);
  await writeFile(path, `---\nname: ${name}\ndescription: ${description}\n---\n${body}`, "utf8");
  return path;
}

function root(id: string, path: string, client: ClientId = "codex"): ResourceRoot {
  return { id, path, client, label: id };
}

describe("scanSkills", () => {
  it("preserves same-named skills from different roots", async () => {
    const workspace = await createTemporaryDirectory();
    const firstRoot = join(workspace, "first");
    const secondRoot = join(workspace, "second");
    await writeSkill(firstRoot, "shared-name", "shared", "First copy");
    await writeSkill(secondRoot, "another-location", "shared", "Second copy");

    const inventory = await scanSkills([
      root("first", firstRoot, "claude-code"),
      root("second", secondRoot),
    ]);

    expect(inventory.issues).toEqual([]);
    expect(inventory.skills).toHaveLength(2);
    expect(inventory.skills.map((skill) => skill.name)).toEqual(["shared", "shared"]);
    expect(inventory.skills.map((skill) => skill.rootId)).toEqual(["first", "second"]);
    expect(inventory.skills[0]?.id).not.toBe(inventory.skills[1]?.id);
  });

  it("accepts lowercase skill.md with a compatibility warning", async () => {
    const workspace = await createTemporaryDirectory();
    await writeSkill(workspace, "lowercase", "lowercase", "Synthetic fixture", "skill.md");

    const inventory = await scanSkills([root("root", workspace)]);

    expect(inventory.skills).toHaveLength(1);
    expect(inventory.skills[0]?.name).toBe("lowercase");
    expect(inventory.issues).toContainEqual(
      expect.objectContaining({ code: "nonstandard-entry", severity: "warning" }),
    );
  });

  it("reports malformed frontmatter without inventing a skill record", async () => {
    const workspace = await createTemporaryDirectory();
    const skillDirectory = join(workspace, "broken");
    await mkdir(skillDirectory, { recursive: true });
    await writeFile(join(skillDirectory, "SKILL.md"), "---\nname: [broken\n---\nbody", "utf8");

    const inventory = await scanSkills([root("root", workspace)]);

    expect(inventory.skills).toEqual([]);
    expect(inventory.issues).toContainEqual(
      expect.objectContaining({ code: "invalid-metadata", severity: "error" }),
    );
  });

  it("follows links within selected roots while rejecting loops and cross-root links", async () => {
    const workspace = await createTemporaryDirectory();
    const firstRoot = join(workspace, "selected-a");
    const secondRoot = join(workspace, "selected-b");
    const outsideRoot = join(workspace, "not-selected");
    await mkdir(firstRoot, { recursive: true });
    await writeSkill(secondRoot, "linked-skill", "linked", "Authorized linked skill");
    await writeSkill(outsideRoot, "private-skill", "outside", "Outside selected roots");
    await symlink(join(secondRoot, "linked-skill"), join(firstRoot, "allowed-link"));
    await symlink(join(outsideRoot, "private-skill"), join(firstRoot, "outside-link"));
    await symlink(firstRoot, join(firstRoot, "loop"));

    const inventory = await scanSkills([root("a", firstRoot), root("b", secondRoot)]);

    expect(inventory.skills).toHaveLength(2);
    expect(inventory.skills).toContainEqual(
      expect.objectContaining({ rootId: "a", name: "linked", isSymlink: true }),
    );
    expect(inventory.skills).toContainEqual(
      expect.objectContaining({ rootId: "b", name: "linked", isSymlink: false }),
    );
    expect(inventory.issues.map((entry) => entry.code)).toEqual(
      expect.arrayContaining(["cross-root-link", "symlink-loop"]),
    );
    expect(inventory.skills.some((skill) => skill.name === "outside")).toBe(false);
  });

  it("reports a missing root", async () => {
    const workspace = await createTemporaryDirectory();
    const missing = join(workspace, "missing");

    const inventory = await scanSkills([root("missing", missing)]);

    expect(inventory.skills).toEqual([]);
    expect(inventory.issues).toEqual([
      expect.objectContaining({ path: missing, code: "missing", severity: "error" }),
    ]);
  });

  it("returns an explicit cancellation issue", async () => {
    const workspace = await createTemporaryDirectory();
    const controller = new AbortController();
    controller.abort();

    const inventory = await scanSkills([root("root", workspace)], { signal: controller.signal });

    expect(inventory.skills).toEqual([]);
    expect(inventory.issues).toEqual([
      expect.objectContaining({ code: "cancel", severity: "error" }),
    ]);
  });

  it("truncates oversized content after parsing bounded metadata", async () => {
    const workspace = await createTemporaryDirectory();
    await writeSkill(
      workspace,
      "large",
      "large",
      "Large synthetic fixture",
      "SKILL.md",
      "x".repeat(300 * 1024),
    );

    const inventory = await scanSkills([root("root", workspace)]);

    expect(inventory.issues).toEqual([]);
    expect(inventory.skills).toHaveLength(1);
    expect(inventory.skills[0]?.contentTruncated).toBe(true);
    expect(Buffer.byteLength(inventory.skills[0]?.content ?? "", "utf8")).toBeLessThanOrEqual(
      256 * 1024,
    );
  });
});
