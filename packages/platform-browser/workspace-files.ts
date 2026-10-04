import Dexie from "dexie";
import type { WorkspaceFiles } from "../storage/workspace";
import { WorkspaceStorage } from "../storage/workspace";

export class BrowserWorkspaceFiles implements WorkspaceFiles {
  constructor(readonly handle: FileSystemDirectoryHandle) {}
  private async file(path: string, create = false) {
    if (path !== "workspace.json" && !/^data\/[a-f0-9]{64}\.bin$/.test(path))
      throw Error("Invalid workspace path");
    const parts = path.split("/");
    if (parts.some((p) => !p || p === "." || p === ".." || p.includes("\\")))
      throw Error("Invalid workspace path");
    let directory = this.handle;
    for (const name of parts.slice(0, -1))
      directory = await directory.getDirectoryHandle(name, { create });
    return directory.getFileHandle(parts.at(-1)!, { create });
  }
  async read(path: string) {
    try {
      return new Uint8Array(
        await (await (await this.file(path)).getFile()).arrayBuffer(),
      );
    } catch (e) {
      if ((e as DOMException).name === "NotFoundError") return;
      throw e;
    }
  }
  async write(path: string, bytes: Uint8Array) {
    const file = await this.file(path, true);
    const stream = await (
      file as FileSystemFileHandle & {
        createWritable(): Promise<
          WritableStream & {
            write(bytes: Uint8Array): Promise<void>;
            close(): Promise<void>;
            abort(): Promise<void>;
          }
        >;
      }
    ).createWritable();
    try {
      await stream.write(new Uint8Array(bytes));
      await stream.close();
    } catch (e) {
      await stream.abort().catch(() => {});
      throw e;
    }
  }
  async remove(path: string) {
    if (!/^data\/[a-f0-9]{64}\.bin$/.test(path))
      throw Error("Invalid workspace path");
    try {
      await (
        await this.handle.getDirectoryHandle("data")
      ).removeEntry(path.slice(5));
    } catch (e) {
      if ((e as DOMException).name !== "NotFoundError") throw e;
    }
  }
}
class WorkspaceHandles extends Dexie {
  constructor() {
    super("taskasaur-workspace-folders-v1");
    this.version(1).stores({ folders: "workspaceId" });
  }
}
export async function rememberFolder(
  workspaceId: string,
  handle: FileSystemDirectoryHandle | FileSystemFileHandle,
) {
  const db = new WorkspaceHandles();
  try {
    await db.table("folders").put({ workspaceId, handle });
  } finally {
    db.close();
  }
}
export async function savedFolders() {
  const db = new WorkspaceHandles();
  try {
    return await db
      .table<{
        workspaceId: string;
        handle: FileSystemDirectoryHandle | FileSystemFileHandle;
      }>("folders")
      .toArray();
  } finally {
    db.close();
  }
}
export async function forgetFolder(workspaceId: string) {
  const db = new WorkspaceHandles();
  try {
    await db.table("folders").delete(workspaceId);
  } finally {
    db.close();
  }
}
export const directoryPickerAvailable = () => "showDirectoryPicker" in window;
export async function pickWorkspaceFolder() {
  const picker = (
    window as unknown as {
      showDirectoryPicker(options: {
        mode: string;
        id: string;
      }): Promise<FileSystemDirectoryHandle>;
    }
  ).showDirectoryPicker;
  if (!picker)
    throw Error(
      "This platform uses browser storage. Import or export a workspace archive instead.",
    );
  return picker.call(window, { mode: "readwrite", id: "taskasaur-workspace" });
}
export async function openSavedFolder(handle: FileSystemDirectoryHandle) {
  const permission = await (
    handle as FileSystemDirectoryHandle & {
      queryPermission(options: { mode: string }): Promise<string>;
    }
  ).queryPermission({ mode: "readwrite" });
  if (permission !== "granted")
    throw Error(
      "Reconnect the workspace folder from the welcome screen to grant file access again.",
    );
  return WorkspaceStorage.open(new BrowserWorkspaceFiles(handle));
}
