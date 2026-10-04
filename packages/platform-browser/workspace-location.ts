import {
  BrowserWorkspaceFiles,
  directoryPickerAvailable,
  pickWorkspaceFolder,
  rememberFolder,
  savedFolders,
  openSavedFolder,
} from "./workspace-files";
import { WorkspaceStorage, type WorkspaceFiles } from "../storage/workspace";
export interface WorkspaceLocation {
  label: string;
  files: WorkspaceFiles;
  remember(workspaceId: string): Promise<void>;
}
function nativeLocation(id: string, label: string): WorkspaceLocation {
  const api = window.taskasaurNative!.workspace!;
  return {
    label,
    files: {
      read: (path) => api.read(id, path),
      write: (path, bytes) => api.write(id, path, bytes),
      remove: (path) => api.remove(id, path),
    },
    remember: (workspaceId) => api.bind(id, workspaceId),
  };
}
export const workspaceFolderAvailable = () =>
  Boolean(window.taskasaurNative?.workspace) || directoryPickerAvailable();
export async function selectWorkspaceLocation(): Promise<WorkspaceLocation> {
  if (window.taskasaurNative?.workspace) {
    const selected = await window.taskasaurNative.workspace.choose();
    return nativeLocation(selected.id, selected.label);
  }
  const handle = await pickWorkspaceFolder();
  return {
    label: handle.name,
    files: new BrowserWorkspaceFiles(handle),
    remember: (id) => rememberFolder(id, handle),
  };
}
export async function restoreWorkspaceLocations(
  accept: (id: string, source?: WorkspaceStorage) => Promise<void>,
) {
  if (window.taskasaurNative?.workspace) {
    for (const item of await window.taskasaurNative.workspace.list()) {
      try {
        if (item.error) throw Error(item.error);
        const source = await WorkspaceStorage.open(
          nativeLocation(item.id, item.label).files,
        );
        if (source.manifest.workspace.id !== item.workspaceId)
          throw Error("Workspace folder changed");
        await accept(item.workspaceId, source);
      } catch {
        await accept(item.workspaceId);
      }
    }
  } else
    for (const folder of await savedFolders()) {
      try {
        const source = await openSavedFolder(folder.handle);
        if (source.manifest.workspace.id !== folder.workspaceId)
          throw Error("Workspace folder changed");
        await accept(folder.workspaceId, source);
      } catch {
        await accept(folder.workspaceId);
      }
    }
}
