import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  createManagementStore,
  createManagementStoreWithRuntimeForTest,
  ManagementError,
} from "./managed-files.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "koyori-managed-files-test-"));
  temporaryDirectories.push(path);
  return path;
}

async function writeSkill(
  path: string,
  name: string,
  body = "# Instructions\n",
  extraFrontmatter = "",
): Promise<void> {
  await mkdir(path, { recursive: true });
  await writeFile(
    join(path, "SKILL.md"),
    `---\nname: ${name}\ndescription: Synthetic ${name}\n${extraFrontmatter}---\n${body}`,
    "utf8",
  );
}

describe("managed Skill files", () => {
  it("deploys only to an empty registered project target and retains the revoked copy", async () => {
    const workspace = await temporaryDirectory();
    const sourceRoot = join(workspace, "source");
    const source = join(sourceRoot, "writer");
    const projectPath = join(workspace, "project");
    const targetRoot = join(projectPath, ".agents", "skills");
    const target = join(targetRoot, "writer");
    await writeSkill(source, "writer");
    await writeFile(join(source, "asset.txt"), "resource", "utf8");
    await mkdir(projectPath);
    const store = await createManagementStore(join(workspace, "state"), {
      authorizedRoots: () => [sourceRoot, targetRoot],
    });
    const input = { source, projectPath, targetRoot, targetClient: "codex" as const };
    const planned = await store.planProjectDeploy(input);
    expect(planned.executable).toBe(true);
    expect((await store.executeProjectPlan(planned.id)).status).toBe("succeeded");
    expect(await readFile(join(target, "asset.txt"), "utf8")).toBe("resource");
    const deployment = (await store.listProjectDeployments())[0];
    expect(deployment).toMatchObject({ status: "active", sourcePath: source, targetPath: target });
    expect((await store.planProjectDeploy(input)).executable).toBe(false);

    const revoke = await store.planProjectRevoke(deployment?.id ?? "");
    expect(revoke.executable).toBe(true);
    const operation = await store.executeProjectPlan(revoke.id);
    expect(operation.status).toBe("succeeded");
    await expect(stat(target)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(operation.items[0]?.recoveryPath ?? "", "asset.txt"), "utf8")).toBe(
      "resource",
    );
    expect(dirname(operation.items[0]?.recoveryPath ?? "")).toBe(targetRoot);
    expect(operation.items[0]?.recoveryPath).toContain(".koyori-recovery-");
    expect((await store.listProjectDeployments())[0]).toMatchObject({ status: "revoked" });
    expect(await readFile(join(source, "asset.txt"), "utf8")).toBe("resource");
  });

  it("keeps pre-existing revoked records with app-data recovery paths readable", async () => {
    const workspace = await temporaryDirectory();
    const sourceRoot = join(workspace, "source");
    const source = join(sourceRoot, "writer");
    const projectPath = join(workspace, "project");
    const targetRoot = join(projectPath, ".agents", "skills");
    const state = join(workspace, "state");
    await writeSkill(source, "writer");
    await mkdir(projectPath);
    const options = { authorizedRoots: () => [sourceRoot, targetRoot] };
    const store = await createManagementStore(state, options);
    const deploy = await store.planProjectDeploy({
      source,
      projectPath,
      targetRoot,
      targetClient: "codex",
    });
    expect((await store.executeProjectPlan(deploy.id)).status).toBe("succeeded");
    const id = (await store.listProjectDeployments())[0]?.id ?? "";
    const revoke = await store.planProjectRevoke(id);
    expect((await store.executeProjectPlan(revoke.id)).status).toBe("succeeded");
    const path = join(state, "managed-files", "project-deployments", `${id}.json`);
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Invalid synthetic deployment record.");
    }
    const legacy = {
      ...value,
      recoveryPath: join(state, "managed-files", "recoveries", `project-${id}-legacy`),
    };
    await writeFile(path, JSON.stringify(legacy));
    const resumed = await createManagementStore(state, options);
    expect((await resumed.listProjectDeployments())[0]).toMatchObject({
      status: "revoked",
      recoveryPath: legacy.recoveryPath,
    });
  });

  it("rejects project-internal links escaping the registered project at plan and execution", async () => {
    const workspace = await temporaryDirectory();
    const sourceRoot = join(workspace, "source");
    const source = join(sourceRoot, "writer");
    const projectPath = join(workspace, "project");
    const targetRoot = join(projectPath, ".agents", "skills");
    const external = join(workspace, "external");
    await writeSkill(source, "writer");
    await mkdir(projectPath);
    await mkdir(external);
    const store = await createManagementStore(join(workspace, "state"), {
      authorizedRoots: () => [sourceRoot, targetRoot],
    });
    const input = { source, projectPath, targetRoot, targetClient: "codex" as const };
    await symlink(external, join(projectPath, ".agents"));
    await expect(store.planProjectDeploy(input)).rejects.toMatchObject({
      code: "outside-authorized-roots",
    });
    await rm(join(projectPath, ".agents"));
    const plan = await store.planProjectDeploy(input);
    await symlink(external, join(projectPath, ".agents"));
    expect((await store.executeProjectPlan(plan.id)).status).toBe("failed");
    await expect(stat(join(external, "skills", "writer"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("accepts a linked project whose Skills target stays within the real project", async () => {
    const workspace = await temporaryDirectory();
    const sourceRoot = join(workspace, "source");
    const source = join(sourceRoot, "writer");
    const realProject = join(workspace, "real-project");
    const projectPath = join(workspace, "project-alias");
    const targetRoot = join(projectPath, ".agents", "skills");
    await writeSkill(source, "writer");
    await mkdir(realProject);
    await symlink(realProject, projectPath);
    const store = await createManagementStore(join(workspace, "state"), {
      authorizedRoots: () => [sourceRoot, targetRoot],
    });
    const plan = await store.planProjectDeploy({
      source,
      projectPath,
      targetRoot,
      targetClient: "codex",
    });
    expect((await store.executeProjectPlan(plan.id)).status).toBe("succeeded");
    expect(
      await readFile(join(realProject, ".agents", "skills", "writer", "SKILL.md"), "utf8"),
    ).toContain("name: writer");
  });

  it("rejects revocation if a project Skills ancestor is redirected outside the project", async () => {
    const workspace = await temporaryDirectory();
    const sourceRoot = join(workspace, "source");
    const source = join(sourceRoot, "writer");
    const projectPath = join(workspace, "project");
    const targetRoot = join(projectPath, ".agents", "skills");
    const external = join(workspace, "external");
    await writeSkill(source, "writer");
    await mkdir(projectPath);
    await mkdir(external);
    const store = await createManagementStore(join(workspace, "state"), {
      authorizedRoots: () => [sourceRoot, targetRoot],
    });
    const deploy = await store.planProjectDeploy({
      source,
      projectPath,
      targetRoot,
      targetClient: "codex",
    });
    expect((await store.executeProjectPlan(deploy.id)).status).toBe("succeeded");
    const id = (await store.listProjectDeployments())[0]?.id ?? "";
    await rm(join(projectPath, ".agents"), { recursive: true });
    await symlink(external, join(projectPath, ".agents"));
    await expect(store.planProjectRevoke(id)).rejects.toMatchObject({
      code: "outside-authorized-roots",
    });
  });

  it("completes an interrupted deployment only for the staged directory identity", async () => {
    const workspace = await temporaryDirectory();
    const sourceRoot = join(workspace, "source");
    const source = join(sourceRoot, "writer");
    const projectPath = join(workspace, "project");
    const targetRoot = join(projectPath, ".agents", "skills");
    const state = join(workspace, "state");
    await writeSkill(source, "writer");
    await mkdir(projectPath);
    const options = { authorizedRoots: () => [sourceRoot, targetRoot] };
    const interrupted = await createManagementStoreWithRuntimeForTest(state, options, {
      afterProjectDeployRename: () => {
        throw new Error("synthetic interruption");
      },
    });
    const input = { source, projectPath, targetRoot, targetClient: "codex" as const };
    const plan = await interrupted.planProjectDeploy(input);
    expect((await interrupted.executeProjectPlan(plan.id)).status).toBe("failed");
    expect((await interrupted.listProjectDeployments())[0]?.status).toBe("deploying");
    const resumed = await createManagementStore(state, options);
    expect((await resumed.listProjectDeployments())[0]?.status).toBe("active");
    expect((await resumed.planProjectDeploy(input)).executable).toBe(false);
  });

  it("flags an interrupted deployment when its copied content changed", async () => {
    const workspace = await temporaryDirectory();
    const sourceRoot = join(workspace, "source");
    const source = join(sourceRoot, "writer");
    const projectPath = join(workspace, "project");
    const targetRoot = join(projectPath, ".agents", "skills");
    const state = join(workspace, "state");
    await writeSkill(source, "writer");
    await mkdir(projectPath);
    const options = { authorizedRoots: () => [sourceRoot, targetRoot] };
    const interrupted = await createManagementStoreWithRuntimeForTest(state, options, {
      afterProjectDeployRename: () => {
        throw new Error("synthetic interruption");
      },
    });
    const plan = await interrupted.planProjectDeploy({
      source,
      projectPath,
      targetRoot,
      targetClient: "codex",
    });
    expect((await interrupted.executeProjectPlan(plan.id)).status).toBe("failed");
    await writeFile(join(targetRoot, "writer", "SKILL.md"), "external edit");
    const resumed = await createManagementStore(state, options);
    expect((await resumed.listProjectDeployments())[0]).toMatchObject({
      status: "needs-review",
      reviewReason: expect.any(String),
    });
    expect(
      (
        await resumed.planProjectDeploy({
          source,
          projectPath,
          targetRoot,
          targetClient: "codex",
        })
      ).executable,
    ).toBe(false);
    expect(await readFile(join(targetRoot, "writer", "SKILL.md"), "utf8")).toBe("external edit");
  });

  it("rolls back a deployment interrupted before the target rename", async () => {
    const workspace = await temporaryDirectory();
    const sourceRoot = join(workspace, "source");
    const source = join(sourceRoot, "writer");
    const projectPath = join(workspace, "project");
    const targetRoot = join(projectPath, ".agents", "skills");
    const state = join(workspace, "state");
    await writeSkill(source, "writer");
    await mkdir(projectPath);
    const options = { authorizedRoots: () => [sourceRoot, targetRoot] };
    const interrupted = await createManagementStoreWithRuntimeForTest(state, options, {
      beforeProjectDeployRename: () => {
        throw new Error("synthetic interruption");
      },
    });
    const input = { source, projectPath, targetRoot, targetClient: "codex" as const };
    const plan = await interrupted.planProjectDeploy(input);
    expect((await interrupted.executeProjectPlan(plan.id)).status).toBe("failed");
    const resumed = await createManagementStore(state, options);
    expect(await resumed.listProjectDeployments()).toEqual([]);
    expect((await resumed.planProjectDeploy(input)).executable).toBe(true);
  });

  it("rolls back an unstarted revoke and completes a moved revoke after restart", async () => {
    const workspace = await temporaryDirectory();
    const sourceRoot = join(workspace, "source");
    const source = join(sourceRoot, "writer");
    const projectPath = join(workspace, "project");
    const targetRoot = join(projectPath, ".agents", "skills");
    const state = join(workspace, "state");
    await writeSkill(source, "writer");
    await mkdir(projectPath);
    const options = { authorizedRoots: () => [sourceRoot, targetRoot] };
    const setup = await createManagementStore(state, options);
    const deployment = await setup.planProjectDeploy({
      source,
      projectPath,
      targetRoot,
      targetClient: "codex",
    });
    expect((await setup.executeProjectPlan(deployment.id)).status).toBe("succeeded");
    const id = (await setup.listProjectDeployments())[0]?.id ?? "";
    const beforeMove = await createManagementStoreWithRuntimeForTest(state, options, {
      beforeProjectRevokeRename: () => {
        throw new Error("synthetic interruption");
      },
    });
    const first = await beforeMove.planProjectRevoke(id);
    expect((await beforeMove.executeProjectPlan(first.id)).status).toBe("failed");
    expect((await beforeMove.listProjectDeployments())[0]?.status).toBe("revoking");
    const rolledBack = await createManagementStore(state, options);
    expect((await rolledBack.listProjectDeployments())[0]?.status).toBe("active");
    const afterMove = await createManagementStoreWithRuntimeForTest(state, options, {
      afterProjectRevokeRename: () => {
        throw new Error("synthetic interruption");
      },
    });
    const second = await afterMove.planProjectRevoke(id);
    expect((await afterMove.executeProjectPlan(second.id)).status).toBe("failed");
    const resumed = await createManagementStore(state, options);
    const record = (await resumed.listProjectDeployments())[0];
    expect(record?.status).toBe("revoked");
    expect(record?.recoveryPath).toContain(join(targetRoot, ".koyori-recovery-"));
    await expect(stat(join(targetRoot, "writer"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps an externally edited moved recovery for manual review", async () => {
    const workspace = await temporaryDirectory();
    const sourceRoot = join(workspace, "source");
    const source = join(sourceRoot, "writer");
    const projectPath = join(workspace, "project");
    const targetRoot = join(projectPath, ".agents", "skills");
    const state = join(workspace, "state");
    await writeSkill(source, "writer");
    await mkdir(projectPath);
    const options = { authorizedRoots: () => [sourceRoot, targetRoot] };
    const setup = await createManagementStore(state, options);
    const deploy = await setup.planProjectDeploy({
      source,
      projectPath,
      targetRoot,
      targetClient: "codex",
    });
    expect((await setup.executeProjectPlan(deploy.id)).status).toBe("succeeded");
    const id = (await setup.listProjectDeployments())[0]?.id ?? "";
    const interrupted = await createManagementStoreWithRuntimeForTest(state, options, {
      afterProjectRevokeRename: () => {
        throw new Error("synthetic interruption");
      },
    });
    const revoke = await interrupted.planProjectRevoke(id);
    expect((await interrupted.executeProjectPlan(revoke.id)).status).toBe("failed");
    const recovery = (await interrupted.listProjectDeployments())[0]?.recoveryPath ?? "";
    await writeFile(join(recovery, "SKILL.md"), "external edit");
    const resumed = await createManagementStore(state, options);
    expect((await resumed.listProjectDeployments())[0]?.status).toBe("needs-review");
    expect(await readFile(join(recovery, "SKILL.md"), "utf8")).toBe("external edit");
  });

  it("refuses project takeover and preserves externally edited deployments", async () => {
    const workspace = await temporaryDirectory();
    const sourceRoot = join(workspace, "source");
    const source = join(sourceRoot, "writer");
    const projectPath = join(workspace, "project");
    const targetRoot = join(projectPath, ".claude", "skills");
    const target = join(targetRoot, "writer");
    await writeSkill(source, "writer");
    await writeSkill(target, "writer", "external\n");
    const store = await createManagementStore(join(workspace, "state"), {
      authorizedRoots: () => [sourceRoot, targetRoot],
    });
    const input = { source, projectPath, targetRoot, targetClient: "claude-code" as const };
    expect((await store.planProjectDeploy(input)).executable).toBe(false);
    await rm(target, { recursive: true });
    const plan = await store.planProjectDeploy(input);
    expect((await store.executeProjectPlan(plan.id)).status).toBe("succeeded");
    const deployment = (await store.listProjectDeployments())[0];
    await writeFile(join(target, "SKILL.md"), "external edit", "utf8");
    expect((await store.planProjectRevoke(deployment?.id ?? "")).executable).toBe(false);
    expect(await readFile(join(target, "SKILL.md"), "utf8")).toBe("external edit");
  });

  it("copies a complete Skill, preserves executable files, warns about compatibility, and skips identical content", async () => {
    const workspace = await temporaryDirectory();
    const claudeRoot = join(workspace, "claude");
    const codexRoot = join(workspace, "codex");
    const source = join(claudeRoot, "complete-skill");
    const target = join(codexRoot, "complete-skill");
    await writeSkill(
      source,
      "complete-skill",
      "# Use every bundled resource\n",
      "allowed-tools: Bash\n",
    );
    await mkdir(join(source, "scripts"));
    await mkdir(join(source, "assets"));
    await writeFile(join(source, "scripts", "run.sh"), "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(join(source, "scripts", "run.sh"), 0o755);
    await writeFile(join(source, "assets", "fixture.bin"), Buffer.from([0, 1, 2, 255]));
    await mkdir(codexRoot, { recursive: true });

    const store = await createManagementStore(join(workspace, "state"), {
      authorizedRoots: () => [claudeRoot, codexRoot],
    });
    const plan = await store.planSync({
      source,
      target,
      sourceClient: "claude-code",
      targetClient: "codex",
      allowReplace: false,
    });

    expect(plan.action).toBe("copy");
    expect(plan.source.manifest.entries).toContainEqual(
      expect.objectContaining({ path: "scripts/run.sh", kind: "file", mode: 0o755 }),
    );
    expect(plan.compatibilityWarnings).toContainEqual(
      expect.objectContaining({ field: "allowed-tools" }),
    );
    const operation = await store.execute(plan.id);
    expect(operation.status).toBe("succeeded");
    expect(await readFile(join(target, "assets", "fixture.bin"))).toEqual(
      Buffer.from([0, 1, 2, 255]),
    );
    expect((await stat(join(target, "scripts", "run.sh"))).mode & 0o777).toBe(0o755);

    const identical = await store.planSync({ source, target, allowReplace: false });
    expect(identical.action).toBe("skip");
    expect((await store.execute(identical.id)).items[0]?.status).toBe("skipped");
    await expect(store.execute(identical.id)).rejects.toMatchObject({ code: "plan-consumed" });
  });

  it("requires a fresh explicit replacement plan and creates an immutable write-before snapshot", async () => {
    const workspace = await temporaryDirectory();
    const sourceRoot = join(workspace, "source-root");
    const targetRoot = join(workspace, "target-root");
    const source = join(sourceRoot, "skill");
    const target = join(targetRoot, "skill");
    await writeSkill(source, "skill", "new\n");
    await writeSkill(target, "skill", "old\n");
    const store = await createManagementStore(join(workspace, "state"), {
      authorizedRoots: () => [sourceRoot, targetRoot],
    });

    const conflict = await store.planSync({ source, target, allowReplace: false });
    expect(conflict).toMatchObject({ action: "conflict", executable: false });
    await expect(store.execute(conflict.id)).rejects.toMatchObject({ code: "conflict" });

    const replacement = await store.planSync({ source, target, allowReplace: true });
    expect(replacement.action).toBe("replace");
    const operation = await store.execute(replacement.id);
    expect(operation).toMatchObject({ status: "succeeded" });
    expect(operation.items[0]?.backupSnapshotId).toBeTruthy();
    expect(await readFile(join(target, "SKILL.md"), "utf8")).toContain("new");
    expect(await store.listBackups()).toContainEqual(
      expect.objectContaining({
        id: operation.items[0]?.backupSnapshotId,
        reason: "write-before",
        entries: [expect.objectContaining({ name: "skill", originalPath: target })],
      }),
    );
  });

  it("restores an external edit made after final validation instead of reporting replacement success", async () => {
    const workspace = await temporaryDirectory();
    const sourceRoot = join(workspace, "source-root");
    const targetRoot = join(workspace, "target-root");
    const source = join(sourceRoot, "skill");
    const target = join(targetRoot, "skill");
    const externalContent =
      "---\nname: skill\ndescription: Edited outside Koyori\n---\nexternal edit\n";
    await writeSkill(source, "skill", "replacement\n");
    await writeSkill(target, "skill", "original\n");
    const store = await createManagementStoreWithRuntimeForTest(
      join(workspace, "state"),
      { authorizedRoots: () => [sourceRoot, targetRoot] },
      {
        async beforeDisplaceRename(path) {
          expect(path).toBe(target);
          await writeFile(join(path, "SKILL.md"), externalContent, "utf8");
        },
      },
    );
    const plan = await store.planSync({ source, target, allowReplace: true });

    const operation = await store.execute(plan.id);

    expect(operation.status).toBe("failed");
    expect(operation.error).toContain("restored");
    expect(operation.items[0]).toMatchObject({
      status: "failed",
      recoveryPath: target,
      recoveryState: "restored",
    });
    expect(await readFile(join(target, "SKILL.md"), "utf8")).toBe(externalContent);
    expect(await store.getOperation(operation.id)).toEqual(operation);
  });

  it("rejects changed sources and a target taken over by a link after planning", async () => {
    const workspace = await temporaryDirectory();
    const sourceRoot = join(workspace, "source-root");
    const targetRoot = join(workspace, "target-root");
    const outside = join(workspace, "outside");
    const source = join(sourceRoot, "skill");
    await writeSkill(source, "skill");
    await mkdir(targetRoot, { recursive: true });
    await writeSkill(outside, "outside");
    const store = await createManagementStore(join(workspace, "state"), {
      authorizedRoots: () => [sourceRoot, targetRoot],
    });

    const staleSourcePlan = await store.planSync({
      source,
      target: join(targetRoot, "stale-source"),
      allowReplace: false,
    });
    await writeFile(
      join(source, "SKILL.md"),
      "---\nname: changed\ndescription: changed\n---\n",
      "utf8",
    );
    const staleSourceResult = await store.execute(staleSourcePlan.id);
    expect(staleSourceResult).toMatchObject({ status: "failed" });
    expect(staleSourceResult.error).toContain("Source changed");

    const linkTarget = join(targetRoot, "taken-over");
    const linkPlan = await store.planSync({ source, target: linkTarget, allowReplace: false });
    await symlink(outside, linkTarget);
    const linkResult = await store.execute(linkPlan.id);
    expect(linkResult.status).toBe("failed");
    expect(linkResult.error).toMatch(/outside|symbolic link/i);
    expect((await stat(join(linkTarget, "SKILL.md"))).isFile()).toBe(true);
  });

  it("resolves authorized source links, materializes internal links, and rejects cross-root links", async () => {
    const workspace = await temporaryDirectory();
    const firstRoot = join(workspace, "first");
    const secondRoot = join(workspace, "second");
    const targetRoot = join(workspace, "target");
    const outside = join(workspace, "outside");
    const realSkill = join(secondRoot, "real-skill");
    await writeSkill(realSkill, "linked");
    await mkdir(join(secondRoot, "shared"), { recursive: true });
    await writeFile(join(secondRoot, "shared", "helper.txt"), "shared helper", "utf8");
    await symlink(join(secondRoot, "shared", "helper.txt"), join(realSkill, "helper.txt"));
    await mkdir(firstRoot, { recursive: true });
    await mkdir(targetRoot, { recursive: true });
    await symlink(realSkill, join(firstRoot, "linked-skill"));
    const store = await createManagementStore(join(workspace, "state"), {
      authorizedRoots: () => [firstRoot, secondRoot, targetRoot],
    });

    const plan = await store.planSync({
      source: join(firstRoot, "linked-skill"),
      target: join(targetRoot, "linked-skill"),
      allowReplace: false,
    });
    expect(plan.source.realPath).toBe(await realpath(realSkill));
    expect(plan.source.manifest.entries).toContainEqual(
      expect.objectContaining({ path: "helper.txt", sourceKind: "symlink" }),
    );
    expect((await store.execute(plan.id)).status).toBe("succeeded");
    expect(await readFile(join(targetRoot, "linked-skill", "helper.txt"), "utf8")).toBe(
      "shared helper",
    );

    await writeSkill(outside, "outside");
    await symlink(join(outside, "SKILL.md"), join(realSkill, "outside.md"));
    await expect(
      store.planSync({
        source: realSkill,
        target: join(targetRoot, "rejected"),
        allowReplace: false,
      }),
    ).rejects.toMatchObject({ code: "outside-authorized-roots" });
  });

  it("creates missing target roots and records a partially failed restore after external edits", async () => {
    const workspace = await temporaryDirectory();
    const sourceRoot = join(workspace, "sources");
    const targetRoot = join(workspace, "not-created-yet");
    const first = join(sourceRoot, "first");
    const second = join(sourceRoot, "second");
    await writeSkill(first, "first");
    await writeSkill(second, "second");
    const store = await createManagementStore(join(workspace, "state"), {
      authorizedRoots: () => [sourceRoot, targetRoot],
    });
    const snapshot = await store.createBackup([
      { id: "first", name: "first", path: first, client: "claude-code" },
      { id: "second", name: "second", path: second, client: "codex" },
    ]);
    const firstTarget = join(targetRoot, "first");
    const secondTarget = join(targetRoot, "second");
    const restore = await store.planRestore(
      snapshot.id,
      [
        { entryId: "first", target: firstTarget },
        { entryId: "second", target: secondTarget },
      ],
      { allowReplace: false },
    );
    await writeSkill(firstTarget, "external-edit");

    const operation = await store.execute(restore.id);
    expect(operation.status).toBe("partial");
    expect(operation.items.map((item) => item.status)).toEqual(["failed", "succeeded"]);
    expect(await readFile(join(firstTarget, "SKILL.md"), "utf8")).toContain("external-edit");
    expect(await readFile(join(secondTarget, "SKILL.md"), "utf8")).toContain("name: second");
    expect(await store.getOperation(operation.id)).toEqual(operation);
  });

  it("invalidates an existing plan when the host revokes a root", async () => {
    const workspace = await temporaryDirectory();
    const sourceRoot = join(workspace, "source");
    const targetRoot = join(workspace, "target");
    const source = join(sourceRoot, "skill");
    await writeSkill(source, "skill");
    await mkdir(targetRoot, { recursive: true });
    let roots = [sourceRoot, targetRoot];
    const store = await createManagementStore(join(workspace, "state"), {
      authorizedRoots: () => roots,
    });
    const plan = await store.planSync({
      source,
      target: join(targetRoot, "skill"),
      allowReplace: false,
    });
    roots = [targetRoot];

    const operation = await store.execute(plan.id);
    expect(operation.status).toBe("failed");
    expect(operation.error).toContain("outside the currently authorized roots");
  });

  it("exports a path-free portable backup, validates it on import, and preserves its directory name", async () => {
    const workspace = await temporaryDirectory();
    const sourceRoot = join(workspace, "source");
    const transferRoot = join(workspace, "transfer");
    const targetRoot = join(workspace, "target");
    const source = join(sourceRoot, "folder-name");
    await writeSkill(source, "frontmatter-name");
    await mkdir(transferRoot, { recursive: true });
    await mkdir(targetRoot, { recursive: true });
    const store = await createManagementStore(join(workspace, "state"), {
      authorizedRoots: () => [sourceRoot, transferRoot, targetRoot],
    });
    const local = await store.createBackup([
      { id: "portable", name: "frontmatter-name", path: source, client: "claude-code" },
    ]);
    const destination = join(transferRoot, "portable-backup");

    const exported = await store.exportBackup(local.id, destination);
    expect(exported.manifest.entries[0]).toMatchObject({
      id: "portable",
      name: "frontmatter-name",
      directoryName: "folder-name",
    });
    const serialized = await readFile(join(destination, "backup.json"), "utf8");
    expect(serialized).not.toContain(source);
    expect(serialized).not.toContain("originalPath");
    expect(serialized).not.toContain("realPath");

    const imported = await store.importBackup(destination);
    expect(imported).toMatchObject({
      reason: "import",
      entries: [
        expect.objectContaining({
          id: "portable",
          directoryName: "folder-name",
        }),
      ],
    });
    expect("originalPath" in (imported.entries[0] ?? {})).toBe(false);
    const restore = await store.planRestore(
      imported.id,
      [{ entryId: "portable", target: join(targetRoot, "folder-name") }],
      { allowReplace: false },
    );
    expect((await store.execute(restore.id)).status).toBe("succeeded");

    await writeFile(join(destination, "entries", "portable", "SKILL.md"), "tampered", "utf8");
    await expect(store.importBackup(destination)).rejects.toMatchObject({ code: "corrupt-data" });
  });

  it("recovers a dead-owner lock and marks a running journal as interrupted", async () => {
    const workspace = await temporaryDirectory();
    const state = join(workspace, "state");
    const managed = join(state, "managed-files");
    const operations = join(managed, "operations");
    const operationId = "10000000-0000-4000-8000-000000000000";
    await mkdir(operations, { recursive: true });
    await mkdir(join(managed, "backups"), { recursive: true });
    await writeFile(
      join(managed, "mutation.lock"),
      `${JSON.stringify({
        version: 1,
        pid: 2_147_483_647,
        token: "dead-owner",
        createdAt: "2026-01-01T00:00:00.000Z",
      })}\n`,
      "utf8",
    );
    await writeFile(
      join(operations, `${operationId}.json`),
      `${JSON.stringify({
        id: operationId,
        planId: "20000000-0000-4000-8000-000000000000",
        kind: "sync",
        status: "running",
        startedAt: "2026-01-01T00:00:00.000Z",
        items: [
          {
            id: "30000000-0000-4000-8000-000000000000",
            target: join(workspace, "target"),
            action: "copy",
            status: "pending",
          },
        ],
      })}\n`,
      "utf8",
    );

    const store = await createManagementStore(state, { authorizedRoots: () => [workspace] });
    expect(await store.getOperation(operationId)).toMatchObject({
      status: "interrupted",
      items: [expect.objectContaining({ status: "interrupted" })],
    });
  });

  it("rejects corrupt persistent snapshot metadata instead of silently skipping it", async () => {
    const workspace = await temporaryDirectory();
    const state = join(workspace, "state");
    const corruptId = "00000000-0000-4000-8000-000000000000";
    await mkdir(join(state, "managed-files", "backups", corruptId), { recursive: true });
    await writeFile(
      join(state, "managed-files", "backups", corruptId, "metadata.json"),
      "{not-json",
      "utf8",
    );
    const store = await createManagementStore(state, {
      authorizedRoots: () => [workspace],
    });

    await expect(store.listBackups()).rejects.toBeInstanceOf(ManagementError);
    await expect(store.listBackups()).rejects.toMatchObject({ code: "corrupt-data" });
  });
});
