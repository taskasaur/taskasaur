import assert from "node:assert/strict";
import { TestClient, eventually } from "./client";
const client = await new TestClient().setup();
await client.enable("tasks");
await client.enable("automation-runtime");
const devices = await eventually<any[]>(
  () => client.request("devices"),
  (rows) => rows.some((r) => r.data.platform === "server"),
);
const device = devices.find((r) => r.data.platform === "server");
const workflow = await client.put("automation-runtime", "workflows", {
  name: "Container workflow fixture",
  published_version: 1,
  target_device_id: device.id,
  graph: {
    nodes: [
      {
        id: "create",
        type: "command",
        config: {
          command: "tasks.put",
          input: { data: { title: "Workflow-created fixture" } },
        },
      },
      { id: "wait", type: "wait", config: { seconds: 1 } },
      { id: "out", type: "output", config: {} },
    ],
    edges: [
      { id: "a", source: "create", target: "wait" },
      { id: "b", source: "wait", target: "out" },
    ],
  },
});
const run = await client.request("automation/run", {
  id: workflow.id,
  targetDeviceId: device.id,
});
const synced = await eventually<any>(
  () => client.request("sync?cursor=0"),
  (s) =>
    s.records.some(
      (r: any) =>
        r.id === run.id &&
        ["completed", "failed", "expired"].includes(r.data.status),
    ),
  45000,
);
const completed = synced.records.find((r: any) => r.id === run.id);
assert.equal(completed.data.status, "completed");
assert.equal(completed.data.target_device_id, device.id);
assert(
  synced.records.some(
    (r: any) =>
      r.collection === "tasks" && r.data.title === "Workflow-created fixture",
  ),
);
console.log(
  "PostgreSQL workflow dispatch, selected target, durable wait and core command passed",
);
