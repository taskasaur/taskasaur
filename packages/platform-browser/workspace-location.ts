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
export interface WorkspaceOpenOptions {
  password?: string;
  requestPassword?: () => Promise<string>;
}
const needsPassword = (error: unknown) =>
  ["PASSWORD_REQUIRED", "INCORRECT_PASSWORD"].includes(
    (error as { kind?: string })?.kind ?? "",
  ) ||
  /Enter the workspace password|Incorrect workspace password/.test(
    String(error),
  );
async function unlock<T>(
  work: (password?: string) => Promise<T>,
  options: WorkspaceOpenOptions,
) {
  let password = options.password;
  for (;;) {
    try {
      return await work(password);
    } catch (error) {
      if (!needsPassword(error) || !options.requestPassword) throw error;
      password = await options.requestPassword();
    }
  }
}
export async function selectWorkspaceLocation(
  kind: "file" | "folder" = "folder",
  create = false,
  options: WorkspaceOpenOptions = {},
): Promise<WorkspaceLocation> {
  if (window.taskasaurNative?.workspace) {
    const api = window.taskasaurNative.workspace;
    let selected = await api.choose(kind, create, options.password);
    if (selected.locked) {
      try {
        selected = await unlock(
          (password) => api.unlock(selected.id, password ?? ""),
          options,
        );
      } catch (error) {
        await api.close(selected.id);
        throw error;
      }
    }
    return nativeLocation(selected.id, selected.label, selected.kind);
  }
  if (kind === "file") {
    const handle = await pickWorkspaceFile(create);
    return {
      label: handle.name,
      kind,
      files: await unlock(
        (password) => openBrowserWorkspaceArchive(handle, create, password),
        options,
      ),
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
  workspaceId?: string,
  options: WorkspaceOpenOptions = {},
) {
  if (window.taskasaurNative?.workspace) {
    const api = window.taskasaurNative.workspace;
    for (const item of await api.list()) {
      if (!workspaceId) {
        await accept(item.workspaceId);
        continue;
      }
      if (workspaceId !== item.workspaceId) continue;
      let source: WorkspaceStorage | undefined;
      try {
        const selected = await unlock(
          (password) => api.resume(workspaceId, password),
          options,
        );
        source = await WorkspaceStorage.open(
          nativeLocation(selected.id, selected.label, selected.kind).files,
        );
        if (source.manifest.workspace.id !== workspaceId)
          throw Error("Workspace location changed");
        await accept(workspaceId, source);
      } catch (error) {
        await source?.close();
        await accept(workspaceId);
        throw error;
      }
    }
  } else
    for (const location of await savedFolders()) {
      if (!workspaceId) {
        await accept(location.workspaceId);
        continue;
      }
      if (workspaceId !== location.workspaceId) continue;
      let source: WorkspaceStorage | undefined;
      try {
        source =
          location.handle.kind === "file"
            ? await WorkspaceStorage.open(
                await unlock(
                  (password) =>
                    openBrowserWorkspaceArchive(
                      location.handle as FileSystemFileHandle,
                      false,
                      password,
                    ),
                  options,
                ),
              )
            : await openSavedFolder(location.handle);
        if (source.manifest.workspace.id !== workspaceId)
          throw Error("Workspace location changed");
        await accept(workspaceId, source);
      } catch (error) {
        await source?.close();
        await accept(workspaceId);
        throw error;
      }
    }
}
