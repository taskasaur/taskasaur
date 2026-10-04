import { contextBridge, ipcRenderer } from "electron";
contextBridge.exposeInMainWorld("taskasaurNative", {
  storage: {
    get: (key: string) => ipcRenderer.invoke("replica:get", key),
    set: (key: string, value: Uint8Array) =>
      ipcRenderer.invoke("replica:set", key, value),
    delete: (key: string) => ipcRenderer.invoke("replica:delete", key),
    keys: (prefix: string) => ipcRenderer.invoke("replica:keys", prefix),
  },
  workspace: {
    choose: (kind: "file" | "folder", create: boolean) =>
      ipcRenderer.invoke("workspace:choose", kind, create),
    list: () => ipcRenderer.invoke("workspace:list"),
    read: (id: string, path: string) =>
      ipcRenderer.invoke("workspace:read", id, path),
    write: (id: string, path: string, bytes: Uint8Array) =>
      ipcRenderer.invoke("workspace:write", id, path, bytes),
    remove: (id: string, path: string) =>
      ipcRenderer.invoke("workspace:remove", id, path),
    bind: (id: string, workspaceId: string) =>
      ipcRenderer.invoke("workspace:bind", id, workspaceId),
    commit: (
      id: string,
      manifest: Uint8Array,
      additions: Record<string, Uint8Array>,
    ) => ipcRenderer.invoke("workspace:commit", id, manifest, additions),
    refresh: (id: string) => ipcRenderer.invoke("workspace:refresh", id),
    close: (id: string) => ipcRenderer.invoke("workspace:close", id),
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
