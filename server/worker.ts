import { processSchedules } from "./schedules";
import {
  processWorkflowTriggers,
  acknowledgeSignal,
} from "./workflow-triggers";
import { createHash, randomUUID } from "node:crypto";
import { database } from "./database";
import { Repository } from "./repository";
import { migrate } from "./schema";
import { createAutomationEngine, type WorkflowExecution } from "./automation";
import { startGateway } from "./gateway";
import { CoreError, invariant } from "../packages/core/errors";
import type { Principal } from "../packages/plugin-sdk";
import type { Value } from "../packages/field-types";
import { getSchema } from "../packages/core/catalog";
import { routerFor } from "./api";
import {
  pendingDispatches,
  reportDispatch,
  executeWorkflowCommand,
  dispatchPrincipal,
  type Dispatch,
} from "./runner-dispatch";
import { loadPackageCatalog } from "./plugin-packages";
import { processBackground } from "./background";
const db = database(),
  repo = new Repository(db);
await loadPackageCatalog();
await migrate(db);
const gateway = startGateway();
let stopping = false;
const engines = new Map<
  string,
  Awaited<ReturnType<typeof createAutomationEngine>>
>();
function serverId(workspaceId: string) {
  const hash = createHash("sha256")
    .update(
      `taskasaur-server:${process.env.SERVER_WORKER_ID ?? "primary"}:${workspaceId}`,
    )
    .digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
async function engineFor(principal: Principal, deviceId: string) {
  let engine = engines.get(deviceId);
  if (engine) return engine;
  engine = await createAutomationEngine(
    {
      deviceId,
      call: async (command, input, operationId) => {
        const runId = operationId.split(":")[0];
        const dispatch = (
          await db.query<Dispatch>(
            "SELECT * FROM taskasaur.dispatches WHERE run_id=$1 AND device_id=$2",
            [runId, deviceId],
          )
        ).rows[0];
        invariant(dispatch, "LEASE_EXPIRED", "Run assignment is unavailable");
        return executeWorkflowCommand(
          repo,
          dispatch,
          command,
          input,
          operationId,
        );
      },
    },
    { kind: "postgres", url: process.env.DATABASE_URL! },
  );
  await engine.worker.start();
  engines.set(deviceId, engine);
  return engine;
}
async function tick() {
  await processBackground(repo);
  const workspaces = await db.query<{ id: string; owner_id: string }>(
    "SELECT id,owner_id FROM taskasaur.workspaces",
  );
  for (const workspace of workspaces.rows) {
    const principal: Principal = {
        workspaceId: workspace.id,
        userId: workspace.owner_id,
        pluginId: "jobs",
        permissions: [],
      },
      deviceId = serverId(workspace.id);
    const existing = await db.query(
      "SELECT id FROM taskasaur.resources WHERE id=$1",
      [deviceId],
    );
    if (!existing.rows.length)
      await repo.mutate(principal, {
        id: randomUUID(),
        resourceId: deviceId,
        pluginId: "devices",
        collection: "devices",
        operation: "put",
        baseRevision: 0,
        createdAt: new Date().toISOString(),
        data: {
          name: "Taskasaur server",
          platform: "server",
          capabilities: ["automation.execute"],
          last_seen: new Date().toISOString(),
        },
      });
    else
      await db.query(
        "UPDATE taskasaur.p_devices SET last_seen=now() WHERE id=$1",
        [deviceId],
      );
    await processWorkflowTriggers(repo, workspace.id);
    const dispatches = await pendingDispatches(repo, deviceId);
    for (const dispatch of dispatches) {
      const engine = await engineFor(dispatchPrincipal(dispatch), deviceId);
      let engineRunId = dispatch.engine_run_id;
      if (!engineRunId) {
        const handle = await engine.run(dispatch.execution);
        engineRunId = handle.workflowRun.id;
        await reportDispatch(repo, dispatch, "accepted", null, engineRunId);
      }
      if (dispatch.cancel_requested)
        await engine.engine
          .cancelWorkflowRun(engineRunId)
          .catch(() => undefined);
      for (const signal of dispatch.signals ?? []) {
        const delivered = await engine.engine.sendSignal({
          signal: dispatch.run_id + ":" + signal.name,
          data: signal.data,
        });
        if (delivered.workflowRunIds.includes(engineRunId))
          await acknowledgeSignal(repo, dispatch.run_id, signal.id);
      }
      const run = await engine.backend.getWorkflowRun({
        workflowRunId: engineRunId,
      });
      if (
        run &&
        ["completed", "succeeded", "failed", "canceled"].includes(run.status)
      )
        await reportDispatch(
          repo,
          dispatch,
          run.status === "canceled"
            ? "cancelled"
            : run.status === "failed"
              ? "failed"
              : "completed",
          run.output as Value,
        );
    }
    await processSchedules(repo, workspace.id);
  }
}
const stop = async () => {
  stopping = true;
  gateway.stop();
  for (const engine of engines.values()) await engine.stop();
  process.exit(0);
};
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
while (!stopping) {
  try {
    await tick();
  } catch (error) {
    console.error(
      error instanceof CoreError
        ? `${error.kind}: ${error.message}`
        : "Worker operation failed",
    );
  }
  await new Promise((resolve) => setTimeout(resolve, 5000));
}
