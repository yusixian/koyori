import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { createGitBackupStore } from "./git-backup.ts";
import { GitBackupError } from "./git-backup-types.ts";
import { createManagementStore } from "./managed-files.ts";

const execFile = promisify(execFileCallback);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "koyori-git-backup-test-"));
  temporaryDirectories.push(path);
  return path;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFile("git", args, {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    maxBuffer: 8 * 1024 * 1024,
  });
  return result.stdout;
}

async function portableSnapshot(workspace: string, text: string, id = "skill"): Promise<string> {
  const snapshot = join(workspace, `snapshot-${id}`);
  const content = Buffer.from(text, "utf8");
  const fileEntry = {
    path: "SKILL.md",
    kind: "file" as const,
    sourceKind: "file" as const,
    mode: 0o644,
    bytes: content.byteLength,
    hash: createHash("sha256").update(content).digest("hex"),
  };
  const directoryManifest = {
    algorithm: "sha256" as const,
    hash: createHash("sha256")
      .update(JSON.stringify([fileEntry]))
      .digest("hex"),
    files: 1,
    directories: 0,
    bytes: content.byteLength,
    entries: [fileEntry],
  };
  await mkdir(join(snapshot, "entries", id), { recursive: true });
  await writeFile(
    join(snapshot, "backup.json"),
    JSON.stringify({
      schema: "koyori.skill-backup",
      version: 1,
      id: `backup-${id}`,
      createdAt: "2026-09-22T00:00:00.000Z",
      entries: [
        {
          id,
          name: id,
          directoryName: id,
          files: 1,
          bytes: content.byteLength,
          manifest: directoryManifest,
        },
      ],
    }),
    "utf8",
  );
  await writeFile(join(snapshot, "entries", id, "SKILL.md"), content);
  return snapshot;
}

async function bareRemote(workspace: string): Promise<string> {
  const remote = join(workspace, "remote.git");
  await git(workspace, ["init", "--bare", "--quiet", remote]);
  return remote;
}

async function literalPortableSnapshot(workspace: string): Promise<string> {
  const snapshot = join(workspace, "literal-snapshot");
  const entryId = "literal";
  const root = join(snapshot, "entries", entryId);
  const files = new Map<string, { content: Buffer; mode: number }>([
    [".gitattributes", { content: Buffer.from("*.md text eol=lf\n"), mode: 0o644 }],
    [".gitignore", { content: Buffer.from("assets/asset.txt\n"), mode: 0o644 }],
    ["SKILL.md", { content: Buffer.from("# Literal\r\nBody\r\n"), mode: 0o600 }],
    ["assets/asset.txt", { content: Buffer.from("ignored-by-gitignore\n"), mode: 0o644 }],
    ["nested/config", { content: Buffer.from("nested-config\n"), mode: 0o644 }],
  ]);
  const directories = [
    { path: "assets", mode: 0o700 },
    { path: "nested", mode: 0o750 },
    { path: "references", mode: 0o700 },
  ];
  for (const directory of directories) await mkdir(join(root, directory.path), { recursive: true });
  for (const [path, value] of files) {
    const destination = join(root, path);
    await writeFile(destination, value.content);
    await chmod(destination, value.mode);
  }
  const manifestEntries = [
    ...directories.map((directory) => ({
      path: directory.path,
      kind: "directory" as const,
      sourceKind: "directory" as const,
      mode: directory.mode,
    })),
    ...[...files.entries()].map(([path, value]) => ({
      path,
      kind: "file" as const,
      sourceKind: "file" as const,
      mode: value.mode,
      bytes: value.content.byteLength,
      hash: createHash("sha256").update(value.content).digest("hex"),
    })),
  ].sort((left, right) => left.path.localeCompare(right.path));
  const contentBytes = [...files.values()].reduce(
    (sum, value) => sum + value.content.byteLength,
    0,
  );
  const directoryManifest = {
    algorithm: "sha256" as const,
    hash: createHash("sha256").update(JSON.stringify(manifestEntries)).digest("hex"),
    files: files.size,
    directories: directories.length,
    bytes: contentBytes,
    entries: manifestEntries,
  };
  await mkdir(snapshot, { recursive: true });
  await writeFile(
    join(snapshot, "backup.json"),
    JSON.stringify({
      schema: "koyori.skill-backup",
      version: 1,
      id: "literal-backup",
      createdAt: "2026-09-22T00:00:00.000Z",
      entries: [
        {
          id: entryId,
          name: "Literal",
          directoryName: entryId,
          files: files.size,
          bytes: contentBytes,
          manifest: directoryManifest,
        },
      ],
    }),
    "utf8",
  );
  return snapshot;
}

