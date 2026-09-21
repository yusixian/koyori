import type {
  ClientId,
  HistorySource,
  ResourceRoot,
  SkillInventory,
  UsageRules,
  UsageView,
} from "@koyori/core";
export interface KoyoriBridge {
  getRoots(): Promise<ResourceRoot[]>;
  addRoot(client: ClientId): Promise<ResourceRoot | null>;
  removeRoot(id: string): Promise<ResourceRoot[]>;
  scan(): Promise<SkillInventory>;
  cancelScan(): Promise<void>;
  openProject(): Promise<void>;
  getUsage(windowDays?: 30 | 90): Promise<UsageView>;
  addHistorySource(rootId: string): Promise<HistorySource | null>;
  disconnectHistorySource(id: string): Promise<void>;
  importUsage(windowDays?: 30 | 90): Promise<UsageView>;
  cancelUsageImport(): Promise<void>;
  setSkillPreference(
    skillId: string,
    patch: { keep?: boolean; reviewAfter?: string | null },
    windowDays?: 30 | 90,
  ): Promise<UsageView>;
  setUsageRules(rules: UsageRules, windowDays?: 30 | 90): Promise<UsageView>;
  markUsageReviewed(windowDays?: 30 | 90): Promise<UsageView>;
}
declare global {
  const __APP_VERSION__: string;
  interface Window {
    koyori: KoyoriBridge;
  }
}
