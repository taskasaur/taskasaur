import { it, expect } from "vitest";
import { DeviceCore } from "../packages/core/device";
import { MemoryStorage } from "../packages/storage";
import {
  configureExecution,
  bindingFor,
  executionActive,
  executionRecord,
  executionRequirements,
  inspectExecution,
  requireExecution,
  slotFor,
  executionServiceId,
} from "../packages/core/execution";
import { releaseService, serviceToken } from "../packages/core/services";
import { deviceRecordId } from "../packages/core/records";
import { currentPolicy } from "../packages/core/identity";
import {
  catalog,
  getSchema,
  validateExtension,
} from "@taskasaur/platform/core/catalog";
import type { DevicePluginStatus } from "@taskasaur/platform/plugin-sdk/execution";

async function fixture() {
  const a = await DeviceCore.open(new MemoryStorage(), "Laptop", () => [
    "core.plugins.status",
    "core.services.release",
    "automation.execute",
  ]);
  const b = await DeviceCore.open(new MemoryStorage(), "Desktop", () => [
    "core.plugins.status",
    "core.services.release",
    "automation.execute",
  ]);
  const owner = await a.createWorkspace("Execution"),
    worker = await b.join(
      await a.approve(owner.replica.workspaceId, b.pairingRequest()),
    );
  const status = (id: string): DevicePluginStatus => ({
    deviceId: id,
    plugins: catalog.map((m) => ({
      id: m.id,
      version: m.version,
      installed: true,
      enabled: true,
    })),
    capabilities: ["automation.execute"],
    canInstall: true,
  });
  let workerStatus = status(b.identity.id),
    drains = 0;
  for (const node of [owner, worker])
    node.protocol.setHandler(async (command, input) => {
      if (command === "core.plugins.status")
        return node === owner ? status(a.identity.id) : workerStatus;
      if (command === "core.services.release") {
        const request = input as {
          id: string;
          token: string;
          successor: { deviceId: string; generation: string };
        };
        await releaseService(
          node,
          request.id,
          request.token,
          async () => {
            drains++;
          },
          request.successor,
        );
        return { ok: true };
      }
      throw Error(command);
    });
  a.attachTransport({
    request: async (_address, packet) => worker.protocol.receive(packet),
    addresses: () => [],
    close: async () => {},
  });
  await a.setPeers(owner.replica.workspaceId, ["worker"]);
  await owner.synchronize();
  const item = await owner.records.put("workflows", {
    name: "Example",
    graph: { nodes: [], edges: [] },
  });
  return {
    a,
    b,
    owner,
    worker,
    item,
    slot: slotFor(item)!,
    drains: () => drains,
    setStatus: (value: DevicePluginStatus) => (workerStatus = value),
    workerStatus: () => workerStatus,
  };
}
it("assigns two items independently, pauses one, and requires a signed handoff", async () => {
  const f = await fixture(),
    second = await f.owner.records.put("workflows", {
      name: "Second",
      graph: { nodes: [], edges: [] },
    });
  await configureExecution(f.owner, f.item, f.slot, f.b.identity.id, true);
  await configureExecution(f.owner, second, f.slot, f.a.identity.id, true);
  await f.owner.synchronize();
  expect(
    await executionActive(f.worker, f.worker.records.get(f.item.id)!),
  ).toBe(true);
  await expect(
    requireExecution(f.owner, f.owner.records.get(f.item.id)!),
  ).rejects.toThrow("assigned computer");
  const first = bindingFor(f.owner, f.slot, f.item.id)!;
  await configureExecution(
    f.owner,
    f.owner.records.get(second.id)!,
    f.slot,
    f.a.identity.id,
    false,
  );
  await f.owner.synchronize();
  expect(await executionActive(f.owner, f.owner.records.get(second.id)!)).toBe(
    false,
  );
  expect(
    await executionActive(f.worker, f.worker.records.get(f.item.id)!),
  ).toBe(true);
  await expect(
    f.owner.replica.update(
      "setting/service." + executionServiceId(f.slot, f.item.id),
      { ...first, deviceId: f.a.identity.id, generation: crypto.randomUUID() },
    ),
  ).rejects.toThrow("release");
  await configureExecution(
    f.owner,
    f.owner.records.get(f.item.id)!,
    f.slot,
    f.a.identity.id,
    true,
  );
  await f.owner.synchronize();
  expect(f.drains()).toBe(1);
  expect(
    await executionActive(f.worker, f.worker.records.get(f.item.id)!),
  ).toBe(false);
  expect(await executionActive(f.owner, f.owner.records.get(f.item.id)!)).toBe(
    true,
  );
  expect(await executionActive(f.owner, f.owner.records.get(second.id)!)).toBe(
    false,
  );
});
it("reports actual installed/enabled/version status and never labels offline peers ready", async () => {
  const f = await fixture();
  f.setStatus({
    ...f.workerStatus(),
    plugins: f
      .workerStatus()
      .plugins.map((p) =>
        p.id === "automation-runtime" ? { ...p, enabled: false } : p,
      ),
  });
  let state = await inspectExecution(f.owner, f.item, f.slot),
    worker = state.candidates.find((p) => p.id === f.b.identity.id)!;
  expect(worker.ready).toBe(false);
  expect(worker.missingPlugins).toContainEqual({
    id: "automation-runtime",
    reason: "disabled",
  });
  f.setStatus({ ...f.workerStatus(), plugins: [] });
  worker = (await inspectExecution(f.owner, f.item, f.slot)).candidates.find(
    (p) => p.id === f.b.identity.id,
  )!;
  expect(worker.missingPlugins[0].reason).toBe("missing");
  f.setStatus({
    ...f.workerStatus(),
    plugins: catalog.map((m) => ({
      id: m.id,
      version: m.version,
      installed: true,
      enabled: true,
    })),
  });
  worker = (
    await inspectExecution(f.owner, f.item, {
      ...f.slot,
      plugins: [{ id: "automation-runtime", version: "9.0.0" }],
    })
  ).candidates.find((p) => p.id === f.b.identity.id)!;
  expect(worker.missingPlugins).toContainEqual({
    id: "automation-runtime",
    version: "9.0.0",
    reason: "version",
  });
  f.owner.peerDevices.get(f.b.identity.id)!.lastSeen = 0;
  worker = (await inspectExecution(f.owner, f.item, f.slot)).candidates.find(
    (p) => p.id === f.b.identity.id,
  )!;
  expect(worker.online).toBe(false);
  expect(worker.statusKnown).toBe(false);
  expect(worker.ready).toBe(false);
  expect(worker.canInstall).toBe(false);
});
it("fences a released generation across pause/resume and refuses a different successor", async () => {
  const f = await fixture();
  await configureExecution(f.owner, f.item, f.slot, f.b.identity.id, true);
  await f.owner.synchronize();
  const assignment = bindingFor(f.worker, f.slot, f.item.id)!,
    id = executionServiceId(f.slot, f.item.id),
    successor = { deviceId: f.a.identity.id, generation: crypto.randomUUID() };
  await releaseService(
    f.worker,
    id,
    await serviceToken(assignment),
    undefined,
    successor,
  );
  await expect(
    releaseService(f.worker, id, await serviceToken(assignment), undefined, {
      ...successor,
      generation: crypto.randomUUID(),
    }),
  ).rejects.toThrow("another assignment");
  await f.worker.replica.update("setting/service." + id, {
    ...assignment,
    enabled: false,
  });
  await f.worker.replica.update("setting/service." + id, {
    ...assignment,
    enabled: true,
  });
  expect(
    await executionActive(f.worker, f.worker.records.get(f.item.id)!),
  ).toBe(false);
  await expect(
    f.worker.replica.update("setting/service." + id, {
      ...assignment,
      generation: crypto.randomUUID(),
    }),
  ).rejects.toThrow("generation");
  await f.owner.synchronize();
  await configureExecution(
    f.owner,
    f.owner.records.get(f.item.id)!,
    f.slot,
    f.a.identity.id,
    true,
  );
  expect(bindingFor(f.owner, f.slot, f.item.id)?.generation).toBe(
    successor.generation,
  );
});
it("keeps replicated content free of targets and prevents viewers from assigning work", async () => {
  const f = await fixture();
  const variable = await f.owner.records.put("variables", {
    name: "Synced",
    value: "hello",
    value_type: "text",
  });
  expect(slotFor(variable)).toBeUndefined();
  expect(
    executionRecord(f.owner, "variables.put", { id: variable.id }),
  ).toBeUndefined();
  const viewer = await DeviceCore.open(new MemoryStorage(), "Viewer"),
    readOnly = await viewer.join(
      await f.a.approve(
        f.owner.replica.workspaceId,
        viewer.pairingRequest(),
        "viewer",
      ),
    );
  await expect(
    configureExecution(readOnly, f.item, f.slot, f.b.identity.id, true),
  ).rejects.toThrow("read-only");
  expect(
    currentPolicy(readOnly.replica.access).members[viewer.identity.id].role,
  ).toBe("viewer");
});
it("validates execution declarations and infers TypeScript capability from the workflow graph", async () => {
  const f = await fixture(),
    manifest = catalog.find((m) => m.id === "automation-runtime")!,
    schemas = [getSchema("workflows"), getSchema("workflow_runs")];
  const definition = {
    id: "run",
    label: "Run",
    collection: "workflows",
    targetField: "target_device_id",
    enabledField: "enabled",
  };
  expect(() =>
    validateExtension({ ...manifest, execution: [definition] }, schemas),
  ).not.toThrow();
  expect(() =>
    validateExtension(
      { ...manifest, execution: [{ ...definition, targetField: "name" }] },
      schemas,
    ),
  ).toThrow("UUID/boolean");
  expect(() =>
    validateExtension(
      {
        ...manifest,
        execution: [{ id: "run", label: "Run", collection: "tasks" }],
      },
      schemas,
    ),
  ).toThrow("plugin collection");
  expect(
    executionRequirements(f.slot, {
      ...f.item,
      data: {
        ...f.item.data,
        graph: {
          nodes: [
            { id: "code", type: "typescript", config: { source: "return 1;" } },
          ],
          edges: [],
        },
      },
    }).capabilities,
  ).toContain("automation.typescript");
  expect(
    executionRecord(f.owner, "automation.run", { id: f.item.id })?.record.id,
  ).toBe(f.item.id);
  expect(deviceRecordId(f.b.identity.id)).not.toBe(f.b.identity.id);
});
