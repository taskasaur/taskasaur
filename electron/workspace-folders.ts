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
import { WorkspaceStorage } from "../packages/storage/workspace";
export async function registerWorkspaceFolders(
  window: () => BrowserWindow,
  trusted: (event: IpcMainInvokeEvent) => void,
) {
  const config = path.join(app.getPath("userData"), "workspace-folders.json");
  const opened = new Map<string, NodeWorkspaceFiles>(),
    ids = new Map<string, string>();
  let locations: Record<string, string> = {};
  try {
    locations = JSON.parse(await readFile(config, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  async function open(directory: string) {
    let id = ids.get(directory);
    if (!id) {
      id = crypto.randomUUID();
      opened.set(id, await NodeWorkspaceFiles.open(directory));
      ids.set(directory, id);
    }
    return { id, label: path.basename(directory) };
  }
  const get = (id: string) => {
    const files = opened.get(id);
    if (!files) throw Error("Select this folder before accessing it");
    return files;
  };
  ipcMain.handle("workspace:choose", async (event) => {
    trusted(event);
    const result = await dialog.showOpenDialog(window(), {
      title: "Taskasaur workspace folder",
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || !result.filePaths[0])
      throw Error("Folder selection canceled");
    return open(result.filePaths[0]);
  });
  ipcMain.handle("workspace:list", async (event) => {
    trusted(event);
    return Promise.all(
      Object.entries(locations).map(async ([workspaceId, directory]) => {
        try {
          return { ...(await open(directory)), workspaceId };
        } catch (e) {
          return {
            workspaceId,
            id: "",
            label: path.basename(directory),
            error: String(e),
          };
        }
      }),
    );
  });
  ipcMain.handle("workspace:read", async (event, id: string, name: string) => {
    trusted(event);
    return get(id).read(name);
  });
  ipcMain.handle(
    "workspace:remove",
    async (event, id: string, name: string) => {
      trusted(event);
      if (!/^data\/[a-f0-9]{64}\.bin$/.test(name))
        throw Error("Invalid workspace path");
      return get(id).remove(name);
    },
  );
  ipcMain.handle(
    "workspace:write",
    async (event, id: string, name: string, bytes: Uint8Array) => {
      trusted(event);
      if (!(bytes instanceof Uint8Array) || bytes.length > 40 * 1024 * 1024)
        throw Error("Invalid workspace data");
      return get(id).write(name, bytes);
    },
  );
  ipcMain.handle(
    "workspace:bind",
    async (event, id: string, workspaceId: string) => {
      trusted(event);
      const files = get(id),
        source = await WorkspaceStorage.open(files);
      if (source.manifest.workspace.id !== workspaceId)
        throw Error("Workspace does not match this folder");
      locations = { ...locations, [workspaceId]: files.directory };
      await writeFile(config + ".tmp", JSON.stringify(locations), {
        mode: 0o600,
      });
      await rename(config + ".tmp", config);
    },
  );
  app.on("will-quit", () => {
    for (const files of opened.values()) void files.close();
  });
}
