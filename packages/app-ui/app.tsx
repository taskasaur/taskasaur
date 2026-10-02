"use client";
import { serverFetch } from "./network";
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
import {
  CheckSquare,
  Clock3,
  Activity,
  CalendarDays,
  Bell,
  Mail,
  Workflow,
  Terminal,
  FileText,
  Folder,
  KeyRound,
  Table2,
  Braces,
  Settings,
  Blocks,
  Monitor,
  Cloud,
  CloudOff,
  RefreshCw,
  Menu,
  Moon,
  Sun,
  ArrowLeft,
} from "lucide-react";
import {
  AppRuntime,
  createLocalWorkspace,
  profiles,
  saveProfile,
  type WorkspaceProfile,
} from "./runtime";
import { RecordTable } from "./record-table";
import { ReferenceOptionsContext, FieldInput } from "../ui/fields";
import { field } from "../field-types";
import { SharingView } from "./sharing-view";
import { SyncConflicts } from "./sync-conflicts";
import {
  TasksView,
  TimeView,
  CalendarView,
  RemindersView,
  download,
} from "./productivity";
import { catalog, isRequiredCore } from "../core/catalog";
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
const EmailView = lazy(() => import("./email-view"));
const AutomationView = lazy(() => import("./automation-view"));
const OfficeView = lazy(() => import("./office-view"));
const TerminalView = lazy(() => import("./terminal-view"));
const GithubView = lazy(() => import("./github-view"));
const navigation = [
  { id: "tasks", label: "Tasks", icon: CheckSquare },
  { id: "track", label: "Track", icon: Activity },
  { id: "time", label: "Time", icon: Clock3 },
  { id: "calendar", label: "Calendar", icon: CalendarDays },
  { id: "reminders", label: "Reminders", icon: Bell },
  { id: "email-client", label: "Mail", icon: Mail },
  { id: "automation-editor", label: "Automations", icon: Workflow },
  { id: "remote-terminal", label: "Terminal", icon: Terminal },
  { id: "office-editor", label: "Office", icon: FileText },
  { id: "files", label: "Files", icon: Folder },
  { id: "tables", label: "Tables", icon: Table2 },
  { id: "variables", label: "Variables", icon: Braces },
  { id: "credentials", label: "Credentials", icon: KeyRound },
  { id: "devices", label: "Devices", icon: Monitor },
  { id: "notifications", label: "Notifications", icon: Bell },
  { id: "sharing", label: "Sharing", icon: Cloud },
  { id: "connector-github", label: "GitHub", icon: Blocks },
  { id: "jobs", label: "Jobs", icon: Workflow },
];
export default function Application() {
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
      <WorkspaceApp />
    </ThemeProvider>
  );
}
function WorkspaceApp() {
  const [runtime, setRuntime] = useState<AppRuntime | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState("");
  useEffect(() => {
    let disposed = false;
    let current: AppRuntime | undefined;
    void (async () => {
      try {
        const saved = await profiles();
        if (saved[0]) {
          current = await new AppRuntime(saved[0]).initialize();
          if (!disposed) setRuntime(current);
        }
      } catch (e) {
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
    try {
      await runtime?.close();
      const next = await new AppRuntime(profile).initialize();
      setRuntime(next);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }
  if (loading)
    return <div className="boot-screen">Opening your workspace…</div>;
  if (!runtime) return <Welcome onOpen={open} error={error} />;
  return (
    <Shell
      key={runtime.profile.id}
      runtime={runtime}
      onSwitch={() => {
        void runtime.close();
        setRuntime(null);
      }}
    />
  );
}
function Welcome({
  onOpen,
  error: externalError,
}: {
  onOpen: (profile: WorkspaceProfile) => Promise<void>;
  error: string;
}) {
  const [name, setName] = useState("My workspace"),
    [server, setServer] = useState(""),
    [email, setEmail] = useState(""),
    [password, setPassword] = useState(""),
    [error, setError] = useState(externalError),
    [busy, setBusy] = useState(false),
    [connect, setConnect] = useState(false);
  async function create() {
    setBusy(true);
    try {
      await onOpen(await createLocalWorkspace(name || "My workspace"));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  async function signIn(signup = false) {
    setBusy(true);
    setError("");
    try {
      const base = server || location.origin;
      const result = await serverFetch(
        new URL(`/api/auth/${signup ? "signup" : "login"}`, base),
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password }),
        },
      );
      const auth = await result.json();
      if (!result.ok) throw new Error(auth.error?.message ?? "Sign-in failed");
      if (auth.confirmationRequired) {
        setError("Check your email to confirm your account, then sign in.");
        return;
      }
      const response = await serverFetch(new URL("/api/workspaces", base), {
        credentials: "include",
      });
      const workspaces = await response.json();
      if (!response.ok)
        throw new Error(
          workspaces.error?.message ?? "Could not load workspaces",
        );
      let workspace = workspaces.workspaces[0];
      if (!workspace) {
        const created = await serverFetch(new URL("/api/workspaces", base), {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name }),
        });
        workspace = await created.json();
        if (!created.ok)
          throw new Error(
            workspace.error?.message ?? "Could not create workspace",
          );
      }
      const profile: WorkspaceProfile = {
        id: workspace.id,
        userId: auth.user.id,
        workspaceId: workspace.id,
        name: workspace.name ?? name,
        serverUrl: base,
        connected: true,
      };
      await saveProfile(profile);
      await onOpen(profile);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPassword("");
      setBusy(false);
    }
  }
  return (
    <main className="welcome-shell">
      <div className="welcome-card">
        <img src="/taskasaur_icon.png" width="52" height="52" alt="Taskasaur" />
        <p className="eyebrow mt-6">YOUR WORK, TOGETHER</p>
        <h1>
          A workspace that
          <br />
          goes with you.
        </h1>
        <p className="text-muted-foreground my-5">
          Tasks, time, files, and the tools you choose. Start on this device, or
          connect to your Taskasaur server.
        </p>
        <label className="field-row">
          Workspace name
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        {connect ? (
          <div className="space-y-3 mt-4">
            <label className="field-row">
              Server URL
              <Input
                placeholder={
                  typeof location === "undefined"
                    ? "https://taskasaur.example"
                    : location.origin
                }
                value={server}
                onChange={(e) => setServer(e.target.value)}
              />
            </label>
            <label className="field-row">
              Email
              <Input
                type="email"
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </label>
            <label className="field-row">
              Password
              <Input
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            <div className="flex gap-2">
              <Button disabled={busy} onClick={() => void signIn()}>
                Sign in
              </Button>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => void signIn(true)}
              >
                Create account
              </Button>
            </div>
            <Button variant="ghost" onClick={() => setConnect(false)}>
              Work on this device instead
            </Button>
          </div>
        ) : (
          <div className="flex gap-3 mt-6">
            <Button disabled={busy} onClick={() => void create()}>
              Create local workspace
            </Button>
            <Button variant="outline" onClick={() => setConnect(true)}>
              Connect to server
            </Button>
          </div>
        )}
        {error && (
          <p role="alert" className="error-banner mt-4">
            {error}
          </p>
        )}
      </div>
      <div className="welcome-art">
        <div className="orbit one" />
        <div className="orbit two" />
        <div className="orbit three" />
        <div className="orbit-center">
          <CheckSquare size={48} />
        </div>
        <div className="art-caption">One place. Your pace.</div>
      </div>
    </main>
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
  useSyncExternalStore(
    (listener) => {
      runtime.surfaceListeners.add(listener);
      return () => {
        runtime.surfaceListeners.delete(listener);
      };
    },
    () => runtime.surfacesVersion,
    () => 0,
  );
  const contributed = [...runtime.surfaces.values()];
  const appNavigation = [
    ...navigation,
    ...[...runtime.registry.manifests.values()]
      .filter(
        (m) =>
          m.publisher !== "taskasaur" &&
          m.ui.mode === "shared" &&
          m.storage.local.collections.length,
      )
      .map((m) => ({ id: m.id, label: m.name, icon: Blocks })),
    ...contributed.map((s) => ({ id: s.id, label: s.label, icon: Blocks })),
  ];
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
  const states =
      useLiveQuery(() => runtime.db.plugins.toArray(), [runtime]) ?? [],
    pending = useLiveQuery(() => runtime.db.outbox.count(), [runtime]) ?? 0;
  const [view, setView] = useState(() => location.hash.slice(1) || "plugins"),
    [menu, setMenu] = useState(false),
    [error, setError] = useState(""),
    [syncing, setSyncing] = useState(false),
    [online, setOnline] = useState(navigator.onLine);
  const { theme, setTheme } = useTheme();
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
    if (!runtime.profile.connected) return;
    const sync = () => {
      void runtime.synchronize().catch((e) => setError(e.message));
    };
    sync();
    const id = setInterval(sync, 15000);
    return () => clearInterval(id);
  }, [runtime, online]);
  const enabled = new Set(states.filter((s) => s.enabled).map((s) => s.id));
  function navigate(id: string) {
    location.hash = id;
    setView(id);
    setMenu(false);
  }
  const selected = appNavigation.find((n) => n.id === view),
    title =
      selected?.label ??
      (view === "plugins"
        ? "Plugins"
        : view === "settings"
          ? "Settings"
          : "Workspace");
  const shown =
    enabled.has(view.split(":")[0]) || ["plugins", "settings"].includes(view);
  let content;
  if (!shown)
    content = (
      <div className="empty-state">
        <h3>This plugin is not enabled</h3>
        <p>Install and enable it from Plugins to use its workspace views.</p>
        <Button onClick={() => navigate("plugins")}>Open Plugins</Button>
      </div>
    );
  else if (view === "plugins") content = <PluginsView runtime={runtime} />;
  else if (view === "tasks") content = <TasksView runtime={runtime} />;
  else if (view === "time") content = <TimeView runtime={runtime} />;
  else if (view === "calendar") content = <CalendarView runtime={runtime} />;
  else if (view === "reminders") content = <RemindersView runtime={runtime} />;
  else if (view === "files") content = <FilesView runtime={runtime} />;
  else if (view === "credentials")
    content = <CredentialsView runtime={runtime} />;
  else if (view === "tables") content = <TablesView runtime={runtime} />;
  else if (view === "devices") content = <DevicesView runtime={runtime} />;
  else if (view === "email-client") content = <EmailView runtime={runtime} />;
  else if (view === "automation-editor")
    content = <AutomationView runtime={runtime} />;
  else if (view === "office-editor") content = <OfficeView runtime={runtime} />;
  else if (view === "remote-terminal")
    content = <TerminalView runtime={runtime} />;
  else if (view === "connector-github")
    content = <GithubView runtime={runtime} />;
  else if (view === "jobs")
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
  else if (view === "settings")
    content = <SettingsView runtime={runtime} onSwitch={onSwitch} />;
  else if (view === "sharing") content = <SharingView runtime={runtime} />;
  else if (runtime.surfaces.has(view)) {
    const Surface = runtime.surfaces.get(view)!.render;
    content = (
      <PluginBoundary key={view}>
        <Surface />
      </PluginBoundary>
    );
  } else if (runtime.registry.manifests.get(view)?.publisher !== "taskasaur")
    content = <ExtensionCollections key={view} runtime={runtime} id={view} />;
  else content = <RecordTable runtime={runtime} collection={view} />;
  return (
    <div className="app-shell">
      <aside className={`sidebar ${menu ? "is-open" : ""}`}>
        <button className="brand" onClick={() => navigate("plugins")}>
          <img src="/taskasaur_icon.png" width="30" height="30" alt="" />
          <span>Taskasaur</span>
        </button>
        <div className="workspace-label">{runtime.profile.name}</div>
        <nav>
          {appNavigation
            .filter((n) => enabled.has(n.id.split(":")[0]))
            .map((n) => (
              <button
                className={view === n.id ? "nav-item active" : "nav-item"}
                key={n.id}
                onClick={() => navigate(n.id)}
              >
                <n.icon size={17} />
                {n.label}
              </button>
            ))}
        </nav>
        <div className="sidebar-bottom">
          <button
            className={view === "plugins" ? "nav-item active" : "nav-item"}
            onClick={() => navigate("plugins")}
          >
            <Blocks size={17} />
            Plugins
          </button>
          <button
            className={view === "settings" ? "nav-item active" : "nav-item"}
            onClick={() => navigate("settings")}
          >
            <Settings size={17} />
            Settings
          </button>
          <div className="local-status">
            {runtime.profile.connected ? (
              <Cloud size={14} />
            ) : (
              <CloudOff size={14} />
            )}{" "}
            {runtime.profile.connected
              ? online
                ? "Connected workspace"
                : "Working offline"
              : "Local workspace"}
          </div>
        </div>
      </aside>
      <main className="main-content">
        <header className="page-header">
          <div className="flex items-center gap-3">
            <Button
              className="md:hidden"
              variant="ghost"
              size="icon"
              aria-label="Open navigation"
              onClick={() => setMenu(!menu)}
            >
              <Menu size={20} />
            </Button>
            <div>
              <p className="eyebrow">{runtime.profile.name}</p>
              <h1>{title}</h1>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {pending > 0 && (
              <Badge variant="secondary">{pending} pending</Badge>
            )}
            {runtime.profile.connected && (
              <Button
                variant="ghost"
                size="icon"
                aria-label="Synchronize workspace"
                disabled={syncing || !online}
                onClick={async () => {
                  setSyncing(true);
                  try {
                    await runtime.synchronize();
                    setError("");
                  } catch (e) {
                    setError(e instanceof Error ? e.message : String(e));
                  } finally {
                    setSyncing(false);
                  }
                }}
              >
                <RefreshCw
                  size={17}
                  className={syncing ? "animate-spin" : ""}
                />
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              aria-label="Toggle theme"
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            >
              {theme === "dark" ? <Sun size={17} /> : <Moon size={17} />}
            </Button>
          </div>
        </header>
        {error && (
          <div role="alert" className="error-banner mb-4">
            {error}
            <button className="ml-3 underline" onClick={() => setError("")}>
              Dismiss
            </button>
          </div>
        )}
        <Suspense
          fallback={
            <div className="empty-state">Opening {title.toLowerCase()}…</div>
          }
        >
          <ReferenceOptionsContext.Provider value={referenceOptions}>
            {content}
          </ReferenceOptionsContext.Provider>
        </Suspense>
      </main>
    </div>
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
function ExtensionCollections({
  runtime,
  id,
}: {
  runtime: AppRuntime;
  id: string;
}) {
  const manifest = runtime.registry.manifests.get(id),
    collections = manifest?.storage.local.collections ?? [];
  const [collection, setCollection] = useState(collections[0]);
  return (
    <PluginBoundary>
      <div className="space-y-4">
        <div className="flex gap-2">
          {collections.map((name) => (
            <Button
              key={name}
              variant={name === collection ? "default" : "outline"}
              onClick={() => setCollection(name)}
            >
              {name
                .replace(id.replaceAll(/[.-]/g, "_") + "_", "")
                .replaceAll("_", " ")}
            </Button>
          ))}
        </div>
        {collection ? (
          <RecordTable
            key={collection}
            runtime={runtime}
            collection={collection}
          />
        ) : (
          <p>This plugin provides commands and background services.</p>
        )}
      </div>
    </PluginBoundary>
  );
}
function PluginsView({ runtime }: { runtime: AppRuntime }) {
  const states =
    useLiveQuery(() => runtime.db.plugins.toArray(), [runtime]) ?? [];
  const [busy, setBusy] = useState(""),
    [error, setError] = useState("");
  async function action(
    id: string,
    kind: "install" | "disable" | "enable" | "uninstall",
  ) {
    setBusy(id);
    try {
      if (kind === "install") await runtime.installAndEnable(id);
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
      {[false, true].map((required) => (
        <section key={String(required)}>
          <div className="section-heading">
            <h2>{required ? "Required core" : "Optional features"}</h2>
            <span>
              {catalog.filter((p) => isRequiredCore(p.id) === required).length}{" "}
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
                {catalog
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
                                onClick={() =>
                                  void action(plugin.id, "install")
                                }
                              >
                                Install
                              </Button>
                            ) : (
                              <>
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
  return (
    <div className="space-y-6">
      <section className="settings-card">
        <h2>Workspace</h2>
        <p>{runtime.profile.name}</p>
        <p className="text-muted-foreground text-sm">
          {runtime.profile.connected
            ? runtime.profile.serverUrl
            : "Data is stored on this device."}
        </p>
        <div className="flex gap-2 mt-4">
          <Button
            variant="outline"
            onClick={async () => {
              try {
                const records = (await runtime.db.records.toArray()).filter(
                  (r) => r.collection !== "credentials",
                );
                download(
                  "taskasaur-workspace.json",
                  new Blob(
                    [
                      JSON.stringify(
                        { format: "taskasaur-export-v1", records },
                        null,
                        2,
                      ),
                    ],
                    { type: "application/json" },
                  ),
                );
              } catch (e) {
                setError(String(e));
              }
            }}
          >
            Export workspace data
          </Button>
          <Button variant="ghost" onClick={onSwitch}>
            <ArrowLeft size={14} />
            Switch workspace
          </Button>
        </div>
        <p className="text-xs text-muted-foreground mt-3">
          Credentials and file bytes are excluded from this record export.
          Download files separately.
        </p>
      </section>
      {error && <p role="alert">{error}</p>}
      <SyncConflicts runtime={runtime} />
      <RecordTable runtime={runtime} collection="settings" />
    </div>
  );
}
