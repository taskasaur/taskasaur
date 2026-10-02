import { contextBridge, ipcRenderer } from "electron";
contextBridge.exposeInMainWorld("taskasaurNative", {
  request: (input: {
    url: string;
    method: string;
    contentType?: string;
    body?: Uint8Array;
  }) => ipcRenderer.invoke("server:http", input),
  capabilities: () => ipcRenderer.invoke("platform:capabilities"),
  pair: (input: {
    serverUrl: string;
    code: string;
    terminal: boolean;
    automation: boolean;
  }) => ipcRenderer.invoke("device:pair", input),
});
