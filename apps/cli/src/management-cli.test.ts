import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { runCli } from "./index";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function run(args: string[]) {
  let stdout = "",
    stderr = "";
  const code = await runCli(args, {
    stdout: {
      write: (value) => {
        stdout += value;
        return true;
      },
    },
    stderr: {
      write: (value) => {
        stderr += value;
        return true;
      },
    },
  });
  return { code, stdout, stderr };
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "koyori-cli-managed-"));
  temporary.push(directory);
  const source = join(directory, "source", "writer"),
    target = join(directory, "target", "writer");
  await mkdir(source, { recursive: true });
  await writeFile(
    join(source, "SKILL.md"),
    "---\nname: writer\ndescription: Fixture\n---\nversion one",
  );
  const args = [
    "sync",
    "--source",
    source,
    "--target",
    target,
    "--from",
    "claude-code",
    "--to",
    "codex",
    "--root",
    directory,
    "--store",
    join(directory, "state"),
  ];
  return { source, target, args };
}
async function projectFixture() {
  const directory = await mkdtemp(join(tmpdir(), "koyori-cli-project-"));
  temporary.push(directory);
  const sourceRoot = join(directory, "source");
  const source = join(sourceRoot, "writer");
  const project = join(directory, "project");
  const targetRoot = join(project, ".agents", "skills");
  const target = join(targetRoot, "writer");
  const store = join(directory, "state");
  await mkdir(source, { recursive: true });
  await mkdir(project);
  await writeFile(join(source, "SKILL.md"), "---\nname: writer\ndescription: Synthetic\n---\n");
  await writeFile(join(source, "asset.txt"), "synthetic asset");
  const roots = ["--root", sourceRoot, "--root", targetRoot];
  const deploy = [
    "project-deploy",
    "--project",
    project,
    "--source",
    source,
    "--from",
    "claude-code",
    "--to",
    "codex",
    ...roots,
    "--store",
    store,
  ];
  const revoke = (id: string) => [
    "project-revoke",
    "--project",
    project,
    "--deployment",
    id,
    "--root",
    targetRoot,
    "--store",
    store,
  ];
  return { directory, source, project, target, targetRoot, store, deploy, revoke };
}
function revision(output: string): string {
  const data: unknown = JSON.parse(output);
  if (
    !data ||
    typeof data !== "object" ||
    !("revision" in data) ||
    typeof data.revision !== "string"
  )
    throw new Error("Missing revision");
  return data.revision;
}

it("requires the reviewed revision and copies the exact previewed change", async () => {
  const setup = await fixture();
  const planned = await run(setup.args);
  expect(planned.code).toBe(0);
  await expect(readFile(join(setup.target, "SKILL.md"))).rejects.toMatchObject({ code: "ENOENT" });
  const applied = await run([...setup.args, "--apply", revision(planned.stdout)]);
  expect(applied.stderr).toBe("");
  expect(applied.code).toBe(0);
  expect(await readFile(join(setup.target, "SKILL.md"), "utf8")).toContain("version one");
});

