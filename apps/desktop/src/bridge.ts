import type { ClientId, ResourceRoot, SkillInventory } from "@koyori/core";
export interface KoyoriBridge {
  getRoots(): Promise<ResourceRoot[]>;
  addRoot(client: ClientId): Promise<ResourceRoot | null>;
  removeRoot(id: string): Promise<ResourceRoot[]>;
  scan(): Promise<SkillInventory>;
  cancelScan(): Promise<void>;
  openProject(): Promise<void>;
}
declare global {
  const __APP_VERSION__: string;
  interface Window {
    koyori: KoyoriBridge;
  }
}
