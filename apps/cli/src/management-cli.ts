import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
  type ClientId,
  createManagementStore,
  discoverSources,
  type ManagementPlan,
  type ProjectDeploymentPlan,
} from "@koyori/core";

export const MANAGEMENT_HELP = `
  koyori discover [--home <path>] [--project <path> ...]
  koyori sync --source <skill-directory> --target <skill-directory> --from <client> --to <client> --root <authorized-directory> ... --store <path> [--replace] [--apply <revision>]
  koyori backup --source <skill-directory> ... --root <authorized-directory> ... --store <path>
  koyori backups --store <path>
  koyori restore --snapshot <id> --target <skills-directory> --root <authorized-directory> ... --store <path> [--replace] [--apply <revision>]
  koyori project-deploy --project <path> --source <skill-directory> --from <client> --to <client> --root <authorized-directory> ... --store <path> [--apply <revision>]
  koyori project-deployments --store <path>
  koyori project-revoke --project <path> --deployment <id> --root <authorized-directory> ... --store <path> [--apply <revision>]

sync/restore/project-deploy/project-revoke print a plan and revision first. Re-run with --apply <revision> to execute that
exact change; changed files invalidate the revision. backup writes a local snapshot only.
All paths are explicit; --root grants access only to the selected directory trees.
Project deployment never replaces an existing target. Revocation only moves an unchanged managed copy to recovery.`;

class ArgumentError extends Error {}
function parse(args: string[]) {
  const values = new Map<string, string[]>();
  const flags = new Set<string>();
  const command = args[0];
  const allowed: Record<string, string[]> = {
    discover: ["home", "project"],
    sync: ["source", "target", "from", "to", "root", "store", "apply", "replace"],
    backup: ["source", "root", "store"],
    backups: ["store"],
    restore: ["snapshot", "target", "root", "store", "apply", "replace"],
    "project-deploy": ["project", "source", "from", "to", "root", "store", "apply"],
    "project-deployments": ["store"],
    "project-revoke": ["project", "deployment", "root", "store", "apply"],
  };
  if (!command || !allowed[command]) throw new ArgumentError("Unknown management command.");
  for (let i = 1; i < args.length; i += 1) {
    const name = args[i]?.slice(2);
    if (!args[i]?.startsWith("--") || !name || !allowed[command]?.includes(name))
      throw new ArgumentError(`Unknown option: ${args[i]}`);
    if (name === "replace") {
      flags.add(name);
      continue;
    }
    const value = args[++i];
    if (!value || value.startsWith("--")) throw new ArgumentError(`--${name} requires a value.`);
    values.set(name, [...(values.get(name) ?? []), value]);
  }
  function one(name: string, required = true) {
    const entries = values.get(name) ?? [];
    if (entries.length > 1 || (required && entries.length !== 1))
      throw new ArgumentError(`Expected one --${name}.`);
    return entries[0] ?? "";
  }
  function many(name: string, required = true) {
    const entries = values.get(name) ?? [];
    if (required && entries.length === 0)
      throw new ArgumentError(`At least one --${name} is required.`);
    return entries;
  }
  function client(name: string): ClientId {
    const value = one(name);
    if (value !== "claude-code" && value !== "codex")
      throw new ArgumentError(`Unsupported --${name} client.`);
    return value;
  }
  return { command, one, many, client, replace: flags.has("replace") };
}