it("refuses a changed source even when passed an earlier review token", async () => {
  const setup = await fixture();
  const planned = await run(setup.args);
  await writeFile(join(setup.source, "SKILL.md"), "version two");
  const applied = await run([...setup.args, "--apply", revision(planned.stdout)]);
  expect(applied.code).toBe(2);
  expect(applied.stderr).toContain("changed since preview");
  await expect(readFile(join(setup.target, "SKILL.md"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("rejects flags outside each command instead of silently granting scope", async () => {
  expect((await run(["backups", "--source", "/unrelated"])).code).toBe(2);
  expect((await run(["sync", "--source", "/missing"])).code).toBe(2);
});

it("deploys one project Skill only after a stable cross-invocation review", async () => {
  const setup = await projectFixture();
  const preview = await run(setup.deploy);
  expect(preview.code).toBe(0);
  expect(JSON.parse(preview.stdout)).toMatchObject({
    plan: { kind: "project-deploy", executable: true, targetPath: setup.target },
  });
  expect(revision((await run(setup.deploy)).stdout)).toBe(revision(preview.stdout));
  await expect(readFile(join(setup.target, "SKILL.md"))).rejects.toMatchObject({ code: "ENOENT" });

  const applied = await run([...setup.deploy, "--apply", revision(preview.stdout)]);
  expect(applied.code).toBe(0);
  expect(applied.stderr).toBe("");
  expect(JSON.parse(applied.stdout)).toMatchObject({
    operation: { kind: "project-deploy", status: "succeeded" },
    deployment: { status: "active", projectPath: setup.project, targetPath: setup.target },
  });
  expect(await readFile(join(setup.target, "asset.txt"), "utf8")).toBe("synthetic asset");
  expect(JSON.parse((await run(["project-deployments", "--store", setup.store])).stdout)).toEqual([
    expect.objectContaining({ status: "active", targetPath: setup.target }),
  ]);
});

it("rejects changed deploy inputs and never takes over an existing target", async () => {
  const setup = await projectFixture();
  const preview = await run(setup.deploy);
  const differentClient = [...setup.deploy];
  differentClient[differentClient.indexOf("--from") + 1] = "codex";
  const changedOption = await run([...differentClient, "--apply", revision(preview.stdout)]);
  expect(changedOption.code).toBe(2);
  await writeFile(join(setup.source, "asset.txt"), "changed asset");
  const changed = await run([...setup.deploy, "--apply", revision(preview.stdout)]);
  expect(changed.code).toBe(2);
  expect(JSON.parse(changed.stderr).error).toContain("changed since preview");
  await expect(readFile(join(setup.target, "SKILL.md"))).rejects.toMatchObject({ code: "ENOENT" });

  await mkdir(setup.target, { recursive: true });
  await writeFile(join(setup.target, "SKILL.md"), "external target");
  const conflict = await run(setup.deploy);
  expect(conflict.code).toBe(1);
  expect(JSON.parse(conflict.stdout).plan).toMatchObject({ executable: false });
  const attempted = await run([...setup.deploy, "--apply", revision(conflict.stdout)]);
  expect(attempted.code).toBe(1);
  expect(await readFile(join(setup.target, "SKILL.md"), "utf8")).toBe("external target");
});

it("revokes only the matching unchanged managed project copy and retains recovery", async () => {
  const setup = await projectFixture();
  const deploy = await run(setup.deploy);
  const applied = await run([...setup.deploy, "--apply", revision(deploy.stdout)]);
  const id: string = JSON.parse(applied.stdout).deployment.id;
  const revoke = setup.revoke(id);
  const preview = await run(revoke);
  expect(preview.code).toBe(0);
  expect(JSON.parse(preview.stdout).plan).toMatchObject({
    kind: "project-revoke",
    executable: true,
  });
  expect(revision((await run(revoke)).stdout)).toBe(revision(preview.stdout));
  const result = await run([...revoke, "--apply", revision(preview.stdout)]);
  expect(result.code).toBe(0);
  const output = JSON.parse(result.stdout);
  expect(output).toMatchObject({
    operation: { kind: "project-revoke", status: "succeeded" },
    deployment: { id, status: "revoked" },
  });
  expect(await readFile(join(output.deployment.recoveryPath, "asset.txt"), "utf8")).toBe(
    "synthetic asset",
  );
  await expect(readFile(join(setup.target, "SKILL.md"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(join(setup.source, "asset.txt"), "utf8")).toBe("synthetic asset");
});

it("rejects an edited copy, mismatched project, and stale revoke revision", async () => {
  const setup = await projectFixture();
  const deploy = await run(setup.deploy);
  const applied = await run([...setup.deploy, "--apply", revision(deploy.stdout)]);
  const id: string = JSON.parse(applied.stdout).deployment.id;
  const revoke = setup.revoke(id);
  const preview = await run(revoke);
  const wrongProject = await run([
    ...revoke.slice(0, 2),
    join(setup.directory, "other"),
    ...revoke.slice(3),
  ]);
  expect(wrongProject.code).toBe(2);
  await writeFile(join(setup.target, "asset.txt"), "external edit");
  const stale = await run([...revoke, "--apply", revision(preview.stdout)]);
  expect(stale.code).toBe(2);
  const conflict = await run(revoke);
  expect(conflict.code).toBe(1);
  expect(JSON.parse(conflict.stdout).plan).toMatchObject({ executable: false });
  expect(await readFile(join(setup.target, "asset.txt"), "utf8")).toBe("external edit");
});

it("requires explicit project, clients, roots and store for deployment", async () => {
  const setup = await projectFixture();
  for (const option of ["--project", "--source", "--from", "--to", "--store"]) {
    const index = setup.deploy.indexOf(option);
    const result = await run(
      setup.deploy.filter((_, position) => position !== index && position !== index + 1),
    );
    expect(result.code).toBe(2);
  }
  const withoutRoots = setup.deploy.filter(
    (item, index, args) => item !== "--root" && args[index - 1] !== "--root",
  );
  expect((await run(withoutRoots)).code).toBe(2);
  expect((await run([...setup.deploy, "--replace"])).code).toBe(2);
});
