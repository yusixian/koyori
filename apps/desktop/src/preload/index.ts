import { contextBridge, ipcRenderer } from "electron";
import type { KoyoriBridge } from "../bridge";

const bridge: KoyoriBridge = {
  getUpdate: () => ipcRenderer.invoke("update:get"),
  checkForUpdate: () => ipcRenderer.invoke("update:check"),
  downloadUpdate: () => ipcRenderer.invoke("update:download"),
  cancelUpdateDownload: () => ipcRenderer.invoke("update:download:cancel"),
  installUpdate: () => ipcRenderer.invoke("update:install"),
  onUpdateChanged: (listener) => {
    const notify = () => listener();
    ipcRenderer.on("update:changed", notify);
    return () => ipcRenderer.removeListener("update:changed", notify);
  },
  getAgent: () => ipcRenderer.invoke("agent:get"),
  saveAgentConnection: (input) => ipcRenderer.invoke("agent:connection:save", input),
  disconnectAgent: () => ipcRenderer.invoke("agent:disconnect"),
  createAgentSession: () => ipcRenderer.invoke("agent:session:create"),
  selectAgentSession: (id) => ipcRenderer.invoke("agent:session:select", id),
  renameAgentSession: (id, title) => ipcRenderer.invoke("agent:session:rename", id, title),
  deleteAgentSession: (id) => ipcRenderer.invoke("agent:session:delete", id),
  sendAgentMessage: (id, text) => ipcRenderer.invoke("agent:send", id, text),
  cancelAgentRun: () => ipcRenderer.invoke("agent:cancel"),
  onAgentChanged: (listener) => {
    const notify = () => listener();
    ipcRenderer.on("agent:changed", notify);
    return () => ipcRenderer.removeListener("agent:changed", notify);
  },
  getWorkspace: () => ipcRenderer.invoke("workspace:get"),
  discoverSources: (resetIgnored) => ipcRenderer.invoke("workspace:discover", resetIgnored),
  setAutomaticDiscovery: (enabled) => ipcRenderer.invoke("workspace:automatic", enabled),
  addProject: () => ipcRenderer.invoke("workspace:project:add"),
  onWorkspaceChanged: (listener) => {
    const notify = () => listener();
    ipcRenderer.on("workspace:changed", notify);
    return () => ipcRenderer.removeListener("workspace:changed", notify);
  },
  getRoots: () => ipcRenderer.invoke("roots:list"),
  addRoot: (client) => ipcRenderer.invoke("roots:add", client),
  removeRoot: (id) => ipcRenderer.invoke("roots:remove", id),
  scan: () => ipcRenderer.invoke("skills:scan"),
  cancelScan: () => ipcRenderer.invoke("skills:cancel"),
  getUsage: (days) => ipcRenderer.invoke("usage:get", days),
  prepareSkillDiscussion: (id, days) => ipcRenderer.invoke("usage:discussion", id, days),
  planSkillPreference: (id, action) => ipcRenderer.invoke("usage:preference:plan", id, action),
  confirmSkillPreference: (id) => ipcRenderer.invoke("usage:preference:confirm", id),
  addHistorySource: (rootId) => ipcRenderer.invoke("usage:source:add", rootId),
  disconnectHistorySource: (id) => ipcRenderer.invoke("usage:source:disconnect", id),
  importUsage: (days) => ipcRenderer.invoke("usage:import", days),
  cancelUsageImport: () => ipcRenderer.invoke("usage:cancel"),
  setSkillPreference: (id, patch, days) => ipcRenderer.invoke("usage:preference", id, patch, days),
  setUsageRules: (rules, days) => ipcRenderer.invoke("usage:rules", rules, days),
  markUsageReviewed: (days) => ipcRenderer.invoke("usage:reviewed", days),
  getCollection: () => ipcRenderer.invoke("collection:get"),
  setCollection: (enabled, ids) => ipcRenderer.invoke("collection:set", enabled, ids),
  getManagement: () => ipcRenderer.invoke("management:get"),
  planSync: (ids, target, replace) =>
    ipcRenderer.invoke("management:sync:plan", ids, target, replace),
  planProjectDeploy: (id, target) =>
    ipcRenderer.invoke("management:project:deploy:plan", id, target),
  planProjectRevoke: (id) => ipcRenderer.invoke("management:project:revoke:plan", id),
  planRestore: (id, target, replace) =>
    ipcRenderer.invoke("management:restore:plan", id, target, replace),
  executePlan: (id) => ipcRenderer.invoke("management:execute", id),
  backupSkills: (ids) => ipcRenderer.invoke("management:backup", ids),
  cancelManagement: () => ipcRenderer.invoke("management:cancel"),
  getRemoteBackup: () => ipcRenderer.invoke("backup:remote:get"),
  connectRemoteBackup: (remote) => ipcRenderer.invoke("backup:remote:connect", remote),
  disconnectRemoteBackup: () => ipcRenderer.invoke("backup:remote:disconnect"),
  publishBackup: (id) => ipcRenderer.invoke("backup:remote:publish", id),
  refreshRemoteHistory: () => ipcRenderer.invoke("backup:remote:history"),
  fetchRemoteBackup: (commit) => ipcRenderer.invoke("backup:remote:fetch", commit),
  setAutomaticBackup: (enabled, ids) => ipcRenderer.invoke("backup:remote:automatic", enabled, ids),
  cancelRemoteBackup: () => ipcRenderer.invoke("backup:remote:cancel"),
  getServices: () => ipcRenderer.invoke("services:get"),
  saveService: (input) => ipcRenderer.invoke("services:save", input),
  removeService: (id) => ipcRenderer.invoke("services:remove", id),
  openService: (id) => ipcRenderer.invoke("services:open", id),
  openProject: () => ipcRenderer.invoke("project:open"),
};
contextBridge.exposeInMainWorld("koyori", bridge);
