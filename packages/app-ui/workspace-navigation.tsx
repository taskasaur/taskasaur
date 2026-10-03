import { useEffect, useState, type ReactNode } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import {
  PanelLeft,
  PanelRight,
  Search,
  ChevronDown,
  ChevronRight,
  Plus,
  RefreshCw,
} from "lucide-react";
import { Button } from "../ui/primitives/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "../ui/primitives/sheet";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "../ui/primitives/popover";
import {
  Command,
  CommandInput,
  CommandList,
  CommandItem,
  CommandEmpty,
} from "../ui/primitives/command";
import {
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbSeparator,
  BreadcrumbPage,
} from "../ui/primitives/breadcrumb";
import { WorkspaceSearchDialog } from "./workspace-search";
import {
  PluginIcon,
  pageRoute,
  resolveNavigation,
  type NavPlugin,
} from "./navigation";
import type { AppRuntime } from "./runtime";

function PluginMenu({
  entries,
  view,
  navigate,
}: {
  entries: NavPlugin[];
  view: string;
  navigate: (route: string) => void;
}) {
  const [expanded, setExpanded] = useState<string[]>([]);
  return (
    <nav
      className="space-y-1"
      aria-label={
        entries[0]?.side === "right" ? "Settings and tools" : "Workspace"
      }
    >
      {entries.map((plugin) => {
        const selected = view.split(":")[0].split("?")[0] === plugin.id;
        const currentPage = selected
          ? resolveNavigation([plugin], view).page
          : undefined;
        const open = expanded.includes(plugin.id);
        return (
          <div key={plugin.id}>
            <div
              className={`flex items-center rounded-lg ${selected ? "bg-accent text-accent-foreground" : "hover:bg-muted"}`}
            >
              <Button
                variant="ghost"
                className="min-w-0 flex-1 justify-start gap-3"
                onClick={() => navigate(plugin.id)}
                aria-current={
                  selected && currentPage === plugin.main ? "page" : undefined
                }
              >
                <PluginIcon id={plugin.id} icon={plugin.icon} />
                <span className="truncate">{plugin.label}</span>
                {plugin.enabled === false && (
                  <span className="text-xs text-muted-foreground">
                    Disabled
                  </span>
                )}
              </Button>
              {plugin.pages.length > 0 && (
                <Button
                  variant="ghost"
                  size={
                    currentPage && currentPage !== plugin.main
                      ? "sm"
                      : "icon-sm"
                  }
                  aria-label={`${plugin.label} pages`}
                  aria-expanded={open}
                  aria-controls={`pages-${plugin.id}`}
                  onClick={() =>
                    setExpanded(
                      open
                        ? expanded.filter((id) => id !== plugin.id)
                        : [...expanded, plugin.id],
                    )
                  }
                >
                  <ChevronDown className={open ? "rotate-180" : ""} />
                  {currentPage && currentPage !== plugin.main && (
                    <span className="max-w-28 truncate">
                      {currentPage.label}
                    </span>
                  )}
                </Button>
              )}
            </div>
            {open && (
              <div
                id={`pages-${plugin.id}`}
                className="ml-6 mt-1 space-y-1 border-l pl-3"
              >
                {plugin.pages.map((page) => (
                  <Button
                    key={page.id}
                    variant={
                      currentPage?.id === page.id ? "secondary" : "ghost"
                    }
                    className="w-full justify-start"
                    onClick={() => navigate(pageRoute(plugin, page))}
                  >
                    {page.label}
                  </Button>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </nav>
  );
}
export function WorkspaceNavigation({
  runtime,
  entries,
  view,
  navigate,
  children,
  pending,
  online,
  syncing,
  synchronize,
}: {
  runtime: AppRuntime;
  entries: NavPlugin[];
  view: string;
  navigate: (route: string) => void;
  children: ReactNode;
  pending: number;
  online: boolean;
  syncing: boolean;
  synchronize: () => Promise<void>;
}) {
  const [menu, setMenu] = useState<"left" | "right" | null>(null),
    [search, setSearch] = useState(false),
    [slot, setSlot] = useState<number | null>(null),
    [error, setError] = useState("");
  const saved =
    useLiveQuery(
      () =>
        runtime.db.getMetadata<Array<string | null>>("navigation.shortcuts"),
      [runtime],
    ) ?? [];
  const { plugin, page } = resolveNavigation(entries, view);
  const go = (route: string) => {
    navigate(route);
    setMenu(null);
  };
  const shortcuts = saved
    .slice(0, 3)
    .map((id) => entries.find((p) => p.id === id && p.enabled !== false));
  const openSearch = () => {
    setMenu(null);
    setSearch(true);
  };
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setMenu(null);
        setSearch((open) => !open);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  const shortcutButtons = () =>
    shortcuts.map(
      (item, index) =>
        item && (
          <Button
            key={index}
            variant={plugin?.id === item.id ? "secondary" : "ghost"}
            size="icon"
            title={item.label}
            aria-label={`Open saved ${item.label}`}
            onClick={() => go(item.id)}
          >
            <PluginIcon id={item.id} icon={item.icon} />
          </Button>
        ),
    );
  return (
    <div className="workspace-shell">
      <header className="workspace-topbar">
        <Button
          className="hidden md:inline-flex"
          variant="ghost"
          size="icon"
          aria-label="Open plugins menu"
          onClick={() => setMenu("left")}
        >
          <PanelLeft />
        </Button>
        <Breadcrumb className="min-w-0 flex-1" aria-label="Current page">
          <BreadcrumbList className="flex-nowrap">
            <BreadcrumbItem className="min-w-0">
              <BreadcrumbLink
                render={
                  <button
                    className="max-w-40 truncate"
                    onClick={() => go("plugins")}
                  />
                }
              >
                {runtime.profile.name}
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem className="min-w-0">
              {page && plugin && page !== plugin.main ? (
                <BreadcrumbLink
                  render={<button onClick={() => go(plugin.id)} />}
                >
                  {plugin.label}
                </BreadcrumbLink>
              ) : (
                <BreadcrumbPage>{plugin?.label ?? "Plugins"}</BreadcrumbPage>
              )}
            </BreadcrumbItem>
            {page && plugin && page !== plugin.main && (
              <>
                <BreadcrumbSeparator />
                <BreadcrumbItem>
                  <BreadcrumbPage>{page.label}</BreadcrumbPage>
                </BreadcrumbItem>
              </>
            )}
          </BreadcrumbList>
        </Breadcrumb>
        <div
          className="hidden items-center gap-1 md:flex"
          aria-label="Saved tabs"
        >
          {shortcutButtons()}
        </div>
        <Button
          className="hidden md:inline-flex"
          variant="ghost"
          size="icon"
          aria-label="Open settings menu"
          onClick={() => setMenu("right")}
        >
          <PanelRight />
        </Button>
      </header>
      <main className="workspace-content">{children}</main>
      <nav
        className="workspace-bottom-bar md:hidden"
        aria-label="Mobile navigation"
      >
        <Button
          variant="ghost"
          size="icon"
          aria-label="Open plugins menu"
          onClick={() => setMenu("left")}
        >
          <PanelLeft />
        </Button>
        <div className="flex flex-1 justify-evenly" aria-label="Saved tabs">
          {shortcutButtons()}
        </div>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Open settings menu"
          onClick={() => setMenu("right")}
        >
          <PanelRight />
        </Button>
      </nav>
      {(["left", "right"] as const).map((side) => (
        <Sheet
          key={side}
          open={menu === side}
          onOpenChange={(open) => setMenu(open ? side : null)}
        >
          <SheetContent
            side={side}
            className="w-[min(22rem,90vw)]! overflow-y-auto"
          >
            <SheetHeader>
              <SheetTitle>
                {side === "left" ? "Taskasaur" : "Settings and tools"}
              </SheetTitle>
              <SheetDescription className="sr-only">
                {side === "left"
                  ? "Search and installed plugins"
                  : "Workspace tools and quick access"}
              </SheetDescription>
            </SheetHeader>
            <div className="flex min-h-0 flex-1 flex-col gap-4 px-3 pb-6">
              {side === "left" && (
                <Button
                  variant="outline"
                  className="justify-start"
                  aria-label="Search"
                  onClick={openSearch}
                >
                  <Search />
                  Search
                  <span className="ml-auto text-xs text-muted-foreground">
                    ⌘ / Ctrl K
                  </span>
                </Button>
              )}
              <PluginMenu
                entries={entries.filter((p) => p.side === side)}
                view={view}
                navigate={go}
              />
              {side === "right" && (
                <>
                  <section className="mt-3 border-t pt-4">
                    <h2 className="mb-3 text-sm font-medium">Saved tabs</h2>
                    <div className="flex gap-3">
                      {[0, 1, 2].map((index) => (
                        <Popover
                          key={index}
                          open={slot === index}
                          onOpenChange={(open) => setSlot(open ? index : null)}
                        >
                          <PopoverTrigger
                            render={
                              <Button
                                variant="outline"
                                size="icon"
                                aria-label={`Choose saved tab ${index + 1}`}
                              />
                            }
                          >
                            {shortcuts[index] ? (
                              <PluginIcon
                                id={shortcuts[index]!.id}
                                icon={shortcuts[index]!.icon}
                              />
                            ) : (
                              <Plus />
                            )}
                          </PopoverTrigger>
                          <PopoverContent className="w-64 p-0" align="end">
                            <Command>
                              <CommandInput
                                placeholder="Choose a plugin…"
                                aria-label="Choose shortcut plugin"
                              />
                              <CommandList>
                                <CommandEmpty>No enabled plugins.</CommandEmpty>
                                {entries
                                  .filter(
                                    (p) =>
                                      p.enabled !== false &&
                                      !["plugins", "settings"].includes(p.id),
                                  )
                                  .map((item) => (
                                    <CommandItem
                                      key={item.id}
                                      value={item.label}
                                      onSelect={() => {
                                        const next = Array.from(
                                          { length: 3 },
                                          (_, i) =>
                                            i === index
                                              ? item.id
                                              : saved[i] === item.id
                                                ? null
                                                : (saved[i] ?? null),
                                        );
                                        void runtime.db
                                          .setMetadata(
                                            "navigation.shortcuts",
                                            next,
                                          )
                                          .then(() => setSlot(null))
                                          .catch((e) => setError(String(e)));
                                      }}
                                    >
                                      <PluginIcon
                                        id={item.id}
                                        icon={item.icon}
                                      />
                                      {item.label}
                                    </CommandItem>
                                  ))}
                                <CommandItem
                                  value="Clear slot"
                                  onSelect={() =>
                                    void runtime.db
                                      .setMetadata(
                                        "navigation.shortcuts",
                                        Array.from({ length: 3 }, (_, i) =>
                                          i === index
                                            ? null
                                            : (saved[i] ?? null),
                                        ),
                                      )
                                      .then(() => setSlot(null))
                                      .catch((e) => setError(String(e)))
                                  }
                                >
                                  Clear slot
                                </CommandItem>
                              </CommandList>
                            </Command>
                          </PopoverContent>
                        </Popover>
                      ))}
                    </div>
                  </section>
                  <div
                    className="mt-auto border-t pt-4 text-xs text-muted-foreground"
                    aria-live="polite"
                  >
                    {online
                      ? `${runtime.node.replica.peers} peers · saved locally`
                      : "Working offline · saved locally"}
                    {pending > 0 && <span> · {pending} pending</span>}
                    <Button
                      className="mt-2 w-full justify-start"
                      variant="ghost"
                      disabled={syncing || !online}
                      onClick={() => void synchronize()}
                    >
                      <RefreshCw className={syncing ? "animate-spin" : ""} />
                      Synchronize workspace
                    </Button>
                  </div>
                </>
              )}
              {error && (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              )}
            </div>
          </SheetContent>
        </Sheet>
      ))}
      <WorkspaceSearchDialog
        runtime={runtime}
        entries={entries}
        open={search}
        onOpenChange={setSearch}
        navigate={go}
      />
    </div>
  );
}
