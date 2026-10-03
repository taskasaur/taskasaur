import { createHash, randomUUID } from "node:crypto";
import { Repository } from "./repository";
import { invariant } from "@taskasaur/platform/core/errors";
import {
  getSchema,
  schemaById,
  manifestById,
} from "@taskasaur/platform/core/catalog";
import { routerFor } from "./api";
import { serverPluginHost } from "./plugin-host";
import { allNodes } from "@taskasaur/platform/core/workflows";
import { pendingSignals, type WorkflowSignal } from "./device-signals";
import type { Principal, Mutation } from "@taskasaur/platform/plugin-sdk";
import type { Value } from "@taskasaur/platform/field-types";
import type { WorkflowExecution } from "@taskasaur/platform/automation/engine";
export type { Dispatch } from "@taskasaur/platform/plugin-sdk/device";
import type { Dispatch } from "@taskasaur/platform/plugin-sdk/device";
export const dispatchPrincipal = (dispatch: Dispatch): Principal => ({
  userId: dispatch.user_id,
  workspaceId: dispatch.workspace_id,
  pluginId: "automation-runtime",
  permissions: [],
});
export function operationUuid(key: string) {
  const hex = createHash("sha256").update(key).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
export async function pendingDispatches(repo: Repository, deviceId: string) {
  const { rows } = await repo.db.query<Dispatch>(
    "SELECT * FROM taskasaur.dispatches WHERE device_id=$1 AND status IN ('queued','accepted') ORDER BY created_at LIMIT 100",
    [deviceId],
  );
  const result: Dispatch[] = [];
  for (const row of rows) {
    if (row.status === "queued" && Date.parse(row.expires_at) < Date.now())
      await reportDispatch(repo, row, "expired", null);
    else
      result.push({ ...row, signals: await pendingSignals(repo, row.run_id) });
  }
  return result;
}
export async function reportDispatch(
  repo: Repository,
  dispatch: Dispatch,
  status: string,
  output: Value,
  engineRunId?: string,
) {
  invariant(
    ["accepted", "completed", "failed", "cancelled", "expired"].includes(
      status,
    ),
    "VALIDATION_FAILED",
    "Invalid execution status",
  );
  return repo.db.transaction(async (tx) => {
    const repository = new Repository(tx),
      principal = dispatchPrincipal(dispatch);
    await tx.query(
      "SELECT id FROM taskasaur.workspaces WHERE id=$1 FOR UPDATE",
      [dispatch.workspace_id],
    );
    const row = (
      await tx.query<Dispatch>(
        "SELECT * FROM taskasaur.dispatches WHERE run_id=$1 AND device_id=$2 FOR UPDATE",
        [dispatch.run_id, dispatch.device_id],
      )
    ).rows[0];
    invariant(
      row && row.assignment_epoch === dispatch.assignment_epoch,
      "LEASE_EXPIRED",
      "Execution assignment changed",
    );
    if (!["queued", "accepted"].includes(row.status)) return;
    if (status === "accepted")
      invariant(
        row.engine_run_id == null || row.engine_run_id === engineRunId,
        "LEASE_EXPIRED",
        "Another engine run owns this assignment",
      );
    const current = await repository.get(principal, dispatch.run_id);
    await repository.mutate(principal, {
      id: randomUUID(),
      resourceId: current.id,
      pluginId: "automation-runtime",
      collection: "workflow_runs",
      operation: "put",
      baseRevision: current.revision,
      createdAt: new Date().toISOString(),
      data: {
        ...current.data,
        status: status === "accepted" ? "running" : status,
        output: status === "completed" ? output : current.data.output,
        started_at: current.data.started_at ?? new Date().toISOString(),
        ended_at: status === "accepted" ? null : new Date().toISOString(),
        error: status === "failed" ? "Workflow execution failed" : null,
      },
    });
    await tx.query(
      "UPDATE taskasaur.dispatches SET status=$2,engine_run_id=COALESCE(engine_run_id,$3) WHERE run_id=$1",
      [dispatch.run_id, status, engineRunId ?? null],
    );
  });
}
export async function executeWorkflowCommand(
  repo: Repository,
  dispatch: Dispatch,
  command: string,
  input: unknown,
  operationId: string,
): Promise<Value> {
  invariant(
    allNodes(dispatch.execution.graph).some(
      (n) => n.type === "command" && n.config.command === command,
    ),
    "UNDECLARED_COMMAND",
    "Command is not part of the published workflow",
  );
  const row = (
    await repo.db.query<Dispatch>(
      "SELECT * FROM taskasaur.dispatches WHERE run_id=$1",
      [dispatch.run_id],
    )
  ).rows[0];
  invariant(
    row &&
      row.device_id === dispatch.device_id &&
      row.assignment_epoch === dispatch.assignment_epoch &&
      !row.cancel_requested &&
      ["queued", "accepted"].includes(row.status),
    "LEASE_EXPIRED",
    "Run is no longer active",
  );
  const [collection, action] = command.split("."),
    principal = dispatchPrincipal(dispatch);
  await repo.requirePlugin(principal, "automation-runtime");
  const device = await repo.get(principal, dispatch.device_id);
  invariant(
    !device.data.revoked,
    "PERMISSION_DENIED",
    "Runner access was revoked",
  );
  if (
    !schemaById.has(collection) ||
    !["list", "put", "delete"].includes(action)
  ) {
    const provider = [...manifestById.values()].find((manifest) =>
      manifest.provides.commands.includes(command),
    );
    invariant(
      provider,
      "UNDECLARED_COMMAND",
      "Command provider is unavailable",
    );
    await repo.requirePlugin(principal, provider.id);
    const router = await routerFor(repo, principal),
      host = await serverPluginHost(repo, principal, router);
    try {
      const result = await router.receive(
        { jsonrpc: "2.0", id: operationId, method: command, params: input },
        {
          principal: {
            ...principal,
            permissions: [router.permissionFor(command) ?? command],
          },
          signal: AbortSignal.timeout(30000),
          mutationId: operationId,
        },
      );
      invariant(
        result && "result" in result,
        "COMMAND_FAILED",
        "Workflow plugin command failed",
      );
      return result.result as Value;
    } finally {
      await host.close();
    }
  }
  const schema = getSchema(collection);
  await repo.requirePlugin(principal, schema.pluginId);
  if (action === "list")
    return (await repo.list(
      principal,
      collection,
      (input as { query?: never })?.query,
    )) as unknown as Value;
  invariant(
    action === "put" || action === "delete",
    "UNDECLARED_COMMAND",
    "Unsupported workflow command",
  );
  invariant(
    input && typeof input === "object" && !Array.isArray(input),
    "VALIDATION_FAILED",
    "Command input must be a record",
  );
  const params = input as Partial<Mutation>,
    resourceId = params.resourceId ?? operationUuid(operationId + ":resource");
  const data = params.data ?? (input as Record<string, Value>);
  return (await repo.mutate(
    principal,
    {
      id: operationUuid(operationId),
      resourceId,
      collection,
      pluginId: schema.pluginId,
      operation: action,
      baseRevision: params.baseRevision ?? 0,
      data,
      createdAt: new Date(0).toISOString(),
    },
    "plugin",
  )) as unknown as Value;
}
