import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "./index.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function capture(): { stream: Pick<NodeJS.WriteStream, "write">; read: () => string } {
  let value = "";
  return {
    stream: {
      write(chunk: string | Uint8Array): boolean {
        value += chunk.toString();
        return true;
      },
    },
    read: () => value,
  };
}

describe("runCli", () => {
  it("prints help without scanning", async () => {
    const stdout = capture();
    const stderr = capture();

    const exitCode = await runCli(["--help"], { stdout: stdout.stream, stderr: stderr.stream });

    expect(exitCode).toBe(0);
    expect(stdout.read()).toContain("koyori scan --client");
    expect(stderr.read()).toBe("");
  });

  it("rejects an empty root list", async () => {
    const stdout = capture();
    const stderr = capture();

    const exitCode = await runCli(["scan", "--client", "codex"], {
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    expect(exitCode).toBe(2);
    expect(stdout.read()).toBe("");
    expect(stderr.read()).toContain("at least one --root");
  });

  it("prints JSON from the shared scanner", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "koyori-cli-test-"));
    temporaryDirectories.push(workspace);
    const skillDirectory = join(workspace, "demo");
    await mkdir(skillDirectory);
    await writeFile(
      join(skillDirectory, "SKILL.md"),
      "---\nname: demo\ndescription: Synthetic CLI fixture\n---\n# Demo\n",
      "utf8",
    );
    const stdout = capture();
    const stderr = capture();

    const exitCode = await runCli(["scan", "--client", "claude-code", "--root", workspace], {
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    expect(exitCode).toBe(0);
    expect(stderr.read()).toBe("");
    expect(JSON.parse(stdout.read())).toEqual(
      expect.objectContaining({
        skills: [expect.objectContaining({ name: "demo", client: "claude-code" })],
        issues: [],
      }),
    );
  });

  it("returns a business error with structured JSON for a missing root", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "koyori-cli-test-"));
    temporaryDirectories.push(workspace);
    const stdout = capture();
    const stderr = capture();

    const exitCode = await runCli(
      ["scan", "--client", "codex", "--root", join(workspace, "missing")],
      { stdout: stdout.stream, stderr: stderr.stream },
    );

    expect(exitCode).toBe(1);
    expect(stderr.read()).toBe("");
    expect(JSON.parse(stdout.read()).issues).toEqual([
      expect.objectContaining({ code: "missing", severity: "error" }),
    ]);
  });
});
