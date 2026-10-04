import {
  ArchiveWorkspaceFiles,
  assertArchiveUnchanged,
  WORKSPACE_ARCHIVE_LIMIT,
} from "../storage/workspace-archive";

type WritableHandle = FileSystemFileHandle & {
  queryPermission(options: { mode: string }): Promise<string>;
  requestPermission(options: { mode: string }): Promise<string>;
};
export const filePickerAvailable = () =>
  "showOpenFilePicker" in window &&
  "showSaveFilePicker" in window &&
  Boolean(navigator.locks);
export async function pickWorkspaceFile(create: boolean) {
  const picker = window as unknown as {
    showOpenFilePicker(options: unknown): Promise<FileSystemFileHandle[]>;
    showSaveFilePicker(options: unknown): Promise<FileSystemFileHandle>;
  };
  const options = {
    id: "taskasaur-workspace-file",
    types: [
      {
        description: "Taskasaur workspace",
        accept: { "application/zip": [".taskasaur"] },
      },
    ],
    excludeAcceptAllOption: true,
  };
  const handle = create
    ? await picker.showSaveFilePicker({
        ...options,
        suggestedName: "workspace.taskasaur",
      })
    : (await picker.showOpenFilePicker({ ...options, multiple: false }))[0];
  if (!handle) throw Error("File selection canceled");
  if (
    (await (handle as WritableHandle).requestPermission({
      mode: "readwrite",
    })) !== "granted"
  )
    throw Error("Allow read and write access to work from this workspace file");
  return handle;
}

export async function openBrowserWorkspaceArchive(
  handle: FileSystemFileHandle,
  create = false,
  password?: string,
) {
  if (
    (await (handle as WritableHandle).queryPermission({
      mode: "readwrite",
    })) !== "granted"
  )
    throw Error(
      "Reconnect this workspace file from the welcome screen to grant access again",
    );
  let heldId: string | undefined,
    release: (() => void) | undefined,
    lease: Promise<void> | undefined;
  const read = async () => {
    const file = await handle.getFile();
    if (file.size > WORKSPACE_ARCHIVE_LIMIT)
      throw Error("Workspace files are limited to 1 GB");
    return new Uint8Array(await file.arrayBuffer());
  };
  return ArchiveWorkspaceFiles.open(
    {
      read,
      async lock(id) {
        if (heldId === id) return;
        if (heldId)
          throw Error("Cannot change an open workspace's package identity");
        const hold = new Promise<void>((resolve) => {
          release = resolve;
        });
        await new Promise<void>((resolve, reject) => {
          lease = navigator.locks
            .request(
              "taskasaur-workspace-file:" + id,
              { ifAvailable: true },
              async (lock) => {
                if (!lock)
                  throw Error(
                    "This workspace file is already open in another tab. Close it there before opening it here.",
                  );
                heldId = id;
                resolve();
                await hold;
              },
            )
            .then(() => {});
          void lease.catch(reject);
        });
      },
      async replace(bytes, expectedHash) {
        // Serialize initial creation too, before a previously empty file has a package ID.
        await navigator.locks.request(
          "taskasaur-workspace-file-commit",
          async () => {
            const writable = await (
              handle as FileSystemFileHandle & {
                createWritable(options: {
                  mode: string;
                }): Promise<FileSystemWritableFileStream>;
              }
            ).createWritable({ mode: "exclusive" });
            try {
              await assertArchiveUnchanged(await read(), expectedHash);
              await writable.write(new Uint8Array(bytes));
              await writable.close();
            } catch (error) {
              await writable.abort().catch(() => {});
              throw error;
            }
          },
        );
      },
      async close() {
        release?.();
        await lease?.catch(() => {});
      },
    },
    create,
    password,
  );
}
