import { it, expect } from "vitest";
import { DeviceCore } from "../packages/core/device";
import { MemoryStorage } from "../packages/storage";
import { PortableWorkflows } from "../packages/core/workflows";
import { deviceRecordId } from "../packages/core/records";
import { exportBackup, restoreBackup } from "../packages/core/backup";
import { LocalState } from "../packages/core/local-state";
const graph = {
  nodes: [
    { id: "input", type: "input", config: {} },
    { id: "result", type: "transform", config: { value: "published" } },
  ],
  edges: [{ id: "e", source: "input", target: "result" }],
};
it("runs pinned portable graphs, preserves checkpoints, and never replays completed runs", async () => {
  const core = await DeviceCore.open(new MemoryStorage(), "Phone"),
    node = await core.createWorkspace("Portable"),
    target = deviceRecordId(core.identity.id);
  const workflow = await node.records.put("workflows", {
    name: "Test",
    graph,
    published_version: 1,
    target_device_id: target,
  });
  await node.records.put(
    "workflows",
    {
      ...workflow.data,
      graph: {
        ...graph,
        nodes: [{ id: "draft", type: "transform", config: { value: "draft" } }],
        edges: [],
      },
    },
    workflow.id,
  );
  const engine = new PortableWorkflows(
      node,
      { deviceId: target, call: async () => null },
      () => ({ enabled: true, trustedCode: false }),
    ),
    operation = crypto.randomUUID();
  await engine.start({
    id: workflow.id,
    targetDeviceId: target,
    operationId: operation,
  });
  await engine.close();
  expect(node.records.get(operation)?.data.output).toBe("published");
  const revision = node.records.get(operation)?.revision;
  await new PortableWorkflows(
    node,
    {
      deviceId: target,
      call: async () => {
        throw Error("replayed");
      },
    },
    () => ({ enabled: true, trustedCode: false }),
  ).tick();
  expect(node.records.get(operation)?.revision).toBe(revision);
  await expect(
    engine.start({ id: workflow.id, targetDeviceId: crypto.randomUUID() }),
  ).rejects.toThrow("explicitly");
});
it("does not execute a replicated job document without a device-local accepted intent", async () => {
  const core = await DeviceCore.open(new MemoryStorage(), "Phone"),
    node = await core.createWorkspace("Portable"),
    target = deviceRecordId(core.identity.id);
  await node.replica.update("job/" + crypto.randomUUID(), {
    execution: {
      id: crypto.randomUUID(),
      targetDeviceId: target,
      graph,
      input: {},
      allowTrustedCode: false,
    },
    state: "running",
  });
  const engine = new PortableWorkflows(
    node,
    {
      deviceId: target,
      call: async () => {
        throw Error("Executed replicated data");
      },
    },
    () => ({ enabled: true, trustedCode: false }),
  );
  await engine.tick();
  expect(node.records.all().length).toBe(0);
});
it("restores encrypted identity and data, refuses wrong passwords and nonempty stores", async () => {
  const core = await DeviceCore.open(new MemoryStorage(), "Laptop"),
    node = await core.createWorkspace("Backup");
  await node.records.put("variables", {
    name: "Saved",
    value: "private",
    value_type: "text",
  });
  const backup = await exportBackup(
    core.storage,
    "correct horse battery staple",
  );
  expect(backup).not.toContain("private");
  const target = new MemoryStorage();
  await expect(
    restoreBackup(target, backup, "wrong passphrase"),
  ).rejects.toThrow();
  expect(await target.keys("")).toEqual([]);
  await restoreBackup(target, backup, "correct horse battery staple");
  const restored = await DeviceCore.open(target, "Restored");
  expect(restored.identity.id).toBe(core.identity.id);
  expect(
    (await restored.workspace(node.replica.workspaceId)).records.all()[0].data
      .value,
  ).toBe("private");
  await expect(
    restoreBackup(target, backup, "correct horse battery staple"),
  ).rejects.toThrow("empty");
});
it("stops an interrupted external step rather than executing it again", async () => {
  const core = await DeviceCore.open(new MemoryStorage(), "Phone"),
    node = await core.createWorkspace("Portable"),
    target = deviceRecordId(core.identity.id);
  const workflow = await node.records.put("workflows", {
    name: "External",
    graph: {
      nodes: [
        { id: "send", type: "command", config: { command: "mail.send" } },
      ],
      edges: [],
    },
    published_version: 1,
    target_device_id: target,
  });
  const id = crypto.randomUUID(),
    pin = node.replica.read<any>("setting/workflow." + workflow.id + ".1");
  await new LocalState(node.replica, "workflow-checkpoints").set(id, {
    execution: {
      id,
      targetDeviceId: target,
      graph: pin.graph,
      input: {},
      allowTrustedCode: false,
    },
    workflowId: workflow.id,
    version: 1,
    steps: { send: { status: "started" } },
    signals: {},
    status: "running",
  });
  let calls = 0;
  const engine = new PortableWorkflows(
    node,
    {
      deviceId: target,
      call: async () => {
        calls++;
        return null;
      },
    },
    () => ({ enabled: true, trustedCode: false }),
  );
  await engine.tick();
  expect(calls).toBe(0);
  expect(node.records.get(id)?.data.status).toBe("failed");
  expect(node.records.get(id)?.data.error).toContain("interrupted");
});