describe("Git backup transport", () => {
  it("starts without Git/network work and keeps a deduplicated local snapshot", async () => {
    const workspace = await temporaryDirectory();
    const store = await createGitBackupStore(join(workspace, "data"));
    expect(await store.status()).toMatchObject({
      state: "local-only",
      configured: false,
      localCommit: null,
    });

    const snapshot = await portableSnapshot(workspace, "first\n");
    const first = await store.publish(snapshot);
    expect(first).toMatchObject({ state: "local-only", verified: false });
    expect(first.commit).toMatch(/^[0-9a-f]{40}$/);
    expect((await store.history()).map((entry) => entry.commit)).toEqual([first.commit]);
    const fetched = await store.fetchSnapshot(first.commit);
    expect(await readFile(join(fetched.directory, "entries", "skill", "SKILL.md"), "utf8")).toBe(
      "first\n",
    );

    const repeated = await store.publish(snapshot);
    expect(repeated.commit).toBe(first.commit);
    expect((await store.history()).map((entry) => entry.commit)).toEqual([first.commit]);
  });

  it("pushes to the dedicated branch, verifies the exact remote SHA, and retains history after disconnect", async () => {
    const workspace = await temporaryDirectory();
    const remote = await bareRemote(workspace);
    const store = await createGitBackupStore(join(workspace, "data"));
    expect((await store.connect(remote)).state).toBe("pending");

    const snapshot = await portableSnapshot(workspace, "remote\n");
    const published = await store.publish(snapshot);
    expect(published).toMatchObject({
      state: "verified",
      verified: true,
      remoteCommit: published.commit,
    });
    expect(
      (
        await git(workspace, ["--git-dir", remote, "rev-parse", "refs/heads/koyori-backups"])
      ).trim(),
    ).toBe(published.commit);
    expect((await store.status()).state).toBe("verified");

    await store.disconnect();
    expect(await store.status()).toMatchObject({
      configured: false,
      remote: null,
      state: "local-only",
    });
    expect((await store.history())[0]?.commit).toBe(published.commit);
    const fetched = await store.fetchSnapshot(published.commit);
    expect(await readFile(join(fetched.directory, "backup.json"), "utf8")).toContain(
      "koyori.skill-backup",
    );
  });

  it("recovers an existing remote branch without uploading or touching real source paths", async () => {
    const workspace = await temporaryDirectory();
    const remote = await bareRemote(workspace);
    const sourceStore = await createGitBackupStore(join(workspace, "source-data"));
    await sourceStore.connect(remote);
    const published = await sourceStore.publish(await portableSnapshot(workspace, "shared\n"));

    const restoredStore = await createGitBackupStore(join(workspace, "restored-data"));
    const connected = await restoredStore.connect(remote);
    expect(connected).toMatchObject({
      state: "verified",
      localCommit: published.commit,
      remoteCommit: published.commit,
    });
    expect((await restoredStore.history())[0]?.commit).toBe(published.commit);
    const fetched = await restoredStore.fetchSnapshot(published.commit);
    expect(await readFile(join(fetched.directory, "entries", "skill", "SKILL.md"), "utf8")).toBe(
      "shared\n",
    );
  });

  it("keeps a local commit pending when the configured remote is unavailable", async () => {
    const workspace = await temporaryDirectory();
    const remote = await bareRemote(workspace);
    const store = await createGitBackupStore(join(workspace, "data"));
    await store.connect(remote);
    await rm(remote, { recursive: true, force: true });

    const published = await store.publish(await portableSnapshot(workspace, "offline\n"));
    expect(published.state).toBe("pending");
    expect(published.verified).toBe(false);
    expect((await store.status()).state).toBe("pending");
    expect((await store.history())[0]?.commit).toBe(published.commit);
  });

  it("rejects divergent histories without force pushing or losing the local object", async () => {
    const workspace = await temporaryDirectory();
    const remote = await bareRemote(workspace);
    const firstStore = await createGitBackupStore(join(workspace, "first-data"));
    await firstStore.connect(remote);
    const firstCommit = (await firstStore.publish(await portableSnapshot(workspace, "first\n")))
      .commit;
    await firstStore.disconnect();
    const localOnlyCommit = (
      await firstStore.publish(await portableSnapshot(workspace, "local\n", "local"))
    ).commit;

    const secondStore = await createGitBackupStore(join(workspace, "second-data"));
    await secondStore.connect(remote);
    const remoteCommit = (
      await secondStore.publish(await portableSnapshot(workspace, "remote\n", "remote"))
    ).commit;
    expect(remoteCommit).not.toBe(firstCommit);

    await expect(firstStore.connect(remote)).rejects.toMatchObject({ code: "conflict" });
    expect((await firstStore.history()).map((entry) => entry.commit)).toContain(localOnlyCommit);
    expect(
      (
        await git(workspace, ["--git-dir", remote, "rev-parse", "refs/heads/koyori-backups"])
      ).trim(),
    ).toBe(remoteCommit);
  });

  it("binds an existing local history to its selected remote", async () => {
    const workspace = await temporaryDirectory();
    const firstRemote = await bareRemote(workspace);
    const secondRemote = join(workspace, "second.git");
    await git(workspace, ["init", "--bare", "--quiet", secondRemote]);
    const store = await createGitBackupStore(join(workspace, "data"));
    await store.connect(firstRemote);
    const commit = (await store.publish(await portableSnapshot(workspace, "bound\n"))).commit;
    await store.disconnect();
    await expect(store.connect(secondRemote)).rejects.toMatchObject({ code: "conflict" });
    expect((await store.history())[0]?.commit).toBe(commit);
    await expect(
      git(workspace, ["--git-dir", secondRemote, "rev-parse", "refs/heads/koyori-backups"]),
    ).rejects.toBeTruthy();
  });

  it("rejects credential-bearing or unsafe remotes and unsafe snapshot contents", async () => {
    const workspace = await temporaryDirectory();
    const store = await createGitBackupStore(join(workspace, "data"));
    await expect(store.connect("https://token@example.com/repo.git")).rejects.toMatchObject({
      code: "invalid-input",
    });
    await expect(store.connect("https://user:password@example.com/repo.git")).rejects.toMatchObject(
      { code: "invalid-input" },
    );
    await expect(store.connect("file:///tmp/backup.git")).rejects.toMatchObject({
      code: "invalid-input",
    });
    await expect(store.connect("user:password@example.com:repo.git")).rejects.toMatchObject({
      code: "invalid-input",
    });

    const unsafe = join(workspace, "unsafe");
    await mkdir(join(unsafe, "entries", "skill"), { recursive: true });
    await writeFile(
      join(unsafe, "backup.json"),
      JSON.stringify({
        schema: "koyori.skill-backup",
        version: 1,
        id: "unsafe",
        createdAt: "2026-09-22T00:00:00.000Z",
        entries: [{ id: "skill", name: "skill", originalPath: "/private/user/skill" }],
      }),
      "utf8",
    );
    await writeFile(join(unsafe, "entries", "skill", "SKILL.md"), "unsafe\n", "utf8");
    await expect(store.publish(unsafe)).rejects.toMatchObject({ code: "corrupt-data" });
  });

  it("stores literal bytes and restores manifest modes and empty directories", async () => {
    const workspace = await temporaryDirectory();
    const store = await createGitBackupStore(join(workspace, "data"));
    const snapshot = await literalPortableSnapshot(workspace);
    const published = await store.publish(snapshot);
    const fetched = await store.fetchSnapshot(published.commit);
    const entryRoot = join(fetched.directory, "entries", "literal");
    expect(await readFile(join(entryRoot, "SKILL.md"))).toEqual(
      Buffer.from("# Literal\r\nBody\r\n"),
    );
    expect(await readFile(join(entryRoot, "assets", "asset.txt"), "utf8")).toBe(
      "ignored-by-gitignore\n",
    );
    expect((await lstat(join(entryRoot, "SKILL.md"))).mode & 0o777).toBe(0o600);
    expect((await lstat(join(entryRoot, "references"))).mode & 0o777).toBe(0o700);
    expect((await lstat(join(entryRoot, "nested"))).mode & 0o777).toBe(0o750);

    const management = await createManagementStore(join(workspace, "management-state"), {
      authorizedRoots: () => [fetched.directory],
    });
    const imported = await management.importBackup(fetched.directory);
    expect(imported.entries[0]).toMatchObject({ files: 5, bytes: expect.any(Number) });

    await mkdir(join(snapshot, "entries", "literal", "nested", ".git"), { recursive: true });
    await writeFile(
      join(snapshot, "entries", "literal", "nested", ".git", "config"),
      "private\n",
      "utf8",
    );
    await expect(store.publish(snapshot)).rejects.toMatchObject({ code: "corrupt-data" });
  });

  it("refuses to start over a corrupt persistent state file", async () => {
    const workspace = await temporaryDirectory();
    const data = join(workspace, "data");
    await mkdir(data, { recursive: true });
    await writeFile(join(data, "settings.json"), "{broken", "utf8");
    await expect(createGitBackupStore(data)).rejects.toMatchObject({ code: "corrupt-data" });
    expect(await readFile(join(data, "settings.json"), "utf8")).toBe("{broken");
  });

  it("rejects cancellation before staging a snapshot", async () => {
    const workspace = await temporaryDirectory();
    const store = await createGitBackupStore(join(workspace, "data"));
    const controller = new AbortController();
    controller.abort();
    await expect(
      store.publish(await portableSnapshot(workspace, "cancelled\n"), {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject(
      new GitBackupError("aborted", "The Git backup operation was cancelled."),
    );
  });
});
