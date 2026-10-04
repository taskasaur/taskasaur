import { StoragePlacementView } from "./storage-placement";
("use client");

import {
  useEffect,
  useState,
  useMemo,
  useSyncExternalStore,
  Component,
  type ReactNode,
  lazy,
  Suspense,
} from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { ThemeProvider, useTheme } from "next-themes";
import { ArrowLeft } from "lucide-react";
import { AppRuntime, profiles, type WorkspaceProfile } from "./runtime";
import { RecordTable } from "./record-table";
import { getSchema } from "@taskasaur/platform/core/catalog";
import { WorkspaceNavigation } from "./workspace-navigation";
import { pluginNavigation, pageRoute, resolveNavigation } from "./navigation";
import {
  CollectionTablePicker,
  CollectionTableSettings,
} from "./collection-table-settings";
import { tableSelectionKey } from "./collection-tables";
import { ChoiceSelect } from "../ui/choice-select";
import { ReferenceOptionsContext, FieldInput } from "../ui/fields";
import { field } from "@taskasaur/platform/field-types";
import { SyncConflicts } from "./sync-conflicts";
import { Welcome, activeWorkspaceKey } from "./welcome";
import { useWorkspacePassword } from "./workspace-password";
import { WorkspaceFileSettings } from "./workspace-files";
import { catalog, isRequiredCore } from "@taskasaur/platform/core/catalog";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "../ui/primitives/dialog";
import type { InventoryEntry } from "@taskasaur/platform/plugin-sdk/inventory";
import { Button } from "../ui/primitives/button";
import { Input } from "../ui/primitives/input";
import { Badge } from "../ui/primitives/badge";
import {
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
} from "../ui/primitives/table";
import {
  FilesView,
  CredentialsView,
  TablesView,
  DevicesView,
} from "./storage-views";
export default function Application() {
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
      <WorkspaceApp />
    </ThemeProvider>
  );
}
function WorkspaceApp() {
  const { requestPassword, dialog } = useWorkspacePassword();
  const [runtime, setRuntime] = useState<AppRuntime | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState("");
  useEffect(() => {
    let disposed = false;
    let current: AppRuntime | undefined;
    void (async () => {
      try {
        const saved = await profiles();
        if (disposed) return;
        const selected = saved.find(
          (profile) => profile.id === localStorage.getItem(activeWorkspaceKey),
        );
        if (selected) {
          current = new AppRuntime(selected);
          await current.initialize(requestPassword);
          if (disposed) await current.close();
          else setRuntime(current);
        }
      } catch (e) {
        await current?.close().catch(() => {});
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!disposed) setLoading(false);
      }
    })();
    return () => {
      disposed = true;
      void current?.close();
    };
  }, []);
  async function open(profile: WorkspaceProfile) {
    const next = new AppRuntime(profile);
    try {
      await runtime?.close();
      await next.initialize(requestPassword);
      localStorage.setItem(activeWorkspaceKey, profile.id);
      location.hash = "";
      setRuntime(next);
      setError("");
    } catch (e) {
      await next.close().catch(() => {});
      setError(e instanceof Error ? e.message : String(e));
      throw e;
    }
  }
  if (loading)
    return (
      <>
        <div className="boot-screen">Opening your workspace…</div>
        {dialog}
      </>
    );
  if (!runtime)
    return (
      <>
        <Welcome onOpen={open} error={error} />
        {dialog}
      </>
    );
  return (
    <Shell
      key={runtime.profile.id}
      runtime={runtime}
      onSwitch={() => {
        localStorage.removeItem(activeWorkspaceKey);
        location.hash = "";
        setLoading(true);
        void runtime
          .close()
          .catch((error) => setError(String(error)))
          .finally(() => {
            setRuntime(null);
            setLoading(false);
          });
      }}
    />
  );
}
function Shell({
  runtime,
  onSwitch,
}: {
  runtime: AppRuntime;
  onSwitch: () => void;
}) {
  const referenceRecords =
    useLiveQuery(
      () => runtime.db.records.filter((r) => !r.deletedAt).toArray(),
      [runtime],
    ) ?? [];
  const version = useSyncExternalStore(
    (listener) => {
      runtime.surfaceListeners.add(listener);
      return () => {
        runtime.surfaceListeners.delete(listener);
      };
    },
    () => runtime.surfacesVersion,
    () => 0,
  );
  const states = useLiveQuery(() => runtime.db.plugins.toArray(), [runtime]);
  const entries = useMemo(
    () => pluginNavigation(runtime),
    [runtime, version, states],
  );
  const pending = useLiveQuery(() => runtime.db.outbox.count(), [runtime]) ?? 0;
  const [view, setView] = useState(() => location.hash.slice(1) || "plugins"),
    [error, setError] = useState(""),
    [syncing, setSyncing] = useState(false),
    [online, setOnline] = useState(navigator.onLine);
  const referenceOptions = useMemo(() => {
    const result: Record<string, Array<{ id: string; label: string }>> = {
      resources: [],
    };
    for (const record of referenceRecords) {
      const option = {
        id: record.id,
        label: String(
          record.data.title ??
            record.data.name ??
            record.data.subject ??
            record.data.summary ??
            record.id,
        ),
      };
      (result[record.collection] ??= []).push(option);
      if (record.collection !== "credentials") result.resources.push(option);
    }
    return result;
  }, [referenceRecords]);
  function navigate(route: string) {
    location.hash = route;
    setView(route);
  }
  useEffect(() => {
    const hash = () => setView(location.hash.slice(1) || "plugins"),
      network = () => setOnline(navigator.onLine);
    window.addEventListener("hashchange", hash);
    window.addEventListener("online", network);
    window.addEventListener("offline", network);
    return () => {
      window.removeEventListener("hashchange", hash);
      window.removeEventListener("online", network);
      window.removeEventListener("offline", network);
    };
  }, []);
  useEffect(() => {
    runtime.navigate = async (pluginId, pageId, recordId) => {
      try {
        const record = recordId
          ? await runtime.db.records.get(recordId)
          : undefined;
        const plugin =
          entries.find((p) => p.id === pluginId) ??
          (record && entries.find((p) => p.id === record.pluginId));
        if (!plugin) throw Error("Enable this plugin to open its content");
        const page = pageId
          ? (plugin.pages.find((p) => p.id === pageId) ?? plugin.main)
          : record
            ? ([plugin.main, ...plugin.pages].find(
                (p) => p.collection === record.collection && !p.columns,
              ) ?? plugin.main)
            : plugin.main;
        if (
          record &&
          getSchema(record.collection).tables &&
          record.data.table_id
        )
          await runtime.db.setMetadata(
            tableSelectionKey(record.collection),
            record.data.table_id,
          );
        else if (record && getSchema(record.collection).tables)
          await runtime.db.metadata.delete(
            tableSelectionKey(record.collection),
          );
        navigate(
          pageRoute(plugin, page) +
            (recordId ? "?record=" + encodeURIComponent(recordId) : ""),
        );
      } catch (e) {
        setError(String(e));
      }
    };
    return () => {
      runtime.navigate = () => {};
    };
  }, [runtime, entries]);
  const synchronize = async () => {
    setSyncing(true);
    try {
      await runtime.synchronize();
      setError("");
    } catch (e) {
      setError(String(e));
    } finally {
      setSyncing(false);
    }
  };
  useEffect(() => {
    if (!runtime.profile.connected) return;
    const sync = () =>
      void runtime.synchronize().catch((e) => setError(e.message));
    sync();
    const timer = setInterval(sync, 15000);
    return () => clearInterval(timer);
  }, [runtime, online]);
  const { plugin, page } = resolveNavigation(entries, view);
  let content: ReactNode;
  const id = plugin?.id;
  if (!plugin || !page || plugin.enabled === false)
    content = (
      <div className="empty-state">
        <h3>This page is not available</h3>
        <p>Enable the plugin to open its pages.</p>
        <Button onClick={() => navigate("plugins")}>Open Plugins</Button>
      </div>
    );
  else if (id === "plugins") content = <PluginsView runtime={runtime} />;
  else if (id === "settings" && page.id === "storage")
    content = (
      <StoragePlacementView
        runtime={runtime}
        itemKey={
          new URLSearchParams(view.split("?")[1]).get("item") ?? undefined
        }
      />
    );
  else if (id === "settings")
    content = <SettingsView runtime={runtime} onSwitch={onSwitch} />;
  else if (id === "files") content = <FilesView runtime={runtime} />;
  else if (id === "credentials")
    content = <CredentialsView runtime={runtime} />;
  else if (id === "tables") content = <TablesView runtime={runtime} />;
  else if (id === "devices") content = <DevicesView runtime={runtime} />;
  else if (id === "jobs")
    content = (
      <RecordTable
        runtime={runtime}
        collection="jobs"
        readOnly
        renderActions={(row) =>
          ["queued", "running", "waiting"].includes(String(row.data.status)) ? (
            <Button
              size="sm"
              variant="outline"
              onClick={async () => {
                await runtime.api("jobs/cancel", { id: row.id });
                await runtime.synchronize();
              }}
            >
              Cancel
            </Button>
          ) : null
        }
      />
    );
  else if (page.columns && page.collection)
    content = (
      <CollectionTableSettings
        key={page.collection}
        runtime={runtime}
        collection={page.collection}
      />
    );
  else if (page.surface && runtime.surfaces.has(page.surface)) {
    const Surface = runtime.surfaces.get(page.surface)!.render;
    content = (
      <PluginBoundary key={page.surface}>
        <Surface />
      </PluginBoundary>
    );
  } else if (page.collection)
    content = (
      <RecordTable
        key={page.collection}
        runtime={runtime}
        collection={page.collection}
        readOnly={page.readOnly}
        managedAccess={id}
      />
    );
  else if (id && isRequiredCore(id))
    content = <RecordTable runtime={runtime} collection={id} />;
  else
    content = (
      <p className="text-sm text-muted-foreground">
        This plugin provides commands and background services.
      </p>
    );
  return (
    <WorkspaceNavigation
      runtime={runtime}
      entries={entries}
      view={view}
      navigate={navigate}
      pending={pending}
      online={online}
      syncing={syncing}
      synchronize={synchronize}
    >
      {error && (
        <div role="alert" className="error-banner mb-4">
          {error}
          <Button variant="ghost" onClick={() => setError("")}>
            Dismiss
          </Button>
        </div>
      )}
      <Suspense
        fallback={
          <div className="empty-state">
            Opening {plugin?.label ?? "plugin"}…
          </div>
        }
      >
        <ReferenceOptionsContext.Provider value={referenceOptions}>
          {page?.collection && getSchema(page.collection).tables && (
            <CollectionTablePicker
              key={page.collection}
              runtime={runtime}
              collection={page.collection}
            />
          )}
          {content}
        </ReferenceOptionsContext.Provider>
      </Suspense>
    </WorkspaceNavigation>
  );
}
class PluginBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <div role="alert" className="error-banner">
        This plugin view failed. Its saved data is retained. Disable or update
        the plugin from Plugins.
      </div>
    ) : (
      this.props.children
    );
  }
}
type ReviewEntry = Omit<InventoryEntry, "downloadUrl"> & {
  downloadUrl?: string;
};
function PluginsView({ runtime }: { runtime: AppRuntime }) {
  const [review, setReview] = useState<{
    id: string;
    entries: ReviewEntry[];
  } | null>(null);
  function reviewInstall(id: string) {
    try {
      const pending: ReviewEntry[] = [],
        visiting = new Set<string>(),
        seen = new Set<string>();
      const collect = (id: string) => {
        if (isRequiredCore(id) || seen.has(id)) return;
        if (visiting.has(id))
          throw Error("Plugin dependencies contain a cycle");
        visiting.add(id);
        const installed = runtime.installedPackage(id);
        const entry: ReviewEntry | undefined =
          runtime.availablePlugins.find((p) => p.id === id) ??
          (installed
            ? {
                ...installed.manifest,
                sha256: installed.digest,
                grants: installed.grants,
                tags: [],
                platforms: [],
              }
            : undefined);
        if (!entry)
          throw Error(
            "Refresh the inventory to review this plugin before installing it",
          );
        if (entry) {
          for (const dep of entry.dependencies)
            if (!runtime.registry.enabled(dep)) collect(dep);
          pending.push(structuredClone(entry));
        }
        visiting.delete(id);
        seen.add(id);
      };
      collect(id);
      if (pending.length) setReview({ id, entries: pending });
      else throw Error("No reviewed plugin package is available");
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  }
  const states =
    useLiveQuery(() => runtime.db.plugins.toArray(), [runtime]) ?? [];
  const [busy, setBusy] = useState(""),
    [error, setError] = useState("");
  const entries = new Map(
    runtime.availablePlugins.map((entry) => [entry.id, entry]),
  );
  const displayed = new Map(
    [...runtime.registry.manifests.values()].map((plugin) => [
      plugin.id,
      plugin,
    ]),
  );
  for (const entry of runtime.availablePlugins)
    if (!displayed.has(entry.id))
      displayed.set(entry.id, { ...entry, features: {} } as never);
  const plugins = [...displayed.values()];
  async function action(
    id: string,
    kind: "install" | "disable" | "enable" | "uninstall",
    reviewed?: ReviewEntry[],
  ) {
    setBusy(id);
    try {
      if (kind === "install")
        await runtime.installAndEnable(
          id,
          new Set(),
          new Map(reviewed?.map((entry) => [entry.id, entry.sha256])),
        );
      else await runtime.pluginAction(id, kind);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  }
  return (
    <div className="space-y-8">
      <p className="page-description">
        Choose the tools for your workspace. Shared storage, credentials, and
        platform services are always available.
      </p>
      {error && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}
      {runtime.inventoryError && (
        <p role="status" className="text-sm text-muted-foreground">
          {runtime.inventoryError} Installed plugins remain available.
        </p>
      )}
      <Button variant="outline" onClick={() => void runtime.refreshInventory()}>
        Refresh inventory
      </Button>
      <Dialog
        open={Boolean(review)}
        onOpenChange={(open) => {
          if (!busy && !open) setReview(null);
        }}
      >
        <DialogContent className="max-h-[85vh] overflow-auto">
          <DialogHeader>
            <DialogTitle>Review plugin installation</DialogTitle>
            <DialogDescription>
              Review the publisher and capabilities for these packages. Optional
              features remain off until enabled.
            </DialogDescription>
          </DialogHeader>
          {review?.entries.map((entry) => (
            <section key={entry.id} className="space-y-2 border rounded-lg p-3">
              <h3 className="font-medium">
                {entry.name} · {entry.version}
              </h3>
              <p>{entry.description}</p>
              <p className="text-sm">
                {entry.publisher} · {entry.license}
              </p>
              {entry.downloadUrl ? (
                <a
                  className="text-xs underline break-all"
                  href={entry.downloadUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  {entry.downloadUrl}
                </a>
              ) : (
                <p className="text-sm">
                  Already downloaded and verified by core.
                </p>
              )}
              <p className="text-sm break-words">
                Capabilities: {entry.grants.join(", ") || "None"}
              </p>
              {entry.grants.includes("core.server") && (
                <p className="text-sm">
                  Includes native code. Enable it only on computers you choose
                  in Devices.
                </p>
              )}
            </section>
          ))}
          <Button
            disabled={Boolean(busy)}
            onClick={() => {
              if (!review) return;
              if (
                review.entries.some(
                  (entry) =>
                    (runtime.availablePlugins.find((p) => p.id === entry.id)
                      ?.sha256 ??
                      runtime.installedPackage(entry.id)?.digest) !==
                    entry.sha256,
                )
              ) {
                setError("The inventory changed. Review this release again.");
                setReview(null);
                return;
              }
              void action(review.id, "install", review.entries).then(() =>
                setReview(null),
              );
            }}
          >
            {busy ? "Installing…" : "Confirm install"}
          </Button>
        </DialogContent>
      </Dialog>
      {[false, true].map((required) => (
        <section key={String(required)}>
          <div className="section-heading">
            <h2>{required ? "Required core" : "Optional features"}</h2>
            <span>
              {plugins.filter((p) => isRequiredCore(p.id) === required).length}{" "}
              plugins
            </span>
          </div>
          <div className="border rounded-xl overflow-hidden bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Plugin</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Version</TableHead>
                  <TableHead className="text-right">Manage</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {plugins
                  .filter((p) => isRequiredCore(p.id) === required)
                  .map((plugin) => {
                    const state = states.find((s) => s.id === plugin.id);
                    return (
                      <TableRow key={plugin.id}>
                        <TableCell>
                          <div className="font-medium">{plugin.name}</div>
                          <div className="text-xs text-muted-foreground mt-1 whitespace-normal max-w-lg">
                            {plugin.description}
                          </div>
                          {!required && entries.get(plugin.id) && (
                            <details className="mt-2 text-xs">
                              <summary>Package details and permissions</summary>
                              <p className="mt-2">
                                Publisher: {plugin.publisher} · {plugin.license}
                              </p>
                              <p className="break-all">
                                Download:{" "}
                                <a
                                  className="underline"
                                  href={entries.get(plugin.id)!.downloadUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  {entries.get(plugin.id)!.downloadUrl}
                                </a>
                              </p>
                              <p>
                                Dependencies:{" "}
                                {entries
                                  .get(plugin.id)!
                                  .dependencies.join(", ") || "Core only"}
                              </p>
                              <p>
                                Installing grants:{" "}
                                {entries.get(plugin.id)!.grants.join(", ")}
                              </p>
                              {entries.get(plugin.id)!.documentationUrl && (
                                <a
                                  className="underline"
                                  href={
                                    entries.get(plugin.id)!.documentationUrl
                                  }
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  Documentation
                                </a>
                              )}
                            </details>
                          )}
                          {state?.error && (
                            <p
                              className="text-xs text-destructive mt-2"
                              role="status"
                            >
                              This plugin could not start ({state.error}).
                              Disable and enable it to retry; other plugins
                              remain available.
                            </p>
                          )}
                          {state?.installed &&
                            Object.keys(plugin.features).length > 0 && (
                              <div className="flex flex-wrap gap-4 mt-3">
                                {Object.keys(plugin.features).map((feature) => (
                                  <label
                                    key={feature}
                                    className="flex items-center gap-2 text-xs"
                                  >
                                    <FieldInput
                                      definition={field(
                                        feature
                                          .replace(/([A-Z])/g, "_$1")
                                          .toLowerCase(),
                                        feature.replace(/([A-Z])/g, " $1"),
                                        "boolean",
                                        { nullable: false },
                                      )}
                                      value={state.features.includes(feature)}
                                      disabled={busy === plugin.id}
                                      onChange={async (value) => {
                                        setBusy(plugin.id);
                                        try {
                                          await runtime.configurePlugin(
                                            plugin.id,
                                            value
                                              ? [...state.features, feature]
                                              : state.features.filter(
                                                  (f) => f !== feature,
                                                ),
                                          );
                                        } catch (e) {
                                          setError(
                                            e instanceof Error
                                              ? e.message
                                              : String(e),
                                          );
                                        } finally {
                                          setBusy("");
                                        }
                                      }}
                                    />
                                    {feature.replace(/([A-Z])/g, " $1")}
                                  </label>
                                ))}
                              </div>
                            )}
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant={state?.enabled ? "secondary" : "outline"}
                          >
                            {required
                              ? "Required"
                              : state?.enabled
                                ? "Enabled"
                                : state?.installed
                                  ? "Disabled"
                                  : "Not installed"}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-muted-foreground text-xs">
                          {plugin.version}
                        </TableCell>
                        <TableCell>
                          <div className="flex gap-2 justify-end">
                            {required ? (
                              <span className="text-xs text-muted-foreground">
                                Managed by core
                              </span>
                            ) : !state?.installed ? (
                              <Button
                                size="sm"
                                disabled={busy === plugin.id}
                                onClick={() => reviewInstall(plugin.id)}
                              >
                                Install
                              </Button>
                            ) : (
                              <>
                                {entries.get(plugin.id) &&
                                  (entries.get(plugin.id)!.version !==
                                    state.version ||
                                    !runtime.registry.manifests.has(
                                      plugin.id,
                                    )) && (
                                    <Button
                                      size="sm"
                                      disabled={busy === plugin.id}
                                      onClick={() => reviewInstall(plugin.id)}
                                    >
                                      Update
                                    </Button>
                                  )}
                                <Button
                                  size="sm"
                                  variant="outline"
                                  disabled={busy === plugin.id}
                                  onClick={() =>
                                    void action(
                                      plugin.id,
                                      state.enabled ? "disable" : "enable",
                                    )
                                  }
                                >
                                  {state.enabled ? "Disable" : "Enable"}
                                </Button>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  disabled={busy === plugin.id}
                                  onClick={() =>
                                    void action(plugin.id, "uninstall")
                                  }
                                >
                                  Uninstall
                                </Button>
                              </>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
              </TableBody>
            </Table>
          </div>
        </section>
      ))}
    </div>
  );
}
function SettingsView({
  runtime,
  onSwitch,
}: {
  runtime: AppRuntime;
  onSwitch: () => void;
}) {
  const [error, setError] = useState("");
  const { theme, setTheme } = useTheme();
  return (
    <div className="space-y-6">
      <section className="settings-card">
        <h2>Appearance</h2>
        <label className="field-row mt-3">
          Color theme
          <ChoiceSelect
            aria-label="Color theme"
            value={theme ?? "system"}
            options={[
              { value: "system", label: "Use device setting" },
              { value: "light", label: "Light" },
              { value: "dark", label: "Dark" },
            ]}
            onValueChange={setTheme}
          />
        </label>
      </section>
      <section className="settings-card">
        <h2>Workspace</h2>
        <Button
          variant="outline"
          className="my-3"
          onClick={() => {
            location.hash = "settings:storage";
          }}
        >
          Manage storage copies
        </Button>
        <p>{runtime.profile.name}</p>
        <p className="text-muted-foreground text-sm">
          Choose which approved devices keep each item. Changes synchronize
          between the devices keeping a copy.
        </p>
        <div className="flex flex-col items-start gap-3 mt-4">
          <WorkspaceFileSettings runtime={runtime} />
          <Button variant="ghost" onClick={onSwitch}>
            <ArrowLeft size={14} />
            Switch workspace
          </Button>
        </div>
      </section>
      {error && <p role="alert">{error}</p>}
      <SyncConflicts runtime={runtime} />
      <RecordTable runtime={runtime} collection="settings" />
    </div>
  );
}
