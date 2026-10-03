import type { Repository } from "./repository";
import type { WorkflowSignal } from "@taskasaur/platform/plugin-sdk/device";
export async function pendingSignals(repo: Repository, runId: string) {
  return (
    await repo.db.query<WorkflowSignal>(
      "SELECT id,name,data FROM taskasaur.workflow_signals WHERE run_id=$1 AND delivered_at IS NULL ORDER BY created_at LIMIT 50",
      [runId],
    )
  ).rows;
}
export async function acknowledgeSignal(
  repo: Repository,
  runId: string,
  id: string,
) {
  await repo.db.query(
    "UPDATE taskasaur.workflow_signals SET delivered_at=now() WHERE id=$1 AND run_id=$2",
    [id, runId],
  );
}

export type { WorkflowSignal } from "@taskasaur/platform/plugin-sdk/device";
