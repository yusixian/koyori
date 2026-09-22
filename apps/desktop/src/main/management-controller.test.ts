import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ResourceRoot, scanSkills } from "@koyori/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ManagementPlanPreview, ManagementView, SourceTarget } from "../bridge";

type Handler = (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown;
const handlers = vi.hoisted(() => new Map<string, Handler>());
vi.mock("electron", () => ({
  ipcMain: { handle: (name: string, handler: Handler) => handlers.set(name, handler) },
}));

import { createManagementController } from "./management-controller";

let temporary: string;
beforeEach(async () => {
  handlers.clear();
  temporary = await mkdtemp(join(tmpdir(), "koyori-management-host-"));
});
afterEach(async () => {
  await rm(temporary, { recursive: true, force: true });
});
function invoke(name: string, ...args: unknown[]) {
  const handler = handlers.get(name);
  if (!handler) throw new Error(`Missing handler ${name}`);
  return handler({} as Electron.IpcMainInvokeEvent, ...args);
}
async function fixture() {
  const source = join(temporary, "source");
  const destination = join(temporary, "target");
  await mkdir(join(source, "writer", "assets"), { recursive: true });
  await mkdir(destination);
  await writeFile(
    join(source, "writer", "SKILL.md"),
    "---\nname: writer\ndescription: Fixture\n---\nHello",
  );
  await writeFile(join(source, "writer", "assets", "fixture.txt"), "asset");
  await mkdir(join(source, "reviewer"), { recursive: true });
  await writeFile(
    join(source, "reviewer", "SKILL.md"),
    "---\nname: reviewer\ndescription: Fixture\n---\nReview",
  );
  let roots: ResourceRoot[] = [
    { id: "source", path: source, client: "claude-code", label: "source" },
  ];
  let targets: SourceTarget[] = [
    { id: "target", path: destination, client: "codex", label: "target", shared: false },
  ];
  const inventory = await scanSkills(roots);
  const refresh = vi.fn(async () => {});
  const trusted = vi.fn();
  await createManagementController({
    dataDirectory: join(temporary, "state"),
    getRoots: () => roots,
    getTargets: () => targets,
    getInventory: () => inventory,
    resourceBusy: () => false,
    trusted,
    changed: vi.fn(),
    refresh,
  });
  const ids = inventory.skills.filter((skill) => skill.name === "writer").map((skill) => skill.id);
  const allIds = inventory.skills.map((skill) => skill.id);
  return {
    source,
    destination,
    ids,
    allIds,
    refresh,
    trusted,
    revoke: () => {
      roots = [];
      targets = [];
    },
  };
}

it("previews complete folders, executes once, and reports copied files", async () => {
  const setup = await fixture();
  const plan = (await invoke(
    "management:sync:plan",
    setup.ids,
    "target",
    false,
  )) as ManagementPlanPreview;
  expect(plan.items).toMatchObject([{ files: 2, action: "copy" }]);
  await expect(readFile(join(setup.destination, "writer", "SKILL.md"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  const result = (await invoke("management:execute", plan.id)) as ManagementView;
  expect(result.lastResult).toContain("已完成 1 项");
  expect(result.operations).toMatchObject([
    {
      kind: "sync",
      status: "succeeded",
      items: [{ target: join(setup.destination, "writer"), status: "succeeded" }],
    },
  ]);
  expect(await readFile(join(setup.destination, "writer", "assets", "fixture.txt"), "utf8")).toBe(
    "asset",
  );
  await expect(invoke("management:execute", plan.id)).rejects.toThrow("计划不存在");
  expect(setup.refresh).toHaveBeenCalledOnce();
});

it("exposes the retained recovery material from a managed replacement", async () => {
  const setup = await fixture();
  await mkdir(join(setup.destination, "writer"));
  await writeFile(
    join(setup.destination, "writer", "SKILL.md"),
    "---\nname: writer\ndescription: Existing\n---\nOld",
  );
  const plan = (await invoke(
    "management:sync:plan",
    setup.ids,
    "target",
    true,
  )) as ManagementPlanPreview;

  const result = (await invoke("management:execute", plan.id)) as ManagementView;
  expect(result.operations[0]?.items[0]).toMatchObject({
    target: join(setup.destination, "writer"),
    status: "succeeded",
    recoveryState: "preserved",
  });
  expect(result.operations[0]?.items[0]?.recoveryPath).toEqual(expect.any(String));
});

it("rejects a previously reviewed plan when its source or target is revoked", async () => {
  const setup = await fixture();
  const plan = (await invoke(
    "management:sync:plan",
    setup.ids,
    "target",
    false,
  )) as ManagementPlanPreview;
  setup.revoke();
  await expect(invoke("management:execute", plan.id)).rejects.toThrow("已经断开");
  await expect(readFile(join(setup.destination, "writer", "SKILL.md"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("preserves an external edit after preview and exposes failure instead of success", async () => {
  const setup = await fixture();
  const plan = (await invoke(
    "management:sync:plan",
    setup.ids,
    "target",
    false,
  )) as ManagementPlanPreview;
  await mkdir(join(setup.destination, "writer"));
  await writeFile(join(setup.destination, "writer", "SKILL.md"), "external");
  await expect(invoke("management:execute", plan.id)).rejects.toThrow();
  const result = (await invoke("management:get")) as ManagementView;
  expect(result.lastResult).toContain("失败或取消 1 项");
  expect(await readFile(join(setup.destination, "writer", "SKILL.md"), "utf8")).toBe("external");
});

it("reports actual partial restore counts and refreshes after the attempted writes", async () => {
  const setup = await fixture();
  const backedUp = (await invoke("management:backup", setup.allIds)) as ManagementView;
  const snapshot = backedUp.backups[0];
  if (!snapshot) throw new Error("Missing backup fixture");
  const plan = (await invoke(
    "management:restore:plan",
    snapshot.id,
    "target",
    false,
  )) as ManagementPlanPreview;
  await mkdir(join(setup.destination, "writer"));
  await writeFile(join(setup.destination, "writer", "SKILL.md"), "external");

  await expect(invoke("management:execute", plan.id)).rejects.toThrow("未全部完成");
  const result = (await invoke("management:get")) as ManagementView;
  expect(result.lastResult).toContain("已完成 1 项");
  expect(result.lastResult).toContain("失败或取消 1 项");
  expect(result.lastResult).not.toContain("其余操作停止");
  expect(await readFile(join(setup.destination, "reviewer", "SKILL.md"), "utf8")).toContain(
    "Review",
  );
  expect(await readFile(join(setup.destination, "writer", "SKILL.md"), "utf8")).toBe("external");
  expect(setup.refresh).toHaveBeenCalledOnce();
});

it("rejects every operation at the trust boundary before examining caller input", async () => {
  const setup = await fixture();
  setup.trusted.mockImplementation(() => {
    throw new Error("Unauthorized window");
  });
  for (const name of handlers.keys()) {
    await expect(Promise.resolve().then(() => invoke(name))).rejects.toThrow("Unauthorized window");
  }
});
