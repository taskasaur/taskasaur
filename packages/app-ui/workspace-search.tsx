import { useEffect, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { ArrowRight } from "lucide-react";
import {
  Command,
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandItem,
  CommandGroup,
} from "../ui/primitives/command";
import { PluginIcon, pageRoute, type NavPlugin } from "./navigation";
import type { AppRuntime } from "./runtime";
import type { SearchDocument } from "@taskasaur/platform/plugin-sdk/navigation";
import { searchText } from "./search-index";

function commandAvailable(enabled?: () => boolean) {
  try {
    return !enabled || enabled();
  } catch {
    return false;
  }
}

export function WorkspaceSearchDialog({
  runtime,
  entries,
  open,
  onOpenChange,
  navigate,
}: {
  runtime: AppRuntime;
  entries: NavPlugin[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  navigate: (route: string) => void;
}) {
  const [query, setQuery] = useState(""),
    [results, setResults] = useState<SearchDocument[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const revision = useLiveQuery(() => runtime.db.records.toArray(), [runtime]);
  useEffect(() => {
    if (!open) return;
    let canceled = false;
    setBusy(true);
    const timer = setTimeout(() => {
      void runtime.search
        .query(query)
        .then((rows) => {
          if (!canceled) {
            setResults(rows);
            setError("");
          }
        })
        .catch((e) => {
          if (!canceled) setError(String(e));
        })
        .finally(() => {
          if (!canceled) setBusy(false);
        });
    }, 100);
    return () => {
      canceled = true;
      clearTimeout(timer);
    };
  }, [runtime, open, query, revision, runtime.surfacesVersion]);
  useEffect(() => {
    if (!open) {
      setQuery("");
      setResults([]);
    }
  }, [open]);
  const commands = [
    ...entries
      .filter((plugin) => plugin.enabled !== false)
      .flatMap((plugin) =>
        [plugin.main, ...plugin.pages].map((page) => ({
          id: "navigate:" + pageRoute(plugin, page),
          title:
            "Open " +
            plugin.label +
            (page === plugin.main ? "" : " · " + page.label),
          pluginId: plugin.id,
          keywords: [],
          run: () => navigate(pageRoute(plugin, page)),
        })),
      ),
    ...[...runtime.commands.values()].filter(
      (c) =>
        runtime.registry.enabled(c.pluginId) && commandAvailable(c.enabled),
    ),
  ].filter((c) =>
    searchText(c.title + " " + c.keywords?.join(" ")).includes(
      searchText(query).trim(),
    ),
  );
  const execute = async (run: () => unknown) => {
    setBusy(true);
    try {
      await run();
      onOpenChange(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Search workspace"
      description="Search content and commands on this device"
    >
      <Command shouldFilter={false}>
        <CommandInput
          aria-label="Search content and commands"
          placeholder="Search content and commands…"
          value={query}
          onValueChange={setQuery}
        />
        <CommandList aria-busy={busy}>
          <CommandEmpty>
            {busy ? "Searching…" : "No results found."}
          </CommandEmpty>
          {results.length > 0 && (
            <CommandGroup heading="Content">
              {results.map((result) => (
                <CommandItem
                  key={result.id}
                  value={"record:" + result.id}
                  onSelect={() =>
                    void execute(() =>
                      runtime.navigate(
                        result.pluginId,
                        runtime.searchOptions.get(result.collection)?.page,
                        result.id,
                      ),
                    )
                  }
                >
                  <PluginIcon id={result.pluginId} />
                  <span className="min-w-0 flex-1 truncate">
                    {result.title}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {result.collection}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          {commands.length > 0 && (
            <CommandGroup heading="Commands">
              {commands.slice(0, 30).map((command) => (
                <CommandItem
                  key={command.id}
                  value={command.id}
                  disabled={busy}
                  onSelect={() => void execute(command.run)}
                >
                  <PluginIcon id={command.pluginId} />
                  <span>{command.title}</span>
                  <ArrowRight className="ml-auto" />
                </CommandItem>
              ))}
            </CommandGroup>
          )}
        </CommandList>
        {error && (
          <p role="alert" className="p-3 text-sm text-destructive">
            {error}
          </p>
        )}
      </Command>
    </CommandDialog>
  );
}
