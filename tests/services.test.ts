import { it, expect } from "vitest";
import { DeviceCore } from "../packages/core/device";
import { MemoryStorage } from "../packages/storage";
import {
  assignService,
  assignedService,
  releaseService,
} from "../packages/core/services";
import { Replica } from "../packages/core/replica";
it("requires the old execution device to drain and release before moving a background service", async () => {
  const a = await DeviceCore.open(new MemoryStorage(), "Owner"),
    b = await DeviceCore.open(new MemoryStorage(), "Computer", () => [
      "core.services.release",
    ]),
    owner = await a.createWorkspace("Services"),
    worker = await b.join(
      await a.approve(owner.replica.workspaceId, b.pairingRequest()),
    );
  let drains = 0;
  worker.protocol.setHandler(async (command, input) => {
    expect(command).toBe("core.services.release");
    const value = input as { id: string; token: string };
    await releaseService(worker, value.id, value.token, async () => {
      drains++;
    });
    return { ok: true };
  });
  a.attachTransport({
    request: async (_address, packet) => worker.protocol.receive(packet),
    addresses: () => [],
    close: async () => {},
  });
  await a.setPeers(owner.replica.workspaceId, ["worker"]);
  await assignService(owner, "email-client", b.identity.id);
  await owner.synchronize();
  expect(await assignedService(worker, "email-client")).toBe(true);
  await expect(
    owner.replica.update("setting/service.email-client", {
      deviceId: a.identity.id,
      generation: crypto.randomUUID(),
    }),
  ).rejects.toThrow("release");
  await assignService(owner, "email-client", a.identity.id);
  await owner.synchronize();
  expect(drains).toBe(1);
  expect(await assignedService(worker, "email-client")).toBe(false);
  expect(await assignedService(owner, "email-client")).toBe(true);
  const restarted = await new Replica(
    owner.replica.identity,
    owner.replica.access,
    owner.replica.storage,
  ).open();
  expect(restarted.read("setting/service.email-client")).toEqual(
    owner.replica.read("setting/service.email-client"),
  );
  await expect(
    worker.replica.update("setting/service.email-client", {
      deviceId: b.identity.id,
    }),
  ).rejects.toThrow("owner");
});
