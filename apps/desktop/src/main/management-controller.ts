import { randomUUID } from "node:crypto";
import { basename, dirname, join, relative, sep } from "node:path";
import type { OperationRecord, ResourceRoot, SkillInventory, SkillRecord } from "@koyori/core";
import { ipcMain } from "electron";
import { createManagementStore } from "../../../../packages/core/src/managed-files";
import type {
  ManagementPlan,
  ProjectDeploymentPlan,
} from "../../../../packages/core/src/management-types";
import type { ManagementPlanPreview, ManagementView, SourceTarget } from "../bridge";

interface Dependencies {
  dataDirectory: string;
  transferRoots?: string[];
  getRoots(): ResourceRoot[];
  getTargets(): SourceTarget[];
  getProjects?(): string[];
  getInventory(): SkillInventory | null;
  resourceBusy(): boolean;
  trusted(event: Electron.IpcMainInvokeEvent): void;
  changed(): void;
  refresh(): Promise<unknown>;
}

function isWithin(path: string, root: string) {
  const value = relative(root, path);
  return value !== ".." && !value.startsWith(`..${sep}`) && !value.startsWith(sep);
}

export async function createManagementController(deps: Dependencies) {
  const store = await createManagementStore(deps.dataDirectory, {
    authorizedRoots: () => [
      ...deps.getRoots().map((root) => root.path),
      ...deps.getTargets().map((root) => root.path),
      ...(deps.transferRoots ?? []),
    ],
  });
  const plans = new Map<
    string,
    {
      plans: (ManagementPlan | ProjectDeploymentPlan)[];
      rootIds: string[];
      targetIds: string[];
      preview: ManagementPlanPreview;
    }
  >();
  let busy = false;
  let controller: AbortController | undefined;
  let lastResult: string | null = null;

  async function view(): Promise<ManagementView> {
    const [backups, operations, projectDeployments] = await Promise.all([
      store.listBackups(),
      store.listOperations(),
      store.listProjectDeployments(),
    ]);
    return {
      busy,
      lastResult,
      backups: backups.map((backup) => ({
        id: backup.id,
        createdAt: backup.createdAt,
        reason: backup.reason,
        canRestoreOriginal: backup.entries.every((entry) => Boolean(entry.originalPath)),
        entries: backup.entries.map((entry) => ({
          name: entry.name,
          client: entry.client,
          path: entry.originalPath ?? "远端快照 · 请指定恢复目标",
          files: entry.files,
          bytes: entry.bytes,
        })),
      })),
      operations: operations.slice(0, 20),
      projectDeployments,
    };
  }
  function selected(value: unknown): SkillRecord[] {
    if (
      !Array.isArray(value) ||
      value.length === 0 ||
      value.length > 500 ||
      !value.every((id) => typeof id === "string")
    )
      throw new Error("请选择 1–500 个 Skills。");
    return [...new Set(value)].map((id) => {
      const skill = deps.getInventory()?.skills.find((item) => item.id === id);
      if (!skill || !deps.getRoots().some((root) => root.id === skill.rootId))
        throw new Error("资源清单已变化，请重新扫描。");
      return skill;
    });
  }
  function target(value: unknown): SourceTarget {
    const result = deps.getTargets().find((item) => item.id === value);
    if (!result) throw new Error("同步目标不可用，请重新选择。");
    return result;
  }
  function projectTarget(value: unknown): { target: SourceTarget; projectPath: string } {
    const destination = target(value);
    const projectPath = dirname(dirname(destination.path));
    if (destination.scope !== "project" || !deps.getProjects?.().includes(projectPath)) {
      throw new Error("目标不属于当前登记的项目，请重新选择。");
    }
    const expected = join(
      projectPath,
      destination.client === "claude-code" ? ".claude" : ".agents",
      "skills",
    );
    if (destination.path !== expected) throw new Error("项目 Skills 目标目录不匹配。");
    return { target: destination, projectPath };
  }
  function boolean(value: unknown): boolean {
    if (typeof value !== "boolean") throw new Error("无效的替换选项。");
    return value;
  }
  function remember(
    inner: (ManagementPlan | ProjectDeploymentPlan)[],
    rootIds: string[],
    targetIds: string[],
    preview: Omit<ManagementPlanPreview, "id">,
  ) {
    for (const [id, item] of plans)
      if (Date.parse(item.preview.expiresAt) <= Date.now()) plans.delete(id);
    if (plans.size >= 100) plans.clear();
    const id = randomUUID();
    const result = { id, ...preview };
    plans.set(id, { plans: inner, rootIds, targetIds, preview: result });
    return result;
  }
  async function operation<T>(action: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (busy || deps.resourceBusy()) throw new Error("另一个操作正在进行，请稍后重试。");
    busy = true;
    controller = new AbortController();
    deps.changed();
    try {
      return await action(controller.signal);
    } finally {
      busy = false;
      controller = undefined;
      deps.changed();
    }
  }
  ipcMain.handle("management:get", (event) => {
    deps.trusted(event);
    return view();
  });
  ipcMain.handle(
    "management:sync:plan",
    (event, ids: unknown, targetId: unknown, replace: unknown) => {
      deps.trusted(event);
      return operation(async (signal) => {
        const skills = selected(ids),
          destination = target(targetId),
          allowReplace = boolean(replace);
        const destinations = skills.map((skill) =>
          join(destination.path, basename(dirname(skill.path))),
        );
        if (new Set(destinations).size !== destinations.length)
          throw new Error("多个资源将写入同名目录，请分开选择后预览。");
        const inner: ManagementPlan[] = [];
        const items: ManagementPlanPreview["items"] = [];
        const warnings: string[] = [];
        for (const [index, skill] of skills.entries()) {
          const path = destinations[index];
          if (!path) throw new Error("无效的同步目标。");
          const plan = await store.planSync({
            source: dirname(skill.path),
            target: path,
            sourceClient: skill.client,
            targetClient: destination.client,
            allowReplace,
            signal,
          });
          inner.push(plan);
          items.push({
            name: skill.name,
            source: plan.source.path,
            target: path,
            action: plan.action,
            files: plan.source.manifest.files,
            bytes: plan.source.manifest.bytes,
          });
          warnings.push(
            ...plan.compatibilityWarnings.map((warning) => `${skill.name}: ${warning.message}`),
          );
          if (plan.conflict) warnings.push(`${skill.name}: ${plan.conflict.message}`);
        }
        return remember(
          inner,
          skills.map((skill) => skill.rootId),
          [destination.id],
          {
            kind: "sync",
            expiresAt: inner[0]?.expiresAt ?? new Date().toISOString(),
            items,
            warnings,
            canExecute: inner.every((plan) => plan.executable),
          },
        );
      });
    },
  );
  ipcMain.handle("management:project:deploy:plan", (event, skillId: unknown, targetId: unknown) => {
    deps.trusted(event);
    return operation(async (signal) => {
      const skills = selected([skillId]);
      const skill = skills[0];
      if (!skill) throw new Error("请选择一项 Skill。");
      const { target: destination, projectPath } = projectTarget(targetId);
      const plan = await store.planProjectDeploy({
        source: dirname(skill.path),
        sourceClient: skill.client,
        projectPath,
        targetRoot: destination.path,
        targetClient: destination.client,
        signal,
      });
      return remember([plan], [skill.rootId], [destination.id], {
        kind: "project-deploy",
        expiresAt: plan.expiresAt,
        canExecute: plan.executable,
        items: [
          {
            name: skill.name,
            source: plan.sourcePath ?? "",
            target: plan.targetPath,
            action: plan.executable ? "copy" : "conflict",
            files: plan.files,
            bytes: plan.bytes,
          },
        ],
        warnings: [
          "这是项目目录副本。原 Skill 若仍位于客户端的全局扫描目录，撤销项目副本也不会隐藏全局 Skill。",
          ...plan.compatibilityWarnings.map((warning) => warning.message),
          ...(plan.conflict ? [plan.conflict] : []),
        ],
      });
    });
  });
  ipcMain.handle("management:project:revoke:plan", (event, deploymentId: unknown) => {
    deps.trusted(event);
    return operation(async (signal) => {
      if (typeof deploymentId !== "string") throw new Error("无效的项目部署记录。");
      const record = (await store.listProjectDeployments()).find(
        (entry) => entry.id === deploymentId,
      );
      if (!record) throw new Error("项目部署记录不存在。");
      const destination = deps
        .getTargets()
        .find((item) => item.path === record.targetRoot && item.client === record.targetClient);
      if (!destination) throw new Error("项目目标已断开，请重新登记项目。");
      const registered = projectTarget(destination.id);
      if (registered.projectPath !== record.projectPath) throw new Error("项目登记位置已变化。");
      const plan = await store.planProjectRevoke(record.id, signal);
      return remember([plan], [], [destination.id], {
        kind: "project-revoke",
        expiresAt: plan.expiresAt,
        canExecute: plan.executable,
        items: [
          {
            name: basename(record.targetPath),
            source: record.sourcePath,
            target: record.targetPath,
            action: plan.executable ? "revoke" : "conflict",
            files: plan.files,
            bytes: plan.bytes,
          },
        ],
        warnings: [
          "撤销只移走 Koyori 登记且内容未变化的项目副本，并在应用数据目录保留恢复材料。全局来源仍可能被客户端扫描。",
          ...(plan.conflict ? [plan.conflict] : []),
        ],
      });
    });
  });
  ipcMain.handle(
    "management:restore:plan",
    (event, snapshotId: unknown, targetId: unknown, replace: unknown) => {
      deps.trusted(event);
      return operation(async (signal) => {
        if (typeof snapshotId !== "string") throw new Error("无效的快照。");
        const snapshot = (await store.listBackups()).find((item) => item.id === snapshotId);
        if (!snapshot) throw new Error("快照不存在。");
        const destination = targetId === null ? null : target(targetId);
        const mapping = snapshot.entries.map((entry) => {
          if (!destination && !entry.originalPath)
            throw new Error("远端快照没有本机原位置，请选择恢复客户端。");
          const name = entry.directoryName;
          if (!name || name === "." || name === "..") throw new Error("快照目录名称无效。");
          const path = destination ? join(destination.path, name) : entry.originalPath;
          if (!path) throw new Error("恢复目标不可用。");
          return { entryId: entry.id, target: path };
        });
        if (new Set(mapping.map((item) => item.target)).size !== mapping.length)
          throw new Error("快照中存在同名资源，请选择原位恢复。");
        const writable = deps.getTargets();
        const targetIds = mapping.map((item) => {
          const root = destination ?? writable.find((root) => isWithin(item.target, root.path));
          if (!root) throw new Error("原位置不在当前授权目录内，请重新连接来源或选择客户端。");
          return root.id;
        });
        const plan = await store.planRestore(snapshotId, mapping, {
          allowReplace: boolean(replace),
          signal,
        });
        return remember([plan], [], targetIds, {
          kind: "restore",
          expiresAt: plan.expiresAt,
          canExecute: plan.executable,
          items: plan.items.map((item) => {
            const entry = snapshot.entries.find((candidate) => candidate.id === item.entryId);
            if (!entry) throw new Error("快照条目无效。");
            return {
              name: entry.name,
              source: `快照 ${snapshot.createdAt}`,
              target: item.target,
              action: item.action,
              files: entry.files,
              bytes: entry.bytes,
            };
          }),
          warnings: plan.items.flatMap((item) => (item.conflict ? [item.conflict.message] : [])),
        });
      });
    },
  );
  ipcMain.handle("management:execute", async (event, id: unknown) => {
    deps.trusted(event);
    let executionError: unknown;
    let attempted = false;
    try {
      await operation(async (signal) => {
        if (typeof id !== "string") throw new Error("无效的操作计划。");
        const record = plans.get(id);
        if (!record?.preview.canExecute || Date.parse(record.preview.expiresAt) <= Date.now())
          throw new Error("计划不存在或已过期，请重新预览。");
        if (
          record.rootIds.some((rootId) => !deps.getRoots().some((root) => root.id === rootId)) ||
          record.targetIds.some(
            (targetId) => !deps.getTargets().some((root) => root.id === targetId),
          )
        )
          throw new Error("来源或目标已经断开，请重新预览。");
        for (const plan of record.plans) {
          if (plan.kind === "project-deploy" || plan.kind === "project-revoke") {
            const destination = deps.getTargets().find((item) => item.path === plan.targetRoot);
            if (!destination || projectTarget(destination.id).projectPath !== plan.projectPath)
              throw new Error("项目登记或目标已变化，请重新预览。");
          }
        }
        plans.delete(id);
        lastResult = null;
        let succeeded = 0,
          skipped = 0,
          failed = 0;
        try {
          for (const [index, plan] of record.plans.entries()) {
            signal.throwIfAborted();
            attempted = true;
            const result: OperationRecord =
              plan.kind === "project-deploy" || plan.kind === "project-revoke"
                ? await store.executeProjectPlan(plan.id, { signal })
                : await store.execute(plan.id, { signal });
            succeeded += result.items.filter((item) => item.status === "succeeded").length;
            skipped += result.items.filter((item) => item.status === "skipped").length;
            failed += result.items.filter((item) =>
              ["failed", "cancelled", "interrupted"].includes(item.status),
            ).length;
            if (result.status !== "succeeded") {
              const remaining = record.plans.length - index - 1;
              lastResult = `已完成 ${succeeded} 项，内容相同跳过 ${skipped} 项，失败或取消 ${failed} 项${remaining > 0 ? `；另有 ${remaining} 个计划尚未执行` : ""}。`;
              throw new Error(
                result.error ?? `操作${result.status === "cancelled" ? "已取消" : "未全部完成"}`,
              );
            }
          }
          lastResult = `已完成 ${succeeded} 项，内容相同跳过 ${skipped} 项。`;
        } catch (error) {
          lastResult ??= `已完成 ${succeeded} 项，内容相同跳过 ${skipped} 项；操作未全部完成。`;
          throw error;
        }
      });
    } catch (error) {
      executionError = error;
    }
    if (attempted) {
      try {
        await deps.refresh();
      } catch (error) {
        if (executionError === undefined) {
          lastResult = `${lastResult ?? "文件操作已完成。"} 资源清单刷新失败，请稍后重试。`;
          executionError = error;
        }
      }
    }
    if (executionError !== undefined) throw executionError;
    return view();
  });
  ipcMain.handle("management:backup", async (event, ids: unknown) => {
    deps.trusted(event);
    await operation(async (signal) => {
      const skills = selected(ids);
      const snapshot = await store.createBackup(
        skills.map((skill) => ({
          id: skill.id,
          name: skill.name,
          client: skill.client,
          path: dirname(skill.path),
        })),
        { signal },
      );
      lastResult = `已在本机保存 ${snapshot.entries.length} 项完整目录快照。`;
    });
    return view();
  });
  ipcMain.handle("management:cancel", (event) => {
    deps.trusted(event);
    controller?.abort();
  });
  return { isBusy: () => busy, cancel: () => controller?.abort(), store };
}
