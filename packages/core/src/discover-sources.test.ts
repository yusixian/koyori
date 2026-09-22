import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { discoverSources } from "./discover-sources.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function temporaryHome(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "koyori-discovery-test-"));
  temporaryDirectories.push(path);
  return path;
}

describe("discoverSources", () => {
  it("detects standard and compatibility roots without creating missing targets", async () => {
    const home = await temporaryHome();
    await mkdir(join(home, ".claude", "skills"), { recursive: true });
    await mkdir(join(home, ".agents", "skills"), { recursive: true });
    await mkdir(join(home, ".codex", "skills"), { recursive: true });
    await mkdir(join(home, ".claude", "projects"), { recursive: true });
    await mkdir(join(home, ".codex", "sessions"), { recursive: true });
    await mkdir(join(home, ".codex", "archived_sessions"), { recursive: true });

    const result = await discoverSources({ home });

    expect(result.roots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          client: "claude-code",
          kind: "standard",
          scope: "user",
          readOnly: false,
        }),
        expect.objectContaining({ client: "codex", kind: "shared", scope: "user" }),
        expect.objectContaining({ client: "codex", kind: "legacy", scope: "user" }),
      ]),
    );
    expect(result.roots.some((root) => root.path.startsWith("/etc/codex"))).toBe(false);
    expect(result.histories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ client: "claude-code", kind: "projects", readOnly: true }),
        expect.objectContaining({ client: "codex", kind: "sessions", readOnly: true }),
        expect.objectContaining({ client: "codex", kind: "archived_sessions", readOnly: true }),
      ]),
    );
    expect(result.histories.every((candidate) => candidate.rootIds.length > 0)).toBe(true);
    expect(result.targets).toEqual([
      expect.objectContaining({
        path: "/etc/codex/skills",
        readOnly: true,
        writable: false,
      }),
    ]);
  });

  it("returns missing writable deployment candidates and does not create them", async () => {
    const home = await temporaryHome();
    const project = join(home, "project");
    await mkdir(project, { recursive: true });

    const result = await discoverSources({ home, projects: [project] });

    expect(result.roots).toEqual([]);
    expect(result.targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: join(home, ".claude", "skills"),
          exists: false,
          writable: true,
          readOnly: false,
        }),
        expect.objectContaining({
          path: join(project, ".agents", "skills"),
          exists: false,
          writable: true,
          scope: "project",
        }),
      ]),
    );
    await expect(readFile(join(home, ".claude", "skills"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("canonicalizes symlinked project roots and preserves cross-client shared roots", async () => {
    const home = await temporaryHome();
    const project = join(home, "project");
    const projectAlias = join(home, "project-alias");
    await mkdir(join(home, ".agents", "skills"), { recursive: true });
    await mkdir(join(project, ".claude", "skills"), { recursive: true });
    await mkdir(join(project, ".agents", "skills"), { recursive: true });
    await symlink(project, projectAlias);

    const result = await discoverSources({
      home,
      claudeConfigDir: join(home, ".agents"),
      projects: [project, projectAlias],
    });

    const shared = result.roots.filter((root) => root.sharedClients.length === 2);
    expect(shared).toHaveLength(2);
    expect(new Set(shared.map((root) => root.client))).toEqual(new Set(["claude-code", "codex"]));
    expect(new Set(shared.map((root) => root.sharedGroupId)).size).toBe(1);
    expect(shared.every((root) => root.sharedClients.length === 2)).toBe(true);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "symlink",
          path: join(projectAlias, ".claude", "skills"),
        }),
        expect.objectContaining({ code: "duplicate" }),
      ]),
    );
  });

  it("reports invalid and unreadable candidates without treating them as history", async () => {
    const home = await temporaryHome();
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(join(home, ".claude", "skills"), "not a directory", "utf8");
    await mkdir(join(home, ".codex"), { recursive: true });
    await symlink(join(home, "missing-history"), join(home, ".codex", "sessions"));

    const result = await discoverSources({ home });

    expect(result.roots).toEqual([]);
    expect(result.histories).toEqual([]);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "invalid", path: join(home, ".claude", "skills") }),
        expect.objectContaining({ code: "unreadable", path: join(home, ".codex", "sessions") }),
      ]),
    );
  });

  it("uses explicit client homes and never attributes a profile by basename alone", async () => {
    const home = await temporaryHome();
    const codexHome = join(home, "profiles", "same-name");
    const claudeConfigDir = join(home, "other", "same-name");
    await mkdir(join(codexHome, "skills"), { recursive: true });
    await mkdir(join(codexHome, "sessions"), { recursive: true });
    await mkdir(join(claudeConfigDir, "skills"), { recursive: true });
    await mkdir(join(claudeConfigDir, "projects"), { recursive: true });

    const result = await discoverSources({ home, codexHome, claudeConfigDir });
    const claudeHistory = result.histories.find((item) => item.client === "claude-code");
    const codexHistory = result.histories.find((item) => item.client === "codex");

    expect(claudeHistory?.profile).toContain("profile:");
    expect(codexHistory?.profile).toContain("profile:");
    expect(claudeHistory?.profile).not.toBe(codexHistory?.profile);
    expect(
      claudeHistory?.rootIds.every(
        (id) => result.roots.find((root) => root.id === id)?.client === "claude-code",
      ),
    ).toBe(true);
    expect(
      codexHistory?.rootIds.every(
        (id) => result.roots.find((root) => root.id === id)?.client === "codex",
      ),
    ).toBe(true);
  });
});