function revision(plan: ManagementPlan) {
  const { id: _id, createdAt: _createdAt, expiresAt: _expiresAt, ...content } = plan;
  // IDs inside restore items are generated per plan; file revisions remain in the digest.
  const stable =
    content.kind === "restore"
      ? { ...content, items: content.items.map(({ id: _itemId, ...item }) => item) }
      : content;
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

function projectRevision(
  plan: ProjectDeploymentPlan,
  store: string,
  roots: string[],
  input: Record<string, string>,
) {
  const { id: _id, expiresAt: _expiresAt, ...content } = plan;
  return createHash("sha256")
    .update(JSON.stringify({ store, roots, input, plan: content }))
    .digest("hex");
}

export async function runManagementCli(
  args: string[],
  io: { stdout: Pick<NodeJS.WriteStream, "write">; stderr: Pick<NodeJS.WriteStream, "write"> },
): Promise<number> {
  try {
    if (args.includes("--help")) {
      io.stdout.write(`${MANAGEMENT_HELP}\n`);
      return 0;
    }
    const options = parse(args);
    if (options.command === "discover") {
      const result = await discoverSources({
        home: resolve(options.one("home", false) || homedir()),
        codexHome: process.env.CODEX_HOME,
        claudeConfigDir: process.env.CLAUDE_CONFIG_DIR,
        projects: options.many("project", false).map((path) => resolve(path)),
      });
      io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return result.issues.some((issue) => issue.severity === "error") ? 1 : 0;
    }
    const roots =
      options.command === "backups" || options.command === "project-deployments"
        ? []
        : options.many("root").map((path) => resolve(path));
    const storePath = resolve(options.one("store"));
    const store = await createManagementStore(storePath, {
      authorizedRoots: () => roots,
    });
    if (options.command === "backups") {
      io.stdout.write(`${JSON.stringify(await store.listBackups(), null, 2)}\n`);
      return 0;
    }
    if (options.command === "backup") {
      const result = await store.createBackup(
        options
          .many("source")
          .map((path) => ({ path: resolve(path), name: basename(resolve(path)) })),
      );
      io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return 0;
    }
    if (options.command === "project-deployments") {
      io.stdout.write(`${JSON.stringify(await store.listProjectDeployments(), null, 2)}\n`);
      return 0;
    }
    if (options.command === "project-deploy" || options.command === "project-revoke") {
      const projectPath = resolve(options.one("project"));
      let plan: ProjectDeploymentPlan;
      let input: Record<string, string>;
      if (options.command === "project-deploy") {
        const source = resolve(options.one("source"));
        const sourceClient = options.client("from");
        const targetClient = options.client("to");
        input = { projectPath, source, sourceClient, targetClient };
        plan = await store.planProjectDeploy({
          projectPath,
          source,
          sourceClient,
          targetClient,
          targetRoot: join(
            projectPath,
            targetClient === "claude-code" ? ".claude" : ".agents",
            "skills",
          ),
        });
      } else {
        const deploymentId = options.one("deployment");
        input = { projectPath, deploymentId };
        const deployment = (await store.listProjectDeployments()).find(
          (item) => item.id === deploymentId,
        );
        if (!deployment) throw new ArgumentError("Project deployment not found.");
        if (deployment.projectPath !== projectPath)
          throw new ArgumentError("Deployment does not belong to the selected project.");
        plan = await store.planProjectRevoke(deploymentId);
      }
      const current = projectRevision(plan, storePath, roots, input);
      const approved = options.one("apply", false);
      if (!approved) {
        io.stdout.write(`${JSON.stringify({ revision: current, plan }, null, 2)}\n`);
        return plan.executable ? 0 : 1;
      }
      if (approved !== current)
        throw new ArgumentError(
          "Files or options changed since preview. Generate and review a new plan.",
        );
      if (!plan.executable) {
        io.stdout.write(`${JSON.stringify({ revision: current, plan }, null, 2)}\n`);
        return 1;
      }
      const operation = await store.executeProjectPlan(plan.id);
      const deployment =
        operation.status === "succeeded"
          ? (await store.listProjectDeployments()).find((item) =>
              plan.kind === "project-deploy"
                ? item.status === "active" && item.targetPath === plan.targetPath
                : item.id === plan.deploymentId,
            )
          : undefined;
      io.stdout.write(
        `${JSON.stringify({ operation, deployment: deployment ?? null }, null, 2)}\n`,
      );
      return operation.status === "succeeded" ? 0 : 1;
    }
    let plan: ManagementPlan;
    if (options.command === "sync") {
      plan = await store.planSync({
        source: resolve(options.one("source")),
        target: resolve(options.one("target")),
        sourceClient: options.client("from"),
        targetClient: options.client("to"),
        allowReplace: options.replace,
      });
    } else {
      const snapshot = (await store.listBackups()).find(
        (item) => item.id === options.one("snapshot"),
      );
      if (!snapshot) throw new ArgumentError("Snapshot not found.");
      const target = resolve(options.one("target"));
      plan = await store.planRestore(
        snapshot.id,
        snapshot.entries.map((entry) => ({
          entryId: entry.id,
          target: join(target, entry.directoryName),
        })),
        { allowReplace: options.replace },
      );
    }
    const current = revision(plan);
    const approved = options.one("apply", false);
    if (!approved) {
      io.stdout.write(`${JSON.stringify({ revision: current, plan }, null, 2)}\n`);
      return plan.executable ? 0 : 1;
    }
    if (approved !== current)
      throw new ArgumentError(
        "Files or options changed since preview. Generate and review a new plan.",
      );
    if (!plan.executable)
      throw new ArgumentError("Plan has conflicts; review a new plan before applying.");
    const result = await store.execute(plan.id);
    io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.status === "succeeded" ? 0 : 1;
  } catch (error) {
    io.stderr.write(
      `${JSON.stringify({ error: error instanceof Error ? error.message : "Operation failed" })}\n`,
    );
    return error instanceof ArgumentError ? 2 : 1;
  }
}
