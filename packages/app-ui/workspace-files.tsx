import { useEffect, useRef, useState } from "react";
import { Button } from "../ui/primitives/button";
import { Input } from "../ui/primitives/input";
import { Switch } from "../ui/primitives/switch";
import { useWorkspacePassword, passwordRequired } from "./workspace-password";
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
  validateWorkspaceHistory,
} from "../core/workspace-package";
import {
  profileForNode,
  saveProfile,
  type AppRuntime,
  type WorkspaceProfile,
} from "./runtime";
import { download } from "./download";

export interface WorkspaceFileOptions {
  encrypted: boolean;
  password: string;
  includeCredentials: boolean;
}
export const defaultWorkspaceFileOptions: WorkspaceFileOptions = {
  encrypted: false,
  password: "",
  includeCredentials: false,
};
export function WorkspaceFileOptionsFields({
  value,
  onChange,
}: {
  value: WorkspaceFileOptions;
  onChange(value: WorkspaceFileOptions): void;
}) {
  return (
    <div className="space-y-3 text-sm">
      <div className="flex items-center gap-2">
        <Switch
          aria-label="Encrypt workspace file"
          checked={value.encrypted}
          onCheckedChange={(encrypted) => onChange({ ...value, encrypted })}
        />
        <span>Encrypt workspace file</span>
      </div>
      {value.encrypted && (
        <Input
          type="password"
          autoComplete="new-password"
          aria-label="New workspace password"
          placeholder="Workspace password (at least 8 characters)"
          value={value.password}
          onChange={(event) =>
            onChange({ ...value, password: event.target.value })
          }
        />
      )}
      <div className="flex items-center gap-2">
        <Switch
          aria-label="Include credentials"
          checked={value.includeCredentials}
          onCheckedChange={(includeCredentials) =>
            onChange({ ...value, includeCredentials })
          }
        />
        <span>Include credentials</span>
      </div>
      {value.includeCredentials && (
        <p className="text-xs text-muted-foreground">
          Includes plugin credentials and access to reconnect. Anyone who can
          open this file can use that access.
        </p>
      )}
    </div>
  );
}
export function OpenWorkspaceFile({
  onOpen,
}: {
  onOpen(profile: WorkspaceProfile): Promise<void>;
}) {
  const [source, setSource] = useState<WorkspaceStorage>(),
    [location, setLocation] = useState<WorkspaceLocation>(),
    [request, setRequest] = useState(""),
    [invitation, setInvitation] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null),
    pending = useRef<WorkspaceStorage | undefined>(undefined);
  const { requestPassword, dialog } = useWorkspacePassword();
  async function discard(value: WorkspaceStorage) {
    if (workspaceRouter?.mounts.get(value.manifest.workspace.id) === value)
      await (await browserDevice()).closeWorkspace(value.manifest.workspace.id);
    else await value.close();
  }
  useEffect(
    () => () => {
      const value = pending.current;
      pending.current = undefined;
      if (value) void discard(value).catch(() => {});
    },
    [],
  );
  async function open(
    value: WorkspaceStorage,
    selected?: WorkspaceLocation,
    approval?: string,
  ) {
    await validateWorkspaceHistory(value.manifest.workspace);
    const device = await browserDevice();
    if (selected && workspaceRouter.blocked.has(value.manifest.workspace.id))
      await workspaceRouter.mount(value, false);
    const node = await importWorkspace(device, value, approval);
    if (selected) {
      const snapshot = await workspaceSnapshot(node);
      await workspaceRouter.mount(value, true, snapshot.excludedKeys);
      await selected.remember(node.replica.workspaceId);
    }
    const profile = await profileForNode(node);
    profile.storage = selected ? "file" : "internal";
    await saveProfile(profile);
    pending.current = undefined;
    try {
      await onOpen(profile);
    } catch (error) {
      pending.current = value;
      throw error;
    }
  }
  async function load(value: WorkspaceStorage, selected?: WorkspaceLocation) {
    if (pending.current && pending.current !== value)
      await discard(pending.current);
    pending.current = value;
    setSource(value);
    setLocation(selected);
    setInvitation("");
    setError("");
    try {
      await open(value, selected);
    } catch (error) {
      if ((error as { kind?: string }).kind !== "APPROVAL_REQUIRED")
        throw error;
      setRequest((await browserDevice()).pairingRequest());
    }
  }
  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-4">
      <Button
        variant="outline"
        disabled={busy}
        onClick={() => {
          if (!workspaceFileAvailable()) {
            input.current?.click();
            return;
          }
          void run(async () => {
            const selected = await selectWorkspaceLocation("file", false, {
              requestPassword,
            });
            try {
              await load(await WorkspaceStorage.open(selected.files), selected);
            } catch (error) {
              if (
                workspaceRouter?.mounts.get(
                  pending.current?.manifest.workspace.id ?? "",
                ) !== pending.current
              )
                await selected.files.close?.();
              throw error;
            }
          });
        }}
      >
        Open file workspace
      </Button>
      <Input
        ref={input}
        className="hidden"
        aria-label="Workspace archive"
        type="file"
        accept=".taskasaur,.zip"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file)
            void run(async () => {
              const bytes = new Uint8Array(await file.arrayBuffer());
              let password: string | undefined;
              for (;;) {
                try {
                  await load(await openWorkspaceArchive(bytes, password));
                  return;
                } catch (error) {
                  if (!passwordRequired(error)) throw error;
                  password = await requestPassword();
                }
              }
            });
        }}
      />
      {source && request && (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Send this device request to the workspace owner. In Devices, they
            can approve it and return an encrypted invitation for this device.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="field-row">
              Device request
              <Input
                aria-label="Workspace file device request"
                readOnly
                value={request}
                onFocus={(event) => event.target.select()}
              />
            </label>
            <label className="field-row">
              Workspace invitation
              <Input
                aria-label="Workspace file approval"
                value={invitation}
                onChange={(event) => setInvitation(event.target.value)}
              />
            </label>
          </div>
          <Button
            disabled={busy || !invitation}
            onClick={() => void run(() => open(source, location, invitation))}
          >
            Open workspace
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {dialog}
    </div>
  );
}
export function WorkspaceFileSettings({ runtime }: { runtime: AppRuntime }) {
  const [options, setOptions] = useState(defaultWorkspaceFileOptions);
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
      <WorkspaceFileOptionsFields value={options} onChange={setOptions} />
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          disabled={busy || (options.encrypted && options.password.length < 8)}
          onClick={() =>
            void run(async () => {
              await runtime.node.synchronize();
              const bytes = await exportWorkspace(runtime.node, {
                includeCredentials: options.includeCredentials,
                password: options.encrypted ? options.password : undefined,
              });
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
        {(["file"] as const)
          .filter((kind) =>
            kind === "file"
              ? workspaceFileAvailable()
              : workspaceFolderAvailable(),
          )
          .map((kind) => (
            <Button
              key={kind}
              variant="outline"
              disabled={
                busy || (options.encrypted && options.password.length < 8)
              }
              onClick={async () => {
                let handle: WorkspaceLocation | undefined;
                let source: WorkspaceStorage | undefined;
                setBusy(true);
                setError("");
                try {
                  handle = await selectWorkspaceLocation(kind, true, {
                    password: options.encrypted ? options.password : undefined,
                  });
                  const snapshot = await workspaceSnapshot(runtime.node, {
                    includeCredentials: options.includeCredentials,
                  });
                  source = await WorkspaceStorage.create(
                    handle.files,
                    snapshot.workspace,
                    snapshot.entries,
                    snapshot.connectionCredential,
                  );
                  await workspaceRouter.mount(
                    source,
                    true,
                    snapshot.excludedKeys,
                  );
                  await handle.remember(runtime.profile.workspaceId);
                  runtime.profile.storage = "file";
                  await saveProfile(runtime.profile);
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
