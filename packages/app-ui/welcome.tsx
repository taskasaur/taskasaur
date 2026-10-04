import { useEffect, useState } from "react";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { Button } from "../ui/primitives/button";
import { Input } from "../ui/primitives/input";
import { ChoiceSelect } from "../ui/choice-select";
import {
  createLocalWorkspace,
  joinWorkspace,
  profiles,
  saveProfile,
  browserDevice,
  type WorkspaceProfile,
} from "./runtime";
import {
  OpenWorkspaceFile,
  WorkspaceFileOptionsFields,
  defaultWorkspaceFileOptions,
} from "./workspace-files";
import {
  restoreWorkspaceLocations,
  selectWorkspaceLocation,
  workspaceFileAvailable,
} from "../platform-browser/workspace-location";
import { workspaceRouter } from "../platform-browser/device";
import { WorkspaceStorage } from "../storage/workspace";
import { workspaceSnapshot } from "../core/workspace-package";
export const activeWorkspaceKey = "taskasaur.active-workspace";
export function Welcome({
  onOpen,
  error: externalError,
}: {
  onOpen(profile: WorkspaceProfile): Promise<void>;
  error: string;
}) {
  const [page, setPage] = useState<"create" | "join" | "open">(),
    [name, setName] = useState(""),
    [request, setRequest] = useState(""),
    [invitation, setInvitation] = useState(""),
    [saved, setSaved] = useState<WorkspaceProfile[]>([]),
    [options, setOptions] = useState(defaultWorkspaceFileOptions),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(externalError);
  useEffect(() => {
    setError(externalError);
  }, [externalError]);
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
  const descriptions = {
    create: "Create a workspace on this device or in a .taskasaur file.",
    join: "Send this device request to the workspace owner. In Devices, they can approve it and return an encrypted invitation for this device.",
    open: "Open an internal workspace or choose a .taskasaur file.",
  };
  async function choose(value: "create" | "join" | "open") {
    setError("");
    setPage(value);
    if (value === "open") {
      const files = new Set<string>();
      await restoreWorkspaceLocations(async (id) => {
        files.add(id);
      });
      setSaved(
        (await profiles()).filter(
          (profile) =>
            profile.storage !== "file" && !files.has(profile.workspaceId),
        ),
      );
    }
    if (value === "join") setRequest((await browserDevice()).pairingRequest());
  }
  async function createFile() {
    const selected = await selectWorkspaceLocation("file", true, {
      password: options.encrypted ? options.password : undefined,
    });
    let mounted = false;
    try {
      const profile = await createLocalWorkspace(
        selected.label.replace(/\.taskasaur$/i, ""),
      );
      const node = await (await browserDevice()).workspace(profile.workspaceId);
      const snapshot = await workspaceSnapshot(node, {
        includeCredentials: options.includeCredentials,
      });
      const source = await WorkspaceStorage.create(
        selected.files,
        snapshot.workspace,
        snapshot.entries,
        snapshot.connectionCredential,
      );
      await workspaceRouter.mount(source, true, snapshot.excludedKeys);
      mounted = true;
      await selected.remember(profile.workspaceId);
      profile.storage = "file";
      await saveProfile(profile);
      await onOpen(profile);
    } finally {
      if (!mounted) await selected.files.close?.();
    }
  }
  return (
    <main className="min-h-dvh flex items-center justify-center px-6 py-12">
      <div className="w-full max-w-xl space-y-8">
        {!page ? (
          <>
            <img
              src="/taskasaur_icon.png"
              alt="Taskasaur"
              className="mx-auto h-40 w-40 sm:h-48 sm:w-48 object-contain"
            />
            <p className="text-center text-muted-foreground">
              Your workspace lives on this device. Work offline and synchronize
              directly with your approved devices.
            </p>
            <div className="grid grid-cols-3 gap-3">
              {(["create", "join", "open"] as const).map((value) => (
                <Button
                  key={value}
                  variant={value === "create" ? "default" : "outline"}
                  disabled={busy}
                  onClick={() => void run(() => choose(value))}
                >
                  {value[0].toUpperCase() + value.slice(1)}
                </Button>
              ))}
            </div>
          </>
        ) : (
          <>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Back"
              disabled={busy}
              onClick={() => {
                setPage(undefined);
                setError("");
              }}
            >
              <ArrowLeft />
            </Button>
            <p className="text-muted-foreground">{descriptions[page]}</p>
            {page === "create" && (
              <div className="space-y-8">
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void run(async () =>
                      onOpen(await createLocalWorkspace(name.trim())),
                    );
                  }}
                >
                  <label className="field-row">
                    Internal workspace name
                    <div className="flex">
                      <Input
                        autoFocus
                        aria-label="Internal workspace name"
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                        className="rounded-r-none"
                        required
                      />
                      <Button
                        type="submit"
                        aria-label="Create internal workspace"
                        disabled={busy || !name.trim()}
                        className="rounded-l-none"
                      >
                        <ArrowRight />
                      </Button>
                    </div>
                  </label>
                </form>
                <div className="space-y-4">
                  <Button
                    variant="outline"
                    disabled={
                      busy ||
                      !workspaceFileAvailable() ||
                      (options.encrypted && options.password.length < 8)
                    }
                    onClick={() => void run(createFile)}
                  >
                    Create file workspace
                  </Button>
                  <WorkspaceFileOptionsFields
                    value={options}
                    onChange={setOptions}
                  />
                  {!workspaceFileAvailable() && (
                    <p className="text-xs text-muted-foreground">
                      Create an internal workspace here, then export a workspace
                      file from Settings.
                    </p>
                  )}
                </div>
              </div>
            )}
            {page === "join" && (
              <form
                className="space-y-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  void run(async () => onOpen(await joinWorkspace(invitation)));
                }}
              >
                <div className="grid gap-4 sm:grid-cols-2">
                  <label className="field-row">
                    Device request
                    <Input
                      readOnly
                      value={request}
                      onFocus={(event) => event.target.select()}
                    />
                  </label>
                  <label className="field-row">
                    Workspace invitation
                    <Input
                      value={invitation}
                      onChange={(event) => setInvitation(event.target.value)}
                      autoComplete="off"
                    />
                  </label>
                </div>
                <Button type="submit" disabled={busy || !invitation}>
                  Join workspace
                </Button>
              </form>
            )}
            {page === "open" && (
              <div className="space-y-6">
                <label className="field-row">
                  Open internal workspace
                  <ChoiceSelect
                    value=""
                    aria-label="Open internal workspace"
                    placeholder={
                      saved.length
                        ? "Choose a workspace"
                        : "No internal workspaces"
                    }
                    disabled={busy || !saved.length}
                    options={saved.map((profile) => ({
                      value: profile.id,
                      label: profile.name,
                    }))}
                    onValueChange={(id) => {
                      const profile = saved.find((item) => item.id === id);
                      if (profile) void run(() => onOpen(profile));
                    }}
                  />
                </label>
                <OpenWorkspaceFile onOpen={onOpen} />
              </div>
            )}
          </>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </div>
    </main>
  );
}
