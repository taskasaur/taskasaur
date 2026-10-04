import { useEffect, useRef, useState } from "react";
import { Button } from "../ui/primitives/button";
import { Input } from "../ui/primitives/input";
import { SharedTextarea } from "../ui/html-controls";
import { browserDevice, workspaceRouter } from "../platform-browser/device";
import {
  workspaceFolderAvailable,
  workspaceFileAvailable,
  selectWorkspaceLocation,
  type WorkspaceLocation,
} from "../platform-browser/workspace-location";
import { WorkspaceStorage } from "../storage/workspace";
import {
  exportWorkspace,
  importWorkspace,
  openWorkspaceArchive,
  workspaceSnapshot,
} from "../core/workspace-package";
import {
  profileForNode,
  type AppRuntime,
  type WorkspaceProfile,
} from "./runtime";
import { download } from "./download";

export function OpenWorkspaceFile({
  onOpen,
}: {
  onOpen(profile: WorkspaceProfile): Promise<void>;
}) {
  const [source, setSource] = useState<WorkspaceStorage>(),
    [folder, setFolder] = useState<WorkspaceLocation>(),
    [request, setRequest] = useState(""),
    [invitation, setInvitation] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const pending = useRef<WorkspaceStorage | undefined>(undefined);
  useEffect(
    () => () => {
      const value = pending.current;
      if (
        value &&
        workspaceRouter.mounts.get(value.manifest.workspace.id) !== value
      )
        void value.close();
    },
    [],
  );
  const load = async (value: WorkspaceStorage, handle?: WorkspaceLocation) => {
    const previous = pending.current;
    if (
      previous &&
      previous !== value &&
      workspaceRouter.mounts.get(previous.manifest.workspace.id) !== previous
    )
      await previous.close();
    pending.current = value;
    setSource(value);
    setFolder(handle);
    setError("");
    setInvitation("");
    setRequest((await browserDevice()).pairingRequest());
  };
  return (
    <section className="mt-6 space-y-3 border-t pt-4">
      <h2 className="font-medium">Open a workspace</h2>
      <label className="field-row">
        Workspace archive
        <Input
          aria-label="Workspace archive"
          type="file"
          accept=".taskasaur,.zip"
          disabled={busy}
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            setBusy(true);
            try {
              await load(
                await openWorkspaceArchive(
                  new Uint8Array(await file.arrayBuffer()),
                ),
              );
            } catch (e) {
              setError(String(e));
            } finally {
              setBusy(false);
              e.target.value = "";
            }
          }}
        />
      </label>
      {(["file", "folder"] as const)
        .filter((kind) =>
          kind === "file"
            ? workspaceFileAvailable()
            : workspaceFolderAvailable(),
        )
        .map((kind) => (
          <Button
            key={kind}
            variant="outline"
            disabled={busy}
            onClick={async () => {
              let handle: WorkspaceLocation | undefined;
              setBusy(true);
              try {
                handle = await selectWorkspaceLocation(kind);
                await load(await WorkspaceStorage.open(handle.files), handle);
              } catch (e) {
                await handle?.files.close?.();
                setError(String(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            Open workspace {kind}
          </Button>
        ))}
      {source && (
        <div className="space-y-3">
          <p>{source.manifest.workspace.name}</p>
          <p className="text-sm text-muted-foreground">
            A new device needs approval from the workspace owner. Copy this
            request to their Devices page, then paste the returned invitation.
            An already approved device can open directly.
          </p>
          <SharedTextarea
            aria-label="Workspace file device request"
            readOnly
            value={request}
          />
          <Button
            variant="outline"
            onClick={() =>
              void navigator.clipboard
                .writeText(request)
                .catch((e) => setError(String(e)))
            }
          >
            Copy file device request
          </Button>
          <SharedTextarea
            aria-label="Workspace file approval"
            value={invitation}
            onChange={(e) => setInvitation(e.target.value)}
            placeholder="Workspace invitation"
          />
          <Button
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                const device = await browserDevice();
                // Reconnect the selected package before opening an already mounted profile.
                if (
                  folder &&
                  workspaceRouter.blocked.has(source.manifest.workspace.id)
                ) {
                  await workspaceRouter.mount(source, false);
                }
                const node = await importWorkspace(
                  device,
                  source,
                  invitation || undefined,
                );
                if (folder) {
                  const snapshot = await workspaceSnapshot(node);
                  await workspaceRouter.mount(
                    source,
                    true,
                    snapshot.excludedKeys,
                  );
                  await folder.remember(node.replica.workspaceId);
                }
                await onOpen(await profileForNode(node));
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            {folder
              ? `Open and write to ${folder.kind}`
              : "Import and open workspace"}
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}
export function WorkspaceFileSettings({ runtime }: { runtime: AppRuntime }) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        A workspace archive includes shared records, tables, credentials
        ciphertext, files and their versions, Automerge history, and peer
        connections. Device identity, local settings, execution checkpoints, and
        caches stay on this device.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await runtime.node.synchronize();
              const bytes = await exportWorkspace(runtime.node);
              download(
                "workspace.taskasaur",
                new Blob([new Uint8Array(bytes)], { type: "application/zip" }),
              );
              setNotice("Complete workspace archive saved.");
            })
          }
        >
          Export complete workspace
        </Button>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              for (const item of await runtime.node.protocol.storage.list())
                if (!item.deleted && !item.local)
                  await runtime.node.protocol.storage.setCopy(
                    item.item,
                    runtime.device.identity.id,
                    true,
                  );
              await runtime.node.synchronize();
              const missing = (
                await runtime.node.protocol.storage.list()
              ).filter((i) => !i.deleted && !i.local);
              setNotice(
                missing.length
                  ? `${missing.length} items still need an online peer before a complete export.`
                  : "All known workspace content is available locally.",
              );
            })
          }
        >
          Download all workspace content
        </Button>
        {(["file", "folder"] as const)
          .filter((kind) =>
            kind === "file"
              ? workspaceFileAvailable()
              : workspaceFolderAvailable(),
          )
          .map((kind) => (
            <Button
              key={kind}
              variant="outline"
              disabled={busy}
              onClick={async () => {
                let handle: WorkspaceLocation | undefined;
                let source: WorkspaceStorage | undefined;
                setBusy(true);
                setError("");
                try {
                  handle = await selectWorkspaceLocation(kind, true);
                  const snapshot = await workspaceSnapshot(runtime.node);
                  source = await WorkspaceStorage.create(
                    handle.files,
                    snapshot.workspace,
                    snapshot.entries,
                  );
                  await workspaceRouter.mount(
                    source,
                    true,
                    snapshot.excludedKeys,
                  );
                  await handle.remember(runtime.profile.workspaceId);
                  setNotice(
                    `Workspace writes now go directly to ${handle.label}. Keep the ${kind} available while the workspace is open.`,
                  );
                } catch (e) {
                  if (
                    !source ||
                    workspaceRouter.mounts.get(runtime.profile.workspaceId) !==
                      source
                  )
                    await handle?.files.close?.();
                  setError(String(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              Save and work from {kind}
            </Button>
          ))}
      </div>
      {!workspaceFolderAvailable() && !workspaceFileAvailable() && (
        <p className="text-xs text-muted-foreground">
          This platform stores the workspace locally in the app. Use archives to
          move it; direct file access is available where the platform provides
          it.
        </p>
      )}
      {notice && (
        <p role="status" className="text-sm">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
