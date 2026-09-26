import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResourceRoot } from "@koyori/core";
import { afterEach, describe, expect, it } from "vitest";
import type { DiscoveredRoot } from "../../../../packages/core/src/discover-sources.ts";
import {
  disconnectAutomaticRoot,
  emptySourceSettings,
  mergeDiscoveredRoots,
  parseSourceSettings,
  readSourceSettings,
  resetIgnoredPath,
  writeSourceSettings,
} from "./source-store";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function settingsPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "koyori-sources-test-"));
  temporaryDirectories.push(directory);
  return join(directory, "sources.json");
}

function root(id: string, path: string, client: ResourceRoot["client"] = "codex"): ResourceRoot {
  return { id, path, client, label: id };
}

function discovered(
  id: string,
  path: string,
  client: ResourceRoot["client"] = "codex",
): DiscoveredRoot {
  return {
    ...root(id, path, client),
    origin: "detected",
    scope: "user",
    readOnly: false,
    canonicalPath: path,
    kind: "standard",
    sharedClients: [client],
  };
}

describe("source settings persistence", () => {
  it("migrates version 1, preserves root IDs, and backs up the old file", async () => {
    const path = await settingsPath();
    const legacy = {
      version: 1,
      roots: [root("keep-this-id", "/tmp/legacy-skills", "claude-code")],
    };
    await writeFile(path, JSON.stringify(legacy), "utf8");

    const migrated = await readSourceSettings(path);

    expect(migrated).toEqual({
      version: 2,
      roots: legacy.roots,
      ignoredPaths: [],
      automaticDiscovery: true,
      projects: [],
    });
    expect(JSON.parse(await readFile(`${path}.bak`, "utf8"))).toEqual(legacy);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(migrated);
  });

  it("rejects corrupt or future settings without overwriting them", async () => {
    const path = await settingsPath();
    const corrupt = "{not-json";
    await writeFile(path, corrupt, "utf8");

    await expect(readSourceSettings(path)).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe(corrupt);
    await expect(readFile(`${path}.bak`, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("writes atomically and retains the previous valid state in a backup", async () => {
    const path = await settingsPath();
    const initial = emptySourceSettings();
    const next = { ...initial, automaticDiscovery: false, projects: ["/tmp/project"] };
    await writeSourceSettings(path, initial);
    await writeSourceSettings(path, next);

    expect(await readSourceSettings(path)).toEqual(next);
    expect(await readSourceSettings(`${path}.bak`)).toEqual(initial);
    expect((await readdir(join(path, ".."))).some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  it("merges detected roots without duplicating or replacing persisted IDs", () => {
    const existing = root("manual-id", "/tmp/shared", "codex");
    const settings = { ...emptySourceSettings(), roots: [existing] };
    const merged = mergeDiscoveredRoots(settings, [
      discovered("detected-id", "/tmp/shared", "codex"),
      discovered("new-id", "/tmp/claude", "claude-code"),
    ]);

    expect(merged.roots).toEqual([
      { ...existing, canonicalPath: "/tmp/shared", scope: "user" },
      {
        ...root("new-id", "/tmp/claude", "claude-code"),
        canonicalPath: "/tmp/claude",
        scope: "user",
      },
    ]);
  });

  it("persists detected scope while leaving manually added scope unknown", async () => {
    const path = await settingsPath();
    const settings = mergeDiscoveredRoots(
      { ...emptySourceSettings(), roots: [root("manual", "/tmp/custom")] },
      [{ ...discovered("project", "/tmp/project-skills"), scope: "project" }],
    );

    await writeSourceSettings(path, settings);

    expect((await readSourceSettings(path)).roots).toEqual([
      root("manual", "/tmp/custom"),
      expect.objectContaining({ id: "project", scope: "project" }),
    ]);
  });

  it("persists an ignored automatic path and supports explicit reset", () => {
    const settings = {
      ...emptySourceSettings(),
      roots: [root("detected", "/tmp/auto", "codex")],
    };
    const disconnected = disconnectAutomaticRoot(settings, "/tmp/auto");
    expect(disconnected.roots).toEqual([]);
    expect(disconnected.ignoredPaths).toEqual(["/tmp/auto"]);
    expect(
      mergeDiscoveredRoots(disconnected, [discovered("again", "/tmp/auto", "codex")]).roots,
    ).toEqual([]);
    expect(resetIgnoredPath(disconnected, "/tmp/auto").ignoredPaths).toEqual([]);
  });

  it("rejects relative roots and invalid v2 fields before any write", () => {
    expect(() =>
      parseSourceSettings({
        version: 2,
        roots: [root("relative", "relative")],
        ignoredPaths: [],
        automaticDiscovery: true,
        projects: [],
      }),
    ).toThrow();
    expect(() => parseSourceSettings({ version: 2, roots: [], ignoredPaths: [] })).toThrow();
    expect(() =>
      parseSourceSettings({
        ...emptySourceSettings(),
        roots: [{ ...root("invalid", "/tmp/invalid"), scope: "private" }],
      }),
    ).toThrow();
  });
});
