import { createHash, randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { basename } from "node:path";
import { Worker } from "node:worker_threads";
import type {
  HistorySource,
  ResourceRoot,
  SkillInventory,
  SkillPreferenceAction,
  SkillPreferenceCard,
  UsageImport,
  UsageImportCache,
  UsageState,
  UsageView,
} from "@koyori/core";
import {
  buildSkillDiscussion,
  buildUsageReport,
  createUsageImportCache,
  createUsageState,
  mergeUsageImport,
  observeSkills,
  preferenceAfterAction,
} from "@koyori/core";
import { type BrowserWindow, dialog, ipcMain } from "electron";
import type { CollectionView, HistoryCandidate } from "../bridge";
import {
  type CollectionState,
  isPreferencePatch,
  isUsageRules,
  readCollectionState,
  readUsageCache,
  readUsageState,
  writeCollectionState,
  writeUsageCache,
  writeUsageState,
} from "./usage-store";

interface Dependencies {
  path: string;
  getRoots(): ResourceRoot[];
  getInventory(): SkillInventory | null;
  getWindow(): BrowserWindow | undefined;
  getCandidates(): HistoryCandidate[];
  changed(): void;
  resourceBusy(): boolean;
  trusted(event: Electron.IpcMainInvokeEvent): void;
}

interface UsageWorkerResult {
  imported: UsageImport;
  cache: UsageImportCache;
}

const AUTOMATIC_SOURCE_PREFIX = "automatic:";

function sourceRootIds(source: HistorySource): string[] {
  return source.rootIds && source.rootIds.length > 0 ? source.rootIds : [source.rootId];
}

function windowDays(value: unknown): 30 | 90 {
  if (value === undefined || value === 90) return 90;
  if (value === 30) return 30;
  throw new Error("Unsupported observation window");
}

export async function createUsageController(deps: Dependencies) {
  let state = await readUsageState(deps.path, createUsageState);
  let cache = await readUsageCache(`${deps.path}.cache`).catch(() => createUsageImportCache());
  let collection: CollectionState = await readCollectionState(`${deps.path}.collection`);
  let busy = false;
  let activeImport: AbortController | undefined;
  const preferenceCards = new Map<string, { card: SkillPreferenceCard; fingerprint: string }>();
  const now = () => new Date().toISOString();
  function connectedSkill(skillId: string) {
    const skill = deps.getInventory()?.skills.find((item) => item.id === skillId);
    const root = deps.getRoots().find((item) => item.id === skill?.rootId);
    if (!skill || !root || root.client !== skill.client)
      throw new Error("Resource is no longer connected");
    return { skill, root };
  }
  async function resourceFingerprint(skillId: string) {
    const { skill, root } = connectedSkill(skillId);
    let resolved: string;
    let file: Awaited<ReturnType<typeof stat>>;
    try {
      [resolved, file] = await Promise.all([realpath(skill.path), stat(skill.path)]);
    } catch {
      throw new Error("Resource changed; scan Skills and prepare the card again");
    }
    if (!file.isFile() || resolved !== (skill.realPath ?? skill.path))
      throw new Error("Resource changed; scan Skills and prepare the card again");
    return createHash("sha256")
      .update(
        JSON.stringify({
          skill,
          root,
          resolved,
          dev: file.dev,
          ino: file.ino,
          size: file.size,
          mtimeMs: file.mtimeMs,
          ctimeMs: file.ctimeMs,
        }),
      )
      .digest("hex");
  }
  function effectiveSource(source: HistorySource, currentRoots = deps.getRoots()): HistorySource {
    const currentRootIds = new Set(
      currentRoots.filter((root) => root.client === source.client).map((root) => root.id),
    );
    const rootIds = sourceRootIds(source).filter((id) => currentRootIds.has(id));
    return {
      ...source,
      rootId: rootIds[0] ?? source.rootId,
      ...(source.rootIds ? { rootIds } : {}),
      enabled:
        source.enabled &&
        rootIds.length > 0 &&
        (!source.id.startsWith(AUTOMATIC_SOURCE_PREFIX) || collection.enabled),
    };
  }
  function view(days: 30 | 90 = 90): UsageView {
    const currentRoots = deps.getRoots();
    const effectiveState = {
      ...state,
      sources: state.sources.map((source) => effectiveSource(source, currentRoots)),
    };
    return {
      sources: effectiveState.sources,
      coverage: state.coverage,
      issues: state.issues,
      preferences: state.preferences,
      rules: state.rules,
      lastImportedAt: state.lastImportedAt,
      lastReviewedAt: state.lastReviewedAt,
      report: buildUsageReport(
        deps.getInventory() ?? { skills: [], issues: [], scannedAt: now() },
        effectiveState,
        { now: now(), windowDays: days },
      ),
    };
  }
  ipcMain.handle("usage:discussion", (event, skillId: unknown, days: unknown) => {
    deps.trusted(event);
    if (typeof skillId !== "string" || skillId.length > 512) throw new Error("Invalid resource");
    const { skill } = connectedSkill(skillId);
    return buildSkillDiscussion(skill, view(windowDays(days)));
  });
  ipcMain.handle("usage:preference:plan", async (event, skillId: unknown, action: unknown) => {
    deps.trusted(event);
    if (typeof skillId !== "string" || skillId.length > 512) throw new Error("Invalid resource");
    if (action !== "keep" && action !== "review-later")
      throw new Error("Unsupported preference action");
    requireIdle();
    const { skill } = connectedSkill(skillId);
    const fingerprint = await resourceFingerprint(skillId);
    const createdAt = now();
    const current = state.preferences[skillId];
    const result = preferenceAfterAction(action as SkillPreferenceAction, current, createdAt);
    const card: SkillPreferenceCard = {
      id: randomUUID(),
      skillId,
      skillName: skill.name,
      action,
      current: current ? { ...current } : null,
      result,
      createdAt,
      expiresAt: new Date(Date.parse(createdAt) + 5 * 60_000).toISOString(),
    };
    if (preferenceCards.size >= 32)
      preferenceCards.delete(preferenceCards.keys().next().value ?? "");
    preferenceCards.set(card.id, { card, fingerprint });
    return card;
  });
  ipcMain.handle("usage:preference:confirm", async (event, cardId: unknown) => {
    deps.trusted(event);
    if (typeof cardId !== "string" || cardId.length > 128)
      throw new Error("Invalid preference card");
    const pending = preferenceCards.get(cardId);
    if (!pending) throw new Error("Preference card is no longer available");
    return mutate(async () => {
      if (preferenceCards.get(cardId) !== pending)
        throw new Error("Preference card is no longer available");
      preferenceCards.delete(cardId);
      const { card, fingerprint } = pending;
      if (Date.now() >= Date.parse(card.expiresAt))
        throw new Error("Preference card expired; prepare it again");
      const currentFingerprint = await resourceFingerprint(card.skillId);
      if (currentFingerprint !== fingerprint)
        throw new Error("Resource changed; prepare the preference card again");
      connectedSkill(card.skillId);
      const current = state.preferences[card.skillId] ?? null;
      if (JSON.stringify(current) !== JSON.stringify(card.current))
        throw new Error("Preference changed; prepare the card again");
      return {
        ...state,
        preferences: { ...state.preferences, [card.skillId]: { ...card.result } },
      };
    }, 90);
  });
  async function persist(next: UsageState) {
    await writeUsageState(deps.path, next);
    state = next;
  }
  function collectionView(): CollectionView {
    const candidates = deps.getCandidates();
    const selectableIds = new Set(
      candidates
        .filter((candidate) => candidate.capability === "invocations")
        .map((candidate) => candidate.id),
    );
    return {
      enabled: collection.enabled,
      selectedCandidateIds: collection.candidateIds.filter((id) => selectableIds.has(id)),
      candidates,
      lastAttemptAt: collection.lastAttemptAt,
      error: collection.error,
    };
  }
  async function persistCollection(next: CollectionState) {
    await writeCollectionState(`${deps.path}.collection`, next);
    collection = next;
    deps.changed();
  }
  function requireIdle() {
    if (busy || deps.resourceBusy()) throw new Error("An operation is in progress");
  }
  async function mutate(update: () => UsageState | Promise<UsageState>, days: 30 | 90) {
    requireIdle();
    busy = true;
    try {
      await persist(await update());
      return view(days);
    } finally {
      busy = false;
    }
  }

  async function runImport(
    sources: HistorySource[],
    baseState: UsageState = state,
  ): Promise<UsageWorkerResult> {
    const controller = new AbortController();
    activeImport = controller;
    const result = await new Promise<UsageWorkerResult>((resolve, reject) => {
      const worker = new Worker(new URL("./usage-worker.js", import.meta.url), {
        workerData: { sources, cache },
      });
      let settled = false;
      const finish = () => {
        settled = true;
        controller.signal.removeEventListener("abort", cancel);
        void worker.terminate();
      };
      const cancel = () => {
        finish();
        reject(new Error("Import cancelled; previous ledger was preserved"));
      };
      controller.signal.addEventListener("abort", cancel, { once: true });
      worker.once("message", (value: UsageWorkerResult) => {
        finish();
        resolve(value);
      });
      worker.once("error", () => {
        finish();
        reject(new Error("History import failed"));
      });
      worker.once("exit", () => {
        if (!settled) {
          finish();
          reject(new Error("History import interrupted"));
        }
      });
    });
    controller.signal.throwIfAborted();
    activeImport = undefined;
    const next = mergeUsageImport(baseState, result.imported, now());
    await persist(next);
    await writeUsageCache(`${deps.path}.cache`, result.cache)
      .then(() => {
        cache = result.cache;
      })
      .catch(() => undefined);
    return result;
  }

  function enabledSources(): HistorySource[] {
    return state.sources
      .map((source) => effectiveSource(source))
      .filter((source) => source.enabled);
  }

  function automaticSources(candidates: HistoryCandidate[]): HistorySource[] {
    const roots = deps.getRoots();
    const selected = new Set(collection.candidateIds);
    return candidates.flatMap((candidate) => {
      if (!selected.has(candidate.id) || candidate.capability !== "invocations") return [];
      const rootIds = candidate.rootIds.filter((id) =>
        roots.some((root) => root.id === id && root.client === candidate.client),
      );
      const rootId = rootIds[0];
      if (!rootId) return [];
      return [
        {
          id: `${AUTOMATIC_SOURCE_PREFIX}${candidate.id}`,
          rootId,
          rootIds,
          client: candidate.client,
          path: candidate.path,
          label: candidate.label,
          enabled: true,
        },
      ];
    });
  }

  async function refreshAutomatic(): Promise<CollectionView> {
    if (!collection.enabled || busy || deps.resourceBusy()) return collectionView();
    busy = true;
    try {
      const automatic = automaticSources(deps.getCandidates());
      const automaticById = new Map(automatic.map((source) => [source.id, source]));
      const sources = [
        ...state.sources
          .filter((source) => !source.id.startsWith(AUTOMATIC_SOURCE_PREFIX))
          .map((source) => ({ ...source })),
        ...state.sources
          .filter(
            (source) =>
              source.id.startsWith(AUTOMATIC_SOURCE_PREFIX) && !automaticById.has(source.id),
          )
          .map((source) => ({ ...source, enabled: false })),
        ...automatic,
      ];
      const selectedSources = sources
        .map((source) => effectiveSource(source))
        .filter((source) => source.enabled && source.id.startsWith(AUTOMATIC_SOURCE_PREFIX));
      if (selectedSources.length === 0)
        throw new Error("No selected history candidates are linked to an active resource root");
      await runImport(selectedSources, { ...state, sources });
      await persistCollection({ ...collection, lastAttemptAt: now(), error: null });
      return collectionView();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Automatic collection failed";
      await persistCollection({ ...collection, lastAttemptAt: now(), error: message });
      return collectionView();
    } finally {
      activeImport = undefined;
      busy = false;
    }
  }

  ipcMain.handle("usage:get", (event, days: unknown) => {
    deps.trusted(event);
    return view(windowDays(days));
  });
  ipcMain.handle("usage:source:add", async (event, rootId: unknown) => {
    deps.trusted(event);
    requireIdle();
    const root = deps.getRoots().find((item) => item.id === rootId);
    const window = deps.getWindow();
    if (root?.client !== "claude-code" || !window) throw new Error("Unsupported history source");
    busy = true;
    try {
      const result = await dialog.showOpenDialog(window, {
        title: "选择 Claude Code 会话日志目录（仅在本机读取）",
        properties: ["openDirectory"],
      });
      const path = result.filePaths[0];
      if (result.canceled || !path) return null;
      const previous = state.sources.find((item) => item.rootId === root.id && item.path === path);
      const source = {
        id: previous?.id ?? randomUUID(),
        rootId: root.id,
        client: root.client,
        path,
        label: basename(path) || path,
        enabled: true,
      };
      await persist({
        ...state,
        sources: [...state.sources.filter((item) => item.id !== source.id), source],
      });
      return source;
    } finally {
      busy = false;
    }
  });
  ipcMain.handle("usage:source:disconnect", async (event, id: unknown) => {
    deps.trusted(event);
    if (typeof id !== "string" || !state.sources.some((item) => item.id === id))
      throw new Error("Unknown source");
    await mutate(
      () => ({
        ...state,
        sources: state.sources.map((item) => (item.id === id ? { ...item, enabled: false } : item)),
      }),
      90,
    );
  });
  ipcMain.handle("usage:import", async (event, days: unknown) => {
    deps.trusted(event);
    const selectedDays = windowDays(days);
    requireIdle();
    const sources = enabledSources();
    if (sources.length === 0) throw new Error("Choose an enabled history source first");
    busy = true;
    try {
      await runImport(sources);
      return view(selectedDays);
    } finally {
      activeImport = undefined;
      busy = false;
    }
  });
  ipcMain.handle("usage:cancel", (event) => {
    deps.trusted(event);
    if (busy && !activeImport)
      throw new Error("Records are being saved and can no longer be cancelled");
    activeImport?.abort();
  });
  ipcMain.handle(
    "usage:preference",
    async (event, skillId: unknown, patch: unknown, days: unknown) => {
      deps.trusted(event);
      if (
        typeof skillId !== "string" ||
        !isPreferencePatch(patch) ||
        !deps.getInventory()?.skills.some((skill) => skill.id === skillId)
      )
        throw new Error("Unknown resource or invalid preference");
      return mutate(
        () => ({
          ...state,
          preferences: {
            ...state.preferences,
            [skillId]: {
              keep: false,
              reviewAfter: null,
              firstSeenAt: now(),
              ...state.preferences[skillId],
              ...patch,
            },
          },
        }),
        windowDays(days),
      );
    },
  );
  ipcMain.handle("usage:rules", async (event, rules: unknown, days: unknown) => {
    deps.trusted(event);
    if (!isUsageRules(rules)) throw new Error("Invalid review rules");
    return mutate(() => ({ ...state, rules }), windowDays(days));
  });
  ipcMain.handle("usage:reviewed", async (event, days: unknown) => {
    deps.trusted(event);
    return mutate(() => ({ ...state, lastReviewedAt: now() }), windowDays(days));
  });
  ipcMain.handle("collection:get", (event) => {
    deps.trusted(event);
    return collectionView();
  });
  ipcMain.handle("collection:set", async (event, enabled: unknown, candidateIds: unknown) => {
    deps.trusted(event);
    requireIdle();
    if (typeof enabled !== "boolean") throw new Error("Invalid collection setting");
    const candidates = deps.getCandidates();
    const knownIds = new Set(
      candidates
        .filter((candidate) => candidate.capability === "invocations")
        .map((candidate) => candidate.id),
    );
    const ids =
      candidateIds === undefined
        ? collection.candidateIds
        : Array.isArray(candidateIds) &&
            candidateIds.length <= 100 &&
            candidateIds.every((id): id is string => typeof id === "string" && knownIds.has(id))
          ? [...new Set(candidateIds)]
          : null;
    if (!ids || (enabled && ids.length === 0)) throw new Error("Choose a history candidate first");
    busy = true;
    try {
      await persistCollection({
        ...collection,
        enabled,
        candidateIds: ids,
        error: null,
      });
    } finally {
      busy = false;
    }
    return enabled ? refreshAutomatic() : collectionView();
  });

  return {
    isBusy: () => busy,
    cancel: () => activeImport?.abort(),
    async observe(inventory: SkillInventory) {
      const next = observeSkills(state, inventory, now());
      if (next !== state) await persist(next);
    },
    refreshAutomatic,
  };
}
