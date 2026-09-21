import { contextBridge, ipcRenderer } from "electron";
import type { KoyoriBridge } from "../bridge";

const bridge: KoyoriBridge = {
  getRoots: () => ipcRenderer.invoke("roots:list"),
  addRoot: (client) => ipcRenderer.invoke("roots:add", client),
  removeRoot: (id) => ipcRenderer.invoke("roots:remove", id),
  scan: () => ipcRenderer.invoke("skills:scan"),
  cancelScan: () => ipcRenderer.invoke("skills:cancel"),
  openProject: () => ipcRenderer.invoke("project:open"),
};
contextBridge.exposeInMainWorld("koyori", bridge);
