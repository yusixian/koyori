import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createManagementStore, type ResourceRoot, scanSkills } from "@koyori/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { GitBackupStore } from "../../../../packages/core/src/git-backup-types";
import type { RemoteBackupView } from "../bridge";

type Handler = (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown;
const mocks = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  changes: [] as (() => void)[],
}));
vi.mock("electron", () => ({
  ipcMain: { handle: (name: string, handler: Handler) => mocks.handlers.set(name, handler) },
}));
vi.mock("node:fs", async (original) => ({
  ...(await original<typeof import("node:fs")>()),
  watch: (_path: string, _options: unknown, listener: () => void) => {
    mocks.changes.push(listener);
    return { on: vi.fn(), close: vi.fn() };
  },
}));

import { createRemoteBackupController } from "./remote-backup-controller";

let temporary: string;
const stops: (() => void)[] = [];
beforeEach(async () => {
  mocks.handlers.clear();
  mocks.changes.length = 0;
  temporary = await mkdtemp(join(tmpdir(), "koyori-remote-host-"));
});
afterEach(async () => {
  for (const stop of stops.splice(0)) stop();
  vi.useRealTimers();
  await rm(temporary, { recursive: true, force: true });
});
function invoke(name: string, ...args: unknown[]) {
  const handler = mocks.handlers.get(name);
  if (!handler) throw new Error("Missing handler");
  return handler({} as Electron.IpcMainInvokeEvent, ...args);
}
async function fixture() {
  const source = join(temporary, "source"),
    path = join(source, "writer");
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "SKILL.md"), "---\nname: writer\ndescription: Fixture\n---\nFixture");
  let roots: ResourceRoot[] = [
    { id: "source", path: source, client: "claude-code", label: "source" },
  ];
  const inventory = await scanSkills(roots);
  const management = await createManagementStore(join(temporary, "local"), {
    authorizedRoots: () => [
      ...roots.map((root) => root.path),
      join(temporary, "remote", "exports"),
    ],
  });
  const publish = vi.fn<GitBackupStore["publish"]>().mockResolvedValue({
    commit: "a".repeat(40),
    state: "verified",
    remoteCommit: "a".repeat(40),
    verified: true,
    error: null,
  });
  const git: GitBackupStore = {
    status: async () => ({
      version: 1,
      configured: true,
      remote: "ssh://git@example.test/backup",
      branch: "koyori-backups",
      localCommit: null,
      remoteCommit: null,
      state: "local-only",
      lastPublishedAt: null,
      lastError: null,
    }),
    connect: async () => git.status(),
    disconnect: async () => {},
    publish,
    history: async () => [],
    fetchSnapshot: async () => {
      throw new Error("Unexpected fetch");
    },
  };
  const controller = await createRemoteBackupController({
    dataDirectory: join(temporary, "remote"),
    git,
    management,
    getRoots: () => roots,
    getInventory: () => inventory,
    resourceBusy: () => false,
    trusted: vi.fn(),
    changed: vi.fn(),
  });
  stops.push(controller.stop);
  return {
    controller,
    management,
    publish,
    ids: inventory.skills.map((skill) => skill.id),
    revoke: () => {
      roots = [];
    },
  };
}

it("does no automatic upload until enabled and waits for the debounce window", async () => {
  const setup = await fixture();
  vi.useFakeTimers();
  await setup.controller.tick();
  expect(setup.publish).not.toHaveBeenCalled();
  await invoke("backup:remote:automatic", true, setup.ids);
  await setup.controller.tick();
  expect(setup.publish).not.toHaveBeenCalled();
  vi.setSystemTime(Date.now() + 120_001);
  await setup.controller.tick();
  expect(setup.publish).toHaveBeenCalledOnce();
  expect(await setup.management.listBackups()).toHaveLength(1);
  await invoke("backup:remote:automatic", false, []);
  for (const changed of mocks.changes) changed();
  vi.setSystemTime(Date.now() + 500_000);
  await setup.controller.tick();
  expect(setup.publish).toHaveBeenCalledOnce();
});

it("keeps failed snapshots for retry and stops reading revoked roots", async () => {
  const setup = await fixture();
  setup.publish.mockRejectedValueOnce(new Error("Offline"));
  vi.useFakeTimers();
  await invoke("backup:remote:automatic", true, setup.ids);
  vi.setSystemTime(Date.now() + 120_001);
  await setup.controller.tick();
  const view = (await invoke("backup:remote:get")) as RemoteBackupView;
  expect(view.lastError).toBe("Offline");
  expect(view.nextAttemptAt).not.toBeNull();
  expect(await setup.management.listBackups()).toHaveLength(1);
  expect(await readFile(join(temporary, "remote", "automatic-backup.json"), "utf8")).toContain(
    "pendingSnapshotId",
  );
  setup.revoke();
  vi.setSystemTime(Date.now() + 240_000);
  await setup.controller.tick();
  expect(setup.publish).toHaveBeenCalledOnce();
  expect(((await invoke("backup:remote:get")) as RemoteBackupView).lastError).toContain(
    "来源已断开",
  );
});

it("retries the preserved snapshot without uploading unchanged content twice", async () => {
  const setup = await fixture();
  setup.publish.mockRejectedValueOnce(new Error("Offline"));
  vi.useFakeTimers();
  await invoke("backup:remote:automatic", true, setup.ids);
  vi.setSystemTime(Date.now() + 120_001);
  await setup.controller.tick();
  const pending = JSON.parse(
    await readFile(join(temporary, "remote", "automatic-backup.json"), "utf8"),
  );
  expect(pending.pendingSnapshotId).toBeTruthy();
  vi.setSystemTime(Date.now() + 120_001);
  await setup.controller.tick();
  expect(setup.publish).toHaveBeenCalledTimes(2);
  const settled = JSON.parse(
    await readFile(join(temporary, "remote", "automatic-backup.json"), "utf8"),
  );
  expect(settled.pendingSnapshotId).toBeNull();
  expect(settled.lastFingerprint).toBeTruthy();
  for (const changed of mocks.changes) changed();
  vi.setSystemTime(Date.now() + 120_001);
  await setup.controller.tick();
  expect(setup.publish).toHaveBeenCalledTimes(2);
  expect(((await invoke("backup:remote:get")) as RemoteBackupView).lastError).toBeNull();
});
