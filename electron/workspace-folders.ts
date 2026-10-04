import {
  app,
  dialog,
  ipcMain,
  type BrowserWindow,
  type IpcMainInvokeEvent,
} from "electron";
import { readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { NodeWorkspaceFiles } from "../packages/platform-node/workspace-files";
import { openNodeWorkspaceArchive } from "../packages/platform-node/workspace-archive";
import {
  WorkspaceStorage,
  type WorkspaceFiles,
} from "../packages/storage/workspace";
import { WORKSPACE_ARCHIVE_LIMIT } from "../packages/storage/workspace-archive";
type Location = { path: string; kind: "file" | "folder" };
export async function registerWorkspaceFolders(
  window: () => BrowserWindow,
  trusted: (event: IpcMainInvokeEvent) => void,
) {
  // Keep the config filename so existing folder bindings migrate without losing access.
  const config = path.join(app.getPath("userData"), "workspace-folders.json");
  const pending = new Map<string, Location>();
  const opened = new Map<string, Location & { files: WorkspaceFiles }>(),
    ids = new Map<string, string>();
  let locations: Record<string, Location | string> = {};
  try {
    locations = JSON.parse(await readFile(config, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  async function open(location: Location, create = false, password?: string) {
    let id = ids.get(location.path);
    if (!id) {
      id = crypto.randomUUID();
      const files =
        location.kind === "file"
          ? await openNodeWorkspaceArchive(location.path, create, password)
          : await NodeWorkspaceFiles.open(location.path);
      opened.set(id, { ...location, files });
      ids.set(location.path, id);
    }
    return { id, label: path.basename(location.path), kind: location.kind };
  }
  const get = (id: string) => {
    const location = opened.get(id);
    if (!location)
      throw Error("Select this workspace location before accessing it");
    return location;
  };
  ipcMain.handle(
    "workspace:choose",
    async (
      event,
      kind: "file" | "folder" = "folder",
      create = false,
      password?: string,
    ) => {
      trusted(event);
      if (!["file", "folder"].includes(kind) || typeof create !== "boolean")
        throw Error("Invalid workspace selection");
      let selected: string | undefined;
      const filters = [
        { name: "Taskasaur workspace", extensions: ["taskasaur"] },
      ];
      if (kind === "file" && create) {
        const result = await dialog.showSaveDialog(window(), {
          title: "Save and work from workspace file",
          defaultPath: "workspace.taskasaur",
          filters,
        });
        if (!result.canceled) selected = result.filePath;
      } else {
        const result = await dialog.showOpenDialog(window(), {
          title:
            kind === "file"
              ? "Open workspace file"
              : "Taskasaur workspace folder",
          properties:
            kind === "file"
              ? ["openFile"]
              : ["openDirectory", "createDirectory"],
          ...(kind === "file" ? { filters } : {}),
        });
        if (!result.canceled) selected = result.filePaths[0];
      }
      if (!selected) throw Error("Workspace selection canceled");
      if (ids.has(selected))
        throw Error("This workspace location is already open");
      try {
        return await open({ path: selected, kind }, create, password);
      } catch (error) {
        if ((error as { kind?: string }).kind !== "PASSWORD_REQUIRED")
          throw error;
        const id = crypto.randomUUID();
        pending.set(id, { path: selected, kind });
        return { id, label: path.basename(selected), kind, locked: true };
      }
    },
  );
  ipcMain.handle("workspace:list", async (event) => {
    trusted(event);
    return Object.entries(locations).map(([workspaceId, value]) => {
      const location: Location =
        typeof value === "string" ? { path: value, kind: "folder" } : value;
      return {
        workspaceId,
        id: ids.get(location.path) ?? "",
        label: path.basename(location.path),
        kind: location.kind,
      };
    });
  });
  ipcMain.handle(
    "workspace:resume",
    async (event, workspaceId: string, password?: string) => {
      trusted(event);
      const value = locations[workspaceId];
      if (!value) throw Error("Workspace location is not saved");
      return open(
        typeof value === "string" ? { path: value, kind: "folder" } : value,
        false,
        password,
      );
    },
  );
  ipcMain.handle(
    "workspace:unlock",
    async (event, id: string, password: string) => {
      trusted(event);
      const location = pending.get(id);
      if (!location) throw Error("Select this workspace file first");
      const result = await open(location, false, password);
      pending.delete(id);
      return result;
    },
  );
  ipcMain.handle("workspace:read", async (event, id: string, name: string) => {
    trusted(event);
    return get(id).files.read(name);
  });
  ipcMain.handle(
    "workspace:remove",
    async (event, id: string, name: string) => {
      trusted(event);
      if (!/^data\/[a-f0-9]{64}\.bin$/.test(name))
        throw Error("Invalid workspace path");
      return get(id).files.remove(name);
    },
  );
  ipcMain.handle(
    "workspace:write",
    async (event, id: string, name: string, bytes: Uint8Array) => {
      trusted(event);
      if (!(bytes instanceof Uint8Array) || bytes.length > 64 * 1024 * 1024)
        throw Error("Invalid workspace data");
      return get(id).files.write(name, bytes);
    },
  );
  ipcMain.handle(
    "workspace:commit",
    async (
      event,
      id: string,
      manifest: Uint8Array,
      additions: Record<string, Uint8Array>,
    ) => {
      trusted(event);
      const files = get(id).files;
      if (
        !files.commit ||
        !(manifest instanceof Uint8Array) ||
        manifest.length > 64 * 1024 * 1024 ||
        !additions ||
        typeof additions !== "object"
      )
        throw Error("Invalid workspace commit");
      let total = manifest.length;
      for (const [name, bytes] of Object.entries(additions)) {
        if (
          !/^data\/[a-f0-9]{64}\.bin$/.test(name) ||
          !(bytes instanceof Uint8Array) ||
          bytes.length > 40 * 1024 * 1024
        )
          throw Error("Invalid workspace data");
        total += bytes.length;
        if (total > WORKSPACE_ARCHIVE_LIMIT)
          throw Error("Workspace files are limited to 1 GB");
      }
      await files.commit(manifest, additions);
    },
  );
  ipcMain.handle("workspace:refresh", async (event, id: string) => {
    trusted(event);
    await get(id).files.refresh?.();
  });
  ipcMain.handle("workspace:close", async (event, id: string) => {
    trusted(event);
    pending.delete(id);
    const location = opened.get(id);
    if (!location) return;
    await location.files.close?.();
    ids.delete(location.path);
    opened.delete(id);
  });
  ipcMain.handle(
    "workspace:bind",
    async (event, id: string, workspaceId: string) => {
      trusted(event);
      const location = get(id),
        source = await WorkspaceStorage.open(location.files);
      if (source.manifest.workspace.id !== workspaceId)
        throw Error("Workspace does not match this location");
      locations = {
        ...locations,
        [workspaceId]: { path: location.path, kind: location.kind },
      };
      await writeFile(config + ".tmp", JSON.stringify(locations), {
        mode: 0o600,
      });
      await rename(config + ".tmp", config);
    },
  );
  app.on("will-quit", () => {
    for (const location of opened.values()) void location.files.close?.();
  });
}
