import {
  BrowserWorkspaceFiles,
  directoryPickerAvailable,
  pickWorkspaceFolder,
  rememberFolder,
  savedFolders,
  openSavedFolder,
} from "./workspace-files";
import { WorkspaceStorage, type WorkspaceFiles } from "../storage/workspace";
import {
  filePickerAvailable,
  pickWorkspaceFile,
  openBrowserWorkspaceArchive,
} from "./workspace-archive";
export interface WorkspaceLocation {
  label: string;
  kind: "file" | "folder";
  files: WorkspaceFiles;
  remember(workspaceId: string): Promise<void>;
}
function nativeLocation(
  id: string,
  label: string,
  kind: "file" | "folder",
): WorkspaceLocation {
  const api = window.taskasaurNative!.workspace!;
  return {
    label,
    kind,
    files: {
      read: (path) => api.read(id, path),
      write: (path, bytes) => api.write(id, path, bytes),
      remove: (path) => api.remove(id, path),
      ...(kind === "file"
        ? {
            commit: (
              manifest: Uint8Array,
              additions: Record<string, Uint8Array>,
            ) => api.commit(id, manifest, additions),
            refresh: () => api.refresh(id),
          }
        : {}),
      close: () => api.close(id),
    },
    remember: (workspaceId) => api.bind(id, workspaceId),
  };
}
export const workspaceFolderAvailable = () =>
  Boolean(window.taskasaurNative?.workspace) || directoryPickerAvailable();
export const workspaceFileAvailable = () =>
  Boolean(window.taskasaurNative?.workspace) || filePickerAvailable();
export async function selectWorkspaceLocation(
  kind: "file" | "folder" = "folder",
  create = false,
): Promise<WorkspaceLocation> {
  if (window.taskasaurNative?.workspace) {
    const selected = await window.taskasaurNative.workspace.choose(
      kind,
      create,
    );
    return nativeLocation(selected.id, selected.label, selected.kind);
  }
  if (kind === "file") {
    const handle = await pickWorkspaceFile(create);
    return {
      label: handle.name,
      kind,
      files: await openBrowserWorkspaceArchive(handle, create),
      remember: (id) => rememberFolder(id, handle),
    };
  }
  const handle = await pickWorkspaceFolder();
  return {
    label: handle.name,
    kind,
    files: new BrowserWorkspaceFiles(handle),
    remember: (id) => rememberFolder(id, handle),
  };
}
export async function restoreWorkspaceLocations(
  accept: (id: string, source?: WorkspaceStorage) => Promise<void>,
) {
  if (window.taskasaurNative?.workspace) {
    for (const item of await window.taskasaurNative.workspace.list()) {
      let source: WorkspaceStorage | undefined;
      try {
        if (item.error) throw Error(item.error);
        source = await WorkspaceStorage.open(
          nativeLocation(item.id, item.label, item.kind).files,
        );
        if (source.manifest.workspace.id !== item.workspaceId)
          throw Error("Workspace location changed");
        await accept(item.workspaceId, source);
      } catch {
        await source?.close();
        await accept(item.workspaceId);
      }
    }
  } else
    for (const folder of await savedFolders()) {
      let source: WorkspaceStorage | undefined;
      try {
        source =
          folder.handle.kind === "file"
            ? await WorkspaceStorage.open(
                await openBrowserWorkspaceArchive(folder.handle),
              )
            : await openSavedFolder(folder.handle);
        if (source.manifest.workspace.id !== folder.workspaceId)
          throw Error("Workspace location changed");
        await accept(folder.workspaceId, source);
      } catch {
        await source?.close();
        await accept(folder.workspaceId);
      }
    }
}
