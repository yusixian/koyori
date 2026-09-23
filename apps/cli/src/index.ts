import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildUsageReport,
  type ClientId,
  createUsageState,
  type HistorySource,
  importUsage,
  mergeUsageImport,
  observeSkills,
  type ResourceRoot,
  scanSkills,
} from "@koyori/core";

import { MANAGEMENT_HELP, runManagementCli } from "./management-cli";

const HELP = `Usage:
  koyori scan --client <claude-code|codex> --root <path> [--root <path> ...]
  koyori usage --client <claude-code|codex> --root <path> --history <path> [--history <path> ...] [--days <30|90>]
  koyori suggest --client <claude-code|codex> --root <path> --history <path> [--history <path> ...] [--days <30|90>]
  koyori --help

${MANAGEMENT_HELP}

scan, usage and suggest are read-only. usage and suggest build a temporary in-memory ledger from the
selected Skill root and history directories; coverage may still be incomplete.`;

interface ParsedScanArgs {
  command: "scan";
  client: ClientId;
  roots: string[];
}

interface ParsedHelpArgs {
  command: "help";
}

interface ParsedReportArgs {
  command: "usage" | "suggest";
  client: ClientId;
  root: string;
  histories: string[];
  days: 30 | 90;
}

type ParsedArgs = ParsedScanArgs | ParsedReportArgs | ParsedHelpArgs;

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
  const command = args[0];
  if (command !== "scan" && command !== "usage" && command !== "suggest") {
    throw new UsageError(`Unknown command: ${args[0]}`);
  }

  let client: ClientId | undefined;
  const roots: string[] = [];
  const histories: string[] = [];
  let days: 30 | 90 = 90;
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
    if (option === "--history") {
      if (command === "scan") {
        throw new UsageError("scan does not accept --history.");
      }
      const value = requireValue(args, index, option);
      histories.push(resolve(value));
      index += 1;
      continue;
    }
    if (option === "--days") {
      if (command === "scan") {
        throw new UsageError("scan does not accept --days.");
      }
      const value = requireValue(args, index, option);
      if (value !== "30" && value !== "90") {
        throw new UsageError(`Unsupported day window: ${value}`);
      }
      days = value === "30" ? 30 : 90;
      index += 1;
      continue;
    }
    throw new UsageError(`Unknown option: ${option}`);
  }

  if (!client) {
    throw new UsageError(`${command} requires --client.`);
  }
  if (roots.length === 0) {
    throw new UsageError(`${command} requires at least one --root.`);
  }

  if (command === "scan") return { command, client, roots };
  if (roots.length !== 1) {
    throw new UsageError(`${command} requires exactly one --root.`);
  }
  if (histories.length === 0) {
    throw new UsageError(`${command} requires at least one --history.`);
  }
  const root = roots[0];
  if (!root) throw new UsageError(`${command} requires exactly one --root.`);
  return { command, client, root, histories, days };
}

export async function runCli(
  args: string[],
  io: { stdout: Pick<NodeJS.WriteStream, "write">; stderr: Pick<NodeJS.WriteStream, "write"> } = {
    stdout: process.stdout,
    stderr: process.stderr,
  },
): Promise<number> {
  if (
    [
      "discover",
      "sync",
      "backup",
      "backups",
      "restore",
      "project-deploy",
      "project-deployments",
      "project-revoke",
    ].includes(args[0] ?? "")
  )
    return runManagementCli(args, io);
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

  if (parsed.command === "scan") {
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

  const now = new Date().toISOString();
  const root: ResourceRoot = {
    id: "cli-root",
    client: parsed.client,
    path: parsed.root,
    label: parsed.root,
  };
  const sources: HistorySource[] = parsed.histories.map((path, index) => ({
    id: `cli-history-${index + 1}`,
    rootId: root.id,
    client: parsed.client,
    path,
    label: path,
    enabled: true,
  }));
  const inventory = await scanSkills([root]);
  const imported = await importUsage(sources, { now });
  let state = { ...createUsageState(), sources };
  state = observeSkills(state, inventory, now);
  state = mergeUsageImport(state, imported, now);
  const report = buildUsageReport(inventory, state, { now, windowDays: parsed.days });
  io.stdout.write(
    `${JSON.stringify(
      {
        command: parsed.command,
        resources: inventory.skills.map(({ id, name, client, rootId, path }) => ({
          id,
          name,
          client,
          rootId,
          path,
        })),
        scanIssues: inventory.issues,
        coverage: state.coverage,
        issues: state.issues,
        report,
      },
      null,
      2,
    )}\n`,
  );

  const scanFailed = inventory.issues.some((entry) => entry.severity === "error");
  const historyFailed = state.coverage.some(
    (entry) => entry.status === "unreadable" || entry.status === "unsupported",
  );
  return scanFailed || historyFailed ? 1 : 0;
}

async function main(): Promise<void> {
  process.exitCode = await runCli(process.argv.slice(2));
}

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  await main();
}
