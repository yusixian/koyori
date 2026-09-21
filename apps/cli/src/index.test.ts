import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "koyori-cli-test-"));
  temporaryDirectories.push(path);
  return path;
}

async function writeSkill(
  root: string,
  directory: string,
  name: string,
  body = "# Private instructions must not be printed\n",
): Promise<string> {
  const skillDirectory = join(root, directory);
  await mkdir(skillDirectory, { recursive: true });
  const path = join(skillDirectory, "SKILL.md");
  await writeFile(
    path,
    `---\nname: ${name}\ndescription: Synthetic CLI fixture\n---\n${body}`,
    "utf8",
  );
  return path;
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
    const workspace = await temporaryDirectory();
    await writeSkill(workspace, "demo", "demo", "# Demo\n");
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
    const workspace = await temporaryDirectory();
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

  it("builds a deduplicated usage report without changing or exposing selected files", async () => {
    const workspace = await temporaryDirectory();
    const skillsRoot = join(workspace, "skills");
    const historyRoot = join(workspace, "history");
    await mkdir(historyRoot, { recursive: true });
    const skillPath = await writeSkill(skillsRoot, "sample", "sample-skill");
    const privateResult = "PRIVATE_TRANSCRIPT_BODY";
    const timestamp = new Date().toISOString();
    const historyPath = join(historyRoot, "session.jsonl");
    const records = [
      {
        type: "assistant",
        uuid: "assistant-row",
        sessionId: "session-a",
        timestamp,
        version: "2.1.278",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tool-use-1",
              name: "Skill",
              input: { skill: "sample-skill", args: "private args" },
            },
          ],
        },
      },
      {
        type: "user",
        uuid: "result-row",
        sessionId: "session-a",
        timestamp,
        version: "2.1.278",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-use-1",
              content: privateResult,
            },
          ],
        },
      },
    ];
    await writeFile(historyPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
    const skillBefore = await readFile(skillPath, "utf8");
    const historyBefore = await readFile(historyPath, "utf8");
    const stdout = capture();
    const stderr = capture();

    const exitCode = await runCli(
      [
        "usage",
        "--client",
        "claude-code",
        "--root",
        skillsRoot,
        "--history",
        historyRoot,
        "--history",
        historyRoot,
        "--days",
        "30",
      ],
      { stdout: stdout.stream, stderr: stderr.stream },
    );

    expect(exitCode).toBe(0);
    expect(stderr.read()).toBe("");
    const output = JSON.parse(stdout.read());
    expect(output).toMatchObject({
      command: "usage",
      resources: [expect.objectContaining({ name: "sample-skill", client: "claude-code" })],
      coverage: [
        expect.objectContaining({ status: "supported" }),
        expect.objectContaining({ status: "supported" }),
      ],
      report: {
        windowDays: 30,
        totalEvents: 1,
        skills: [
          expect.objectContaining({
            status: "observed",
            calls: 1,
            loaded: 1,
            requests: 0,
            sessions: 1,
          }),
        ],
      },
    });
    expect(stdout.read()).not.toContain(privateResult);
    expect(stdout.read()).not.toContain("Private instructions must not be printed");
    await expect(readFile(skillPath, "utf8")).resolves.toBe(skillBefore);
    await expect(readFile(historyPath, "utf8")).resolves.toBe(historyBefore);
  });

  it("reports identical current files through suggest without bypassing first-seen grace", async () => {
    const workspace = await temporaryDirectory();
    const skillsRoot = join(workspace, "skills");
    const historyRoot = join(workspace, "history");
    await mkdir(historyRoot, { recursive: true });
    const duplicate =
      "---\nname: duplicate\ndescription: Duplicate fixture\n---\n# Same complete content\n";
    await mkdir(join(skillsRoot, "a"), { recursive: true });
    await mkdir(join(skillsRoot, "b"), { recursive: true });
    await writeFile(join(skillsRoot, "a", "SKILL.md"), duplicate);
    await writeFile(join(skillsRoot, "b", "SKILL.md"), duplicate);
    const stdout = capture();
    const stderr = capture();

    const exitCode = await runCli(
      ["suggest", "--client", "claude-code", "--root", skillsRoot, "--history", historyRoot],
      { stdout: stdout.stream, stderr: stderr.stream },
    );

    expect(exitCode).toBe(0);
    const output = JSON.parse(stdout.read());
    expect(output.command).toBe("suggest");
    expect(output.report.windowDays).toBe(90);
    expect(output.report.suggestions).toEqual([
      expect.objectContaining({ kind: "identical-content" }),
    ]);
    expect(
      output.report.suggestions.some(
        (entry: { kind: string }) => entry.kind === "idle-review" || entry.kind === "low-use",
      ),
    ).toBe(false);
  });

  it("returns one with unknown usage when the selected history client is unsupported", async () => {
    const workspace = await temporaryDirectory();
    const skillsRoot = join(workspace, "skills");
    const historyRoot = join(workspace, "history");
    await mkdir(historyRoot, { recursive: true });
    await writeSkill(skillsRoot, "sample", "sample-skill");
    const stdout = capture();
    const stderr = capture();

    const exitCode = await runCli(
      ["usage", "--client", "codex", "--root", skillsRoot, "--history", historyRoot],
      { stdout: stdout.stream, stderr: stderr.stream },
    );

    expect(exitCode).toBe(1);
    expect(stderr.read()).toBe("");
    expect(JSON.parse(stdout.read())).toMatchObject({
      coverage: [expect.objectContaining({ status: "unsupported" })],
      report: { skills: [expect.objectContaining({ status: "unknown", calls: 0 })] },
    });
  });

  it("returns one with structured coverage when a history directory cannot be read", async () => {
    const workspace = await temporaryDirectory();
    const skillsRoot = join(workspace, "skills");
    await writeSkill(skillsRoot, "sample", "sample-skill");
    const stdout = capture();
    const stderr = capture();

    const exitCode = await runCli(
      [
        "usage",
        "--client",
        "claude-code",
        "--root",
        skillsRoot,
        "--history",
        join(workspace, "missing-history"),
      ],
      { stdout: stdout.stream, stderr: stderr.stream },
    );

    expect(exitCode).toBe(1);
    expect(stderr.read()).toBe("");
    expect(JSON.parse(stdout.read())).toMatchObject({
      coverage: [expect.objectContaining({ status: "unreadable" })],
      issues: [expect.objectContaining({ code: "unreadable" })],
      report: { skills: [expect.objectContaining({ status: "unknown", calls: 0 })] },
    });
  });

  it("rejects invalid report parameters with exit code two", async () => {
    const stdout = capture();
    const stderr = capture();

    const exitCode = await runCli(
      [
        "usage",
        "--client",
        "claude-code",
        "--root",
        "/one",
        "--root",
        "/two",
        "--history",
        "/history",
        "--days",
        "7",
      ],
      { stdout: stdout.stream, stderr: stderr.stream },
    );

    expect(exitCode).toBe(2);
    expect(stdout.read()).toBe("");
    expect(stderr.read()).toContain("Unsupported day window: 7");
  });

  it("binds report commands to exactly one resource root", async () => {
    const stdout = capture();
    const stderr = capture();

    const exitCode = await runCli(
      [
        "usage",
        "--client",
        "claude-code",
        "--root",
        "/one",
        "--root",
        "/two",
        "--history",
        "/history",
      ],
      { stdout: stdout.stream, stderr: stderr.stream },
    );

    expect(exitCode).toBe(2);
    expect(stdout.read()).toBe("");
    expect(stderr.read()).toContain("exactly one --root");
  });
});
