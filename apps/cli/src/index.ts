import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { type ClientId, type ResourceRoot, scanSkills } from "@koyori/core";

const HELP = `Usage:
  koyori scan --client <claude-code|codex> --root <path> [--root <path> ...]
  koyori --help

Scans user-selected roots for SKILL.md files and prints a JSON inventory.
The scan is read-only and does not infer usage statistics.`;

interface ParsedScanArgs {
  command: "scan";
  client: ClientId;
  roots: string[];
}

interface ParsedHelpArgs {
  command: "help";
}

type ParsedArgs = ParsedScanArgs | ParsedHelpArgs;

class UsageError extends Error {}

function requireValue(args: string[], index: number, option: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new UsageError(`${option} requires a value.`);
  }
  return value;
}

function parseArgs(args: string[]): ParsedArgs {
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    return { command: "help" };
  }
  if (args[0] !== "scan") {
    throw new UsageError(`Unknown command: ${args[0]}`);
  }

  let client: ClientId | undefined;
  const roots: string[] = [];
  for (let index = 1; index < args.length; index += 1) {
    const option = args[index];
    if (option === "--help" || option === "-h") {
      return { command: "help" };
    }
    if (option === "--client") {
      const value = requireValue(args, index, option);
      if (value !== "claude-code" && value !== "codex") {
        throw new UsageError(`Unsupported client: ${value}`);
      }
      client = value;
      index += 1;
      continue;
    }
    if (option === "--root") {
      const value = requireValue(args, index, option);
      roots.push(resolve(value));
      index += 1;
      continue;
    }
    throw new UsageError(`Unknown option: ${option}`);
  }

  if (!client) {
    throw new UsageError("scan requires --client.");
  }
  if (roots.length === 0) {
    throw new UsageError("scan requires at least one --root.");
  }

  return { command: "scan", client, roots };
}

export async function runCli(
  args: string[],
  io: { stdout: Pick<NodeJS.WriteStream, "write">; stderr: Pick<NodeJS.WriteStream, "write"> } = {
    stdout: process.stdout,
    stderr: process.stderr,
  },
): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.stderr.write(`${message}\n\n${HELP}\n`);
    return 2;
  }

  if (parsed.command === "help") {
    io.stdout.write(`${HELP}\n`);
    return 0;
  }

  const roots: ResourceRoot[] = parsed.roots.map((path, index) => ({
    id: `cli-root-${index + 1}`,
    client: parsed.client,
    path,
    label: path,
  }));
  const inventory = await scanSkills(roots);
  io.stdout.write(`${JSON.stringify(inventory, null, 2)}\n`);
  return inventory.issues.some((entry) => entry.severity === "error") ? 1 : 0;
}

async function main(): Promise<void> {
  process.exitCode = await runCli(process.argv.slice(2));
}

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  await main();
}
