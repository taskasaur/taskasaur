import {
  Folder,
  Table2,
  Braces,
  KeyRound,
  Monitor,
  Bell,
  ListChecks,
  Settings,
  Blocks,
  CheckSquare,
  Clock3,
  Activity,
  CalendarDays,
  AlarmClock,
  Mail,
  Workflow,
  Play,
  Terminal,
  FileText,
  Share2,
  Github,
} from "lucide-react";
import type { AppRuntime } from "./runtime";
import { getSchema, isRequiredCore } from "@taskasaur/platform/core/catalog";

export interface NavPage {
  id: string;
  label: string;
  surface?: string;
  collection?: string;
  columns?: boolean;
  readOnly?: boolean;
}
export interface NavPlugin {
  id: string;
  label: string;
  icon?: string;
  main: NavPage;
  pages: NavPage[];
  side: "left" | "right";
  enabled?: boolean;
}
export const coreNavigation: NavPlugin[] = [
  ...[
    "files",
    "tables",
    "variables",
    "credentials",
    "devices",
    "notifications",
    "jobs",
    "settings",
  ].map((id) => ({
    id,
    label: id[0].toUpperCase() + id.slice(1),
    main: { id, label: id },
    pages:
      id === "settings" ? [{ id: "storage", label: "Storage copies" }] : [],
    side: "right" as const,
  })),
  {
    id: "plugins",
    label: "Plugins",
    main: { id: "plugins", label: "Plugins" },
    pages: [],
    side: "left",
  },
];
const icons = {
  files: Folder,
  tables: Table2,
  variables: Braces,
  credentials: KeyRound,
  devices: Monitor,
  notifications: Bell,
  jobs: ListChecks,
  settings: Settings,
  plugins: Blocks,
  tasks: CheckSquare,
  time: Clock3,
  track: Activity,
  calendar: CalendarDays,
  reminders: AlarmClock,
  "email-client": Mail,
  "automation-editor": Workflow,
  "automation-runtime": Play,
  "remote-terminal": Terminal,
  "office-editor": FileText,
  sharing: Share2,
  "connector-github": Github,
};
export function PluginIcon({
  id,
  icon,
  className = "size-4 shrink-0",
}: {
  id: string;
  icon?: string;
  className?: string;
}) {
  const Icon =
    icons[(icon ?? id) as keyof typeof icons] ??
    icons[id as keyof typeof icons];
  if (Icon) return <Icon className={className} aria-hidden />;
  // Stable per-plugin identicons keep third-party entries distinct without remote image requests.
  const hash =
    [...id].reduce(
      (n, c) => Math.imul(n ^ c.charCodeAt(0), 16777619),
      2166136261,
    ) >>> 0;
  return (
    <svg viewBox="0 0 20 20" className={className} aria-hidden>
      <rect
        x="1"
        y="1"
        width="18"
        height="18"
        rx="4"
        fill={`hsl(${hash % 360} 45% 45%)`}
      />
      {Array.from({ length: 15 }, (_, i) =>
        (hash >>> i) & 1 ? (
          <rect
            key={i}
            x={3 + (i % 3) * 5}
            y={3 + Math.floor(i / 3) * 3}
            width="3"
            height="2"
            fill="white"
          />
        ) : null,
      )}
    </svg>
  );
}
export function pluginNavigation(runtime: AppRuntime): NavPlugin[] {
  const entries = [...coreNavigation];
  for (const manifest of runtime.registry.manifests.values()) {
    if (
      isRequiredCore(manifest.id) ||
      !runtime.registry.states.get(manifest.id)?.installed
    )
      continue;
    const surfaces = [...runtime.surfaces.values()].filter(
      (s) => s.pluginId === manifest.id,
    );
    const declaredMain = manifest.ui.pages?.find(
      (p) => p.id === manifest.ui.mainPage,
    );
    const primary = manifest.ui.mainPage
      ? surfaces.find((s) => s.id === `${manifest.id}:${manifest.ui.mainPage}`)
      : (surfaces.find((s) => s.main) ?? surfaces[0]);
    const collections = manifest.storage.local.collections;
    const mainCollection =
      declaredMain?.collection ??
      collections.find((id) => getSchema(id).tables) ??
      collections[0];
    const main: NavPage = {
      id: primary?.id.split(":")[1] ?? manifest.ui.mainPage ?? manifest.id,
      label: declaredMain?.label ?? primary?.label ?? manifest.name,
      surface: primary?.id,
      collection: mainCollection,
      readOnly: declaredMain?.readOnly,
    };
    const pages: NavPage[] = surfaces
      .filter((s) => s !== primary)
      .map((s) => ({ id: s.id.split(":")[1], label: s.label, surface: s.id }));
    for (const page of manifest.ui.pages ?? [])
      if (page.id !== main.id && !pages.some((p) => p.id === page.id))
        pages.push(page);
    if (manifest.id === "email-client")
      pages.push(
        { id: "accounts", label: "Accounts", collection: "mail_accounts" },
        {
          id: "operations",
          label: "Operations",
          collection: "mail_operations",
          readOnly: true,
        },
      );
    for (const collection of collections) {
      const schema = getSchema(collection);
      if (schema.tables)
        pages.push({
          id: collection + "-columns",
          label:
            collections.filter((id) => getSchema(id).tables).length > 1
              ? schema.name + " columns"
              : "Columns",
          collection,
          columns: true,
        });
      else if (
        collection !== mainCollection &&
        !pages.some((p) => p.collection === collection)
      )
        pages.push({
          id: collection.replaceAll("_", "-"),
          label: schema.name,
          collection,
          readOnly: /runs|operations|issues|mailboxes/.test(collection),
        });
    }
    entries.push({
      id: manifest.id,
      enabled: runtime.registry.enabled(manifest.id),
      label: primary?.label ?? manifest.name,
      icon: manifest.ui.icon ?? primary?.icon,
      main,
      pages: pages.filter(
        (p, i, all) =>
          p.id !== main.id && all.findIndex((other) => other.id === p.id) === i,
      ),
      side: "left",
    });
  }
  return entries;
}
export function resolveNavigation(entries: NavPlugin[], route: string) {
  const [path] = route.split("?");
  const [id, pageId] = path.split(":");
  const plugin = entries.find((p) => p.id === id);
  const page =
    plugin &&
    (!pageId || pageId === plugin.main.id
      ? plugin.main
      : plugin.pages.find((p) => p.id === pageId));
  return { plugin, page };
}
export const pageRoute = (plugin: NavPlugin, page = plugin.main) =>
  page === plugin.main ? plugin.id : `${plugin.id}:${page.id}`;
