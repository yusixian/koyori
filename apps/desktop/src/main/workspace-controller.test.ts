import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

type Handler = (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown;
const handlers = vi.hoisted(() => new Map<string, Handler>());
vi.mock("electron", () => ({
  ipcMain: { handle: (name: string, handler: Handler) => handlers.set(name, handler) },
  dialog: { showOpenDialog: vi.fn() },
}));
vi.mock("node:worker_threads", async () => {
  const { EventEmitter } = await import("node:events");
  const { scanSkills } = await import("@koyori/core");
  return {
    Worker: class extends EventEmitter {
      constructor(_url: URL, options: { workerData: Parameters<typeof scanSkills>[0] }) {
        super();
        queueMicrotask(() => {
          void scanSkills(options.workerData).then(
            (result) => this.emit("message", result),
            (error: unknown) => this.emit("error", error),
          );
        });
      }
      async terminate() {
        return 0;
      }
    },
  };
});

import type { WorkspaceView } from "../bridge";
import { createWorkspaceController } from "./workspace-controller";

let temporary: string;
beforeEach(async () => {
  handlers.clear();
  temporary = await mkdtemp(join(tmpdir(), "koyori-workspace-"));
});
afterEach(async () => {
  await rm(temporary, { recursive: true, force: true });
});
async function create() {
  return createWorkspaceController({
    path: join(temporary, "data", "sources.json"),
    home: temporary,
    getWindow: () => undefined,
    resourceBusy: () => false,
    observe: async () => {},
    trusted: vi.fn(),
    changed: vi.fn(),
  });
}
function invoke(name: string, ...args: unknown[]) {
  const handler = handlers.get(name);
  if (!handler) throw new Error("Missing handler");
  return handler({} as Electron.IpcMainInvokeEvent, ...args);
}
async function skill(name: string) {
  const path = join(temporary, ".claude", "skills", name);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "SKILL.md"), `---\nname: ${name}\ndescription: Fixture\n---\nFixture`);
}

it("finds new Skills on refresh and preserves a disconnect across restart", async () => {
  await skill("first");
  let workspace = await create();
  expect((await workspace.refresh()).busy).toBe(false);
  expect(workspace.getInventory()?.skills.map((item) => item.name)).toEqual(["first"]);
  await skill("second");
  await workspace.refresh();
  expect(workspace.getInventory()?.skills).toHaveLength(2);
  const root = workspace.getRoots().find((item) => item.client === "claude-code");
  expect(root).toBeDefined();
  await invoke("roots:remove", root?.id);
  workspace = await create();
  await workspace.refresh();
  expect(workspace.getRoots().some((item) => item.client === "claude-code")).toBe(false);
  await invoke("workspace:discover", true);
  expect(workspace.getInventory()?.skills).toHaveLength(2);
  expect(
    await readFile(join(temporary, ".claude", "skills", "first", "SKILL.md"), "utf8"),
  ).toContain("Fixture");
});

it("keeps missing standard destinations selectable without creating them, and never exposes the system target", async () => {
  const workspace = await create();
  await workspace.refresh();
  expect(
    workspace.getTargets().some((item) => item.path === join(temporary, ".agents", "skills")),
  ).toBe(true);
  expect(workspace.getTargets().some((item) => item.path === "/etc/codex/skills")).toBe(false);
  await expect(readFile(join(temporary, ".agents", "skills"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("keeps discovery disabled over restart until the user explicitly refreshes discovery", async () => {
  const workspace = await create();
  await invoke("workspace:automatic", false);
  await skill("later");
  const restarted = await create();
  await restarted.refresh();
  expect(restarted.getInventory()?.skills).toHaveLength(0);
  await invoke("workspace:discover", false);
  expect(restarted.getInventory()?.skills).toHaveLength(1);
  expect(workspace.isBusy()).toBe(false);
});

it("surfaces actionable discovery diagnostics without listing every missing optional path", async () => {
  const target = join(temporary, "linked-claude-skills");
  await mkdir(target, { recursive: true });
  await mkdir(join(temporary, ".claude"), { recursive: true });
  await symlink(target, join(temporary, ".claude", "skills"));

  const workspace = await create();
  await workspace.refresh();
  const view = (await invoke("workspace:get")) as WorkspaceView;

  expect(view.discoveryIssues).toEqual(
    expect.arrayContaining([expect.objectContaining({ code: "symlink" })]),
  );
  expect(view.discoveryIssues.some((issue) => issue.code === "missing")).toBe(false);
});
