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
