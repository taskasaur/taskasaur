import assert from "node:assert/strict";
import { database, closeDatabase } from "../../server/database";
import { migrate } from "../../server/schema";
import { Repository } from "../../server/repository";
import { dispatchWorkflow } from "../../server/dispatch";
import {
  processWorkflowTriggers,
  rotateWorkflowHook,
  receiveWorkflowHook,
  queueWorkflowSignal,
  pendingSignals,
} from "../../server/workflow-triggers";
import { TestClient, eventually } from "./client";
process.loadEnvFile(".env");
process.env.DATABASE_URL = `postgres://postgres:${encodeURIComponent(process.env.POSTGRES_PASSWORD!)}@127.0.0.1:58532/postgres`;
try {
  await migrate(database());
  const client = await new TestClient().setup();
  await client.enable("automation-runtime");
  const devices = await eventually<any[]>(
    () => client.request("devices"),
    (rows) => rows.some((row) => row.data.platform === "server"),
  );
  const device = devices.find((row) => row.data.platform === "server");
  const repo = new Repository(database()),
    actor = {
      workspaceId: client.workspaceId,
      userId: client.userId,
      pluginId: "automation-runtime",
      permissions: [],
    };
  const workflow = await client.put("automation-runtime", "workflows", {
    name: "Schedule fixture",
    target_device_id: device.id,
    enabled: true,
    published_version: 1,
    trigger_kind: "schedule",
    schedule_seconds: 60,
    schedule_start: new Date(Date.now() - 1000).toISOString(),
    graph: { nodes: [{ id: "out", type: "output", config: {} }], edges: [] },
  });
  await processWorkflowTriggers(repo, client.workspaceId);
  await processWorkflowTriggers(repo, client.workspaceId);
  let runs = await repo.list(actor, "workflow_runs");
  assert.equal(
    runs.filter((r) => r.data.workflow_id === workflow.id).length,
    1,
  );
  const hook = await client.put("automation-runtime", "workflows", {
    name: "Webhook fixture",
    target_device_id: device.id,
    enabled: true,
    published_version: 1,
    trigger_kind: "webhook",
    graph: { nodes: [{ id: "out", type: "output", config: {} }], edges: [] },
  });
  const credential = await rotateWorkflowHook(repo, actor, hook.id);
  const once = await receiveWorkflowHook(
      repo,
      hook.id,
      credential.token,
      "external-1",
      { hello: "world" },
    ),
    twice = await receiveWorkflowHook(
      repo,
      hook.id,
      credential.token,
      "external-1",
      { hello: "world" },
    );
  assert.equal(once.id, twice.id);
  await assert.rejects(
    receiveWorkflowHook(repo, hook.id, "wrong", "external-2", null),
    { kind: "PERMISSION_DENIED" },
  );
  await assert.rejects(
    receiveWorkflowHook(repo, hook.id, credential.token, "external-1", {
      changed: true,
    }),
    { kind: "IDEMPOTENCY_CONFLICT" },
  );
  const waiting = await client.put("automation-runtime", "workflows", {
    name: "Signal fixture",
    target_device_id: device.id,
    published_version: 1,
    graph: {
      nodes: [
        {
          id: "wait",
          type: "signal",
          config: { name: "approve", timeout_seconds: 60 },
        },
      ],
      edges: [],
    },
  });
  const run = await dispatchWorkflow(repo, actor, waiting.id, device.id);
  const signalId = crypto.randomUUID();
  await queueWorkflowSignal(
    repo,
    actor,
    run.id,
    "approve",
    { accepted: true },
    signalId,
  );
  await queueWorkflowSignal(
    repo,
    actor,
    run.id,
    "approve",
    { accepted: true },
    signalId,
  );
  assert.equal((await pendingSignals(repo, run.id)).length, 1);
  await assert.rejects(
    queueWorkflowSignal(
      repo,
      actor,
      run.id,
      "unknown",
      null,
      crypto.randomUUID(),
    ),
    { kind: "VALIDATION_FAILED" },
  );
  const latest = await repo.get(actor, waiting.id);
  await repo.mutate(actor, {
    id: crypto.randomUUID(),
    resourceId: waiting.id,
    pluginId: "automation-runtime",
    collection: "workflows",
    baseRevision: latest.revision,
    operation: "put",
    createdAt: new Date().toISOString(),
    data: {
      ...latest.data,
      graph: {
        nodes: [{ id: "out", type: "transform", config: { value: "draft" } }],
        edges: [],
      },
    },
  });
  const pinned = await dispatchWorkflow(repo, actor, waiting.id, device.id);
  const dispatch = (
    await database().query<{ execution: any }>(
      "SELECT execution FROM taskasaur.dispatches WHERE run_id=$1",
      [pinned.id],
    )
  ).rows[0];
  assert.equal(dispatch.execution.graph.nodes[0].type, "signal");
  assert.equal(dispatch.execution.interpreterVersion, 2);
  console.log(
    "Schedule occurrence deduplication, webhook rotation/authentication/idempotency, signal inbox and immutable published graphs passed",
  );
} finally {
  await closeDatabase();
}
