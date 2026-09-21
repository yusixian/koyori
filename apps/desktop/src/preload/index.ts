import { contextBridge, ipcRenderer } from "electron";
import type { KoyoriBridge } from "../bridge";

const bridge: KoyoriBridge = {
  getRoots: () => ipcRenderer.invoke("roots:list"),
  addRoot: (client) => ipcRenderer.invoke("roots:add", client),
  removeRoot: (id) => ipcRenderer.invoke("roots:remove", id),
  scan: () => ipcRenderer.invoke("skills:scan"),
  cancelScan: () => ipcRenderer.invoke("skills:cancel"),
  getUsage: (days) => ipcRenderer.invoke("usage:get", days),
  addHistorySource: (rootId) => ipcRenderer.invoke("usage:source:add", rootId),
  disconnectHistorySource: (id) => ipcRenderer.invoke("usage:source:disconnect", id),
  importUsage: (days) => ipcRenderer.invoke("usage:import", days),
  cancelUsageImport: () => ipcRenderer.invoke("usage:cancel"),
  setSkillPreference: (id, patch, days) => ipcRenderer.invoke("usage:preference", id, patch, days),
  setUsageRules: (rules, days) => ipcRenderer.invoke("usage:rules", rules, days),
  markUsageReviewed: (days) => ipcRenderer.invoke("usage:reviewed", days),
  openProject: () => ipcRenderer.invoke("project:open"),
};
contextBridge.exposeInMainWorld("koyori", bridge);
