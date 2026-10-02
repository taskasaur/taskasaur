"use client";
import { useState } from "react";
import { RecordTable } from "./record-table";
import type { AppRuntime } from "./runtime";
import { Button } from "../ui/primitives/button";
export default function GithubView({ runtime }: { runtime: AppRuntime }) {
  const [tab, setTab] = useState("github_issues"),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function action(kind: string, id: string) {
    setBusy(true);
    try {
      await runtime.synchronize();
      await runtime.api(`github/${kind}`, { id });
      await runtime.synchronize();
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-4">
      <p className="page-description">
        Read repository issues through a shared credential authorized for
        https://api.github.com. Create linked tasks when the Tasks plugin is
        enabled.
      </p>
      <div className="flex gap-2">
        <Button
          variant={tab === "github_issues" ? "secondary" : "ghost"}
          onClick={() => setTab("github_issues")}
        >
          Issues
        </Button>
        <Button
          variant={tab === "github_connections" ? "secondary" : "ghost"}
          onClick={() => setTab("github_connections")}
        >
          Repositories
        </Button>
      </div>
      {error && (
        <p role="alert" className="error-banner">
          {error}
        </p>
      )}
      <RecordTable
        key={tab}
        runtime={runtime}
        collection={tab}
        hideCreate={tab === "github_issues"}
        readOnly={tab === "github_issues"}
        renderActions={(row) => (
          <Button
            variant="outline"
            size="sm"
            disabled={
              busy ||
              !runtime.profile.connected ||
              (tab === "github_issues" &&
                (!runtime.registry.enabled("tasks") ||
                  !runtime.registry.states
                    .get("connector-github")
                    ?.features.includes("taskLinks") ||
                  Boolean(row.data.task_id)))
            }
            onClick={() =>
              void action(
                tab === "github_connections" ? "sync" : "create-task",
                row.id,
              )
            }
          >
            {tab === "github_connections"
              ? "Synchronize"
              : row.data.task_id
                ? "Linked"
                : "Create task"}
          </Button>
        )}
      />
    </div>
  );
}
