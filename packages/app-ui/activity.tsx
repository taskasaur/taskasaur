import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useState } from "react";
import type { AppRuntime } from "./runtime";
import { Button } from "../ui/primitives/button";
import { PluginIcon } from "./navigation";
export function WorkspaceActivity({ runtime }: { runtime: AppRuntime }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(timer);
  }, []);
  const entries =
    useLiveQuery(
      async () =>
        (await runtime.db.records.toArray())
          .filter((row) => {
            if (
              row.deletedAt ||
              !runtime.registry.enabled(row.managedBy ?? row.pluginId)
            )
              return false;
            const data = {
              ...row.data,
              ...((row.data.custom_fields as Record<string, unknown>) ?? {}),
            };
            if (["jobs", "workflow_runs"].includes(row.collection))
              return ["queued", "running", "waiting", "pending"].includes(
                String(data.status),
              );
            if (row.collection === "time")
              return Boolean(data.started_at && !data.ended_at);
            if (row.collection === "tasks")
              return ["in-progress", "in_progress", "doing"].includes(
                String(data.status),
              );
            if (row.collection === "notifications") return !data.read_at;
            if (row.collection === "calendar") {
              const start = Date.parse(String(data.dtstart)),
                end = Date.parse(String(data.dtend));
              return start <= now && end > now;
            }
            return false;
          })
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
          .slice(0, 30),
      [runtime, now],
    ) ?? [];
  return (
    <section className="space-y-3" aria-label="Active work">
      <h2 className="font-medium">Active now</h2>
      {!entries.length ? (
        <p className="text-sm text-muted-foreground">
          No active work right now.
        </p>
      ) : (
        <div className="divide-y rounded-lg border">
          {entries.map((row) => {
            const data = {
                ...row.data,
                ...((row.data.custom_fields as Record<string, unknown>) ?? {}),
              },
              plugin = row.managedBy ?? row.pluginId;
            return (
              <Button
                key={row.id}
                variant="ghost"
                className="flex h-auto w-full justify-start gap-3 rounded-none p-3 text-left"
                onClick={() => void runtime.navigate(plugin, undefined, row.id)}
              >
                <PluginIcon id={plugin} />
                <span className="min-w-0 flex-1 truncate">
                  {String(
                    data.title ?? data.name ?? data.summary ?? row.collection,
                  )}
                </span>
                <span className="text-xs text-muted-foreground">
                  {String(
                    data.status ??
                      (row.collection === "time"
                        ? "Running"
                        : row.collection === "notifications"
                          ? "Unread"
                          : "Active"),
                  )}
                </span>
              </Button>
            );
          })}
        </div>
      )}
    </section>
  );
}
