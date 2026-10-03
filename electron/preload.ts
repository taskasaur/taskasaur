import { contextBridge, ipcRenderer } from "electron";
contextBridge.exposeInMainWorld("taskasaurNative", {
  storage: {
    get: (key: string) => ipcRenderer.invoke("replica:get", key),
    set: (key: string, value: Uint8Array) =>
      ipcRenderer.invoke("replica:set", key, value),
    delete: (key: string) => ipcRenderer.invoke("replica:delete", key),
    keys: (prefix: string) => ipcRenderer.invoke("replica:keys", prefix),
  },
  peer: {
    request: (address: string, packet: unknown) =>
      ipcRenderer.invoke("peer:request", address, packet),
    join: (invitation: string) => ipcRenderer.invoke("peer:join", invitation),
    info: () => ipcRenderer.invoke("peer:info"),
    configure: (options: unknown) =>
      ipcRenderer.invoke("peer:configure", options),
  },
});
