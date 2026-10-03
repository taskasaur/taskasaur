import { Check } from "lucide-react";
import type { AppRuntime } from "./runtime";
import { RecordTable } from "./record-table";
import { Button } from "../ui/primitives/button";
/** v1 Tasks adapter: completion action with the standard collection views. */
export function TasksView({ runtime }: { runtime: AppRuntime }) {
  return (
    <RecordTable
      runtime={runtime}
      collection="tasks"
      renderActions={(task, { writable, update }) => (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Toggle task completion"
          aria-pressed={task.data.status === "done"}
          disabled={!writable}
          onClick={() =>
            void update({
              status: task.data.status === "done" ? "open" : "done",
            }).catch(() => {
              /* RecordTable displays write errors. */
            })
          }
        >
          <Check />
        </Button>
      )}
    />
  );
}
