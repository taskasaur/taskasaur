import { describe, it, expect } from "vitest";
import { DeviceCore, type WorkspaceNode } from "../packages/core/device";
import { MemoryStorage } from "../packages/storage";
import { PeerSync, type PeerTransport } from "../packages/sync/protocol";
import { storageService } from "../packages/core/storage-service";
import { catalogKey, itemKey } from "../packages/core/storage-placement";
import { canonical } from "../packages/core/crypto";
import type { StorageItem } from "@taskasaur/platform/plugin-sdk/storage-placement";

async function pair(role: "editor" | "viewer" = "editor") {
  const ca = await DeviceCore.open(new MemoryStorage(), "Laptop"),
    cb = await DeviceCore.open(new MemoryStorage(), "Server");
  const a = await ca.createWorkspace("Storage");
  const b = await cb.join(
    await ca.approve(a.replica.workspaceId, cb.pairingRequest(), role),
  );
  let online = true;
  const peers: Record<string, WorkspaceNode> = { a, b };
  function transport(from: string): PeerTransport {
    return {
      request: async (address, packet) => {
        if (!online) throw Error("Offline");
        return peers[address].protocol.receive(packet, from);
      },
      addresses: () => [from],
      close: async () => {},
    };
  }
  a.link.peers = ["b"];
  b.link.peers = ["a"];
  a.sync = new PeerSync(a.protocol, transport("a"));
  b.sync = new PeerSync(b.protocol, transport("b"));
  const record = await a.records.put("variables", {
    name: "Content",
    value_type: "text",
    value: "Original content",
  });
  const item: StorageItem = { kind: "record", id: record.id };
  await a.synchronize();
  await b.synchronize();
  return {
    a,
    b,
    ca,
    cb,
    item,
    record,
    offline: (off: boolean) => {
      online = !off;
    },
  };
}

describe("core storage placement and version handoffs", () => {
  it("hands off exact heads, forgets payload durably, and restores full history on request", async () => {
    const { a, b, ca, item, record } = await pair();
    await a.records.put(
      "variables",
      { ...record.data, value: "Second revision" },
      record.id,
    );
    const originalChange = a.replica
      .entries()
      .find((c) => c.documentId === "record/" + record.id)!;
    await a.protocol.storage.setCopy(item, a.replica.identity.id, false);
    await a.synchronize();
    expect(a.records.get(record.id)).toBeUndefined();
    // Even the device's own historical signed changes are unwanted when replayed by a peer.
    await a.replica.accept(originalChange);
    expect(a.records.get(record.id)).toBeUndefined();
    expect(b.records.get(record.id)?.data.value).toBe("Second revision");
    expect(
      a.replica.entries().some((c) => c.documentId === "record/" + record.id),
    ).toBe(false);
    const restarted = await DeviceCore.open(ca.storage, "Laptop");
    const restored = await restarted.workspace(a.replica.workspaceId);
    expect(restored.records.get(record.id)).toBeUndefined();
    expect((await restored.protocol.storage.status(item)).local).toBe(false);
    await expect(
      restored.records.put("variables", record.data, record.id),
    ).rejects.toThrow("Retain");
    await a.synchronize();
    expect(a.records.get(record.id)).toBeUndefined();
    await a.protocol.storage.setCopy(item, a.replica.identity.id, true);
    await a.synchronize();
    expect(a.records.get(record.id)?.data.value).toBe("Second revision");
    expect(a.replica.heads("record/" + record.id)).toEqual(
      b.replica.heads("record/" + record.id),
    );
  });
  it("preserves the last copy when targets are offline or concurrently turn retention off", async () => {
    const { a, b, item, record, offline } = await pair();
    await a.records.put(
      "variables",
      { ...record.data, value: "Only on laptop" },
      record.id,
    );
    await a.protocol.storage.setCopy(item, a.replica.identity.id, false);
    offline(true);
    await a.synchronize();
    expect(a.records.get(record.id)?.data.value).toBe("Only on laptop");
    await b.protocol.storage.setCopy(item, b.replica.identity.id, false);
    offline(false);
    await Promise.all([a.synchronize(), b.synchronize()]);
    expect(a.records.get(record.id)?.data.value).toBe("Only on laptop");
    await a.synchronize();
    await b.synchronize();
    expect(a.records.get(record.id)).toBeDefined();
    await a.protocol.storage.setCopy(item, b.replica.identity.id, true);
    await a.synchronize();
    expect(a.records.get(record.id)).toBeUndefined();
    expect(b.records.get(record.id)?.data.value).toBe("Only on laptop");
  });
  it("accepts a later retained head only when it includes the reviewed history", async () => {
    const { a, b, item, record } = await pair();
    const version = await a.protocol.storage.version(item);
    await b.records.put(
      "variables",
      { ...record.data, value: "Later version" },
      record.id,
    );
    const receipt = await b.protocol.storage.retain(item, version);
    expect(receipt.token).toBe(version.token);
    await a.protocol.storage.setCopy(item, a.replica.identity.id, false);
    await a.synchronize();
    expect(a.records.get(record.id)).toBeUndefined();
    expect(b.records.get(record.id)?.data.value).toBe("Later version");
  });
  it("requires an unchanged reviewed version, preserves concurrent edits, and binds receipts to signers", async () => {
    const { a, b, item, record } = await pair();
    const reviewed = await a.protocol.storage.version(item);
    await a.records.put(
      "variables",
      { ...record.data, value: "Changed" },
      record.id,
    );
    await expect(
      a.protocol.storage.deleteVersion(item, reviewed.token),
    ).rejects.toThrow("changed");
    const current = await a.protocol.storage.version(item);
    await b.records.put(
      "variables",
      { ...record.data, name: "Offline name" },
      record.id,
    );
    await a.protocol.storage.deleteVersion(item, current.token);
    await a.protocol.storage.reconcile(async () => false);
    expect(a.records.get(record.id)).toBeUndefined();
    // The offline branch has different heads and is not erased by another version's deletion.
    await b.synchronize();
    expect(b.records.get(record.id)?.data.name).toBe("Offline name");
    const receipt = `setting/storage.receipt.${itemKey(item)}.${b.replica.identity.id}`;
    await expect(
      a.replica.update(receipt, {
        item,
        token: current.token,
        retained: true,
        deviceId: b.replica.identity.id,
      }),
    ).rejects.toThrow("retaining device");
    await expect(
      a.replica.update(
        `setting/storage.delete.${itemKey(item)}.${current.token}`,
        { item, token: current.token, heads: reviewed.heads, confirmed: true },
      ),
    ).rejects.toThrow("reviewed version");
  });
  it("deletes an explicitly confirmed version on every connected replica without redownloading", async () => {
    const { a, b, item, record } = await pair();
    await a.protocol.storage.deleteVersion(
      item,
      (await a.protocol.storage.version(item)).token,
    );
    await a.synchronize();
    await b.synchronize();
    await a.synchronize();
    expect(a.records.get(record.id)).toBeUndefined();
    expect(b.records.get(record.id)).toBeUndefined();
    expect((await b.protocol.storage.status(item)).deleted).toBe(true);
    expect(a.replica.read(catalogKey(record.id))).toBeDefined();
  });
  it("handles individual file versions, deduplicated chunks and restarting a released version", async () => {
    const { a, b, ca } = await pair();
    const file = await a.records.put("files", {
      name: "Shared.txt",
      size: "12",
      media_type: "text/plain",
    });
    const bytes = new TextEncoder().encode("Shared bytes");
    const v1 = await a.protocol.files.save(file.id, bytes, "text/plain", null);
    const v2 = await a.protocol.files.save(file.id, bytes, "text/plain", v1.id);
    await a.synchronize();
    const item: StorageItem = { kind: "file-version", id: v1.id };
    await a.protocol.storage.setCopy(item, a.replica.identity.id, false);
    await a.synchronize();
    await expect(a.protocol.files.read(v1.id)).rejects.toThrow(
      "another device",
    );
    expect((await a.protocol.files.read(v2.id)).bytes).toEqual(bytes);
    const restored = await (
      await DeviceCore.open(ca.storage, "Laptop")
    ).workspace(a.replica.workspaceId);
    await expect(restored.protocol.files.read(v1.id)).rejects.toThrow(
      "another device",
    );
    await a.protocol.storage.setCopy(item, a.replica.identity.id, true);
    await a.synchronize();
    expect((await a.protocol.files.read(v1.id)).bytes).toEqual(bytes);
    for (const id of [v1.id, v2.id]) {
      const target = { kind: "file-version" as const, id };
      await a.protocol.storage.deleteVersion(
        target,
        (await a.protocol.storage.version(target)).token,
      );
    }
    await a.synchronize();
    await b.synchronize();
    expect(await a.protocol.files.getChunk(v1.chunks[0])).toBeUndefined();
    expect(await b.protocol.files.getChunk(v1.chunks[0])).toBeUndefined();
  });
  it("limits plugin controls to owned items and denies read-only placement writes", async () => {
    const { a, b, item } = await pair("viewer");
    await expect(
      storageService(a, "tasks").setCopy(item, a.replica.identity.id, false),
    ).rejects.toThrow("another plugin");
    await expect(
      b.protocol.storage.setCopy(item, a.replica.identity.id, false),
    ).rejects.toThrow("editor");
    await expect(
      b.sync!.request("a", {
        kind: "storage-retain",
        item,
        version: await b.protocol.storage.version(item),
      }),
    ).rejects.toThrow("editor");
    expect((await storageService(a, "variables").list()).length).toBe(1);
  });
  it("does not resurrect partial data after interrupted journal cleanup", async () => {
    const { a, b, ca, item, record } = await pair();
    const remove = ca.storage.delete.bind(ca.storage);
    let fail = true;
    ca.storage.delete = async (key) => {
      if (fail && key.includes("/changes/")) {
        fail = false;
        throw Error("Interrupted cleanup");
      }
      await remove(key);
    };
    await a.protocol.storage.setCopy(item, a.replica.identity.id, false);
    await expect(a.synchronize()).rejects.toThrow("Interrupted cleanup");
    const restored = await (
      await DeviceCore.open(ca.storage, "Restarted")
    ).workspace(a.replica.workspaceId);
    expect(restored.records.get(record.id)).toBeUndefined();
    expect(
      restored.replica
        .entries()
        .some((c) => c.documentId === "record/" + record.id),
    ).toBe(false);
    expect(b.records.get(record.id)).toBeDefined();
  });
  it("replicates discovery before content and allows remote-only devices to change placement", async () => {
    const { a, b } = await pair();
    const record = await a.records.put("variables", {
      name: "Remote only",
      value_type: "text",
      value: "No browser copy",
    });
    const item = { kind: "record" as const, id: record.id };
    await a.protocol.storage.setCopy(item, b.replica.identity.id, false);
    await a.synchronize();
    expect(b.records.get(record.id)).toBeUndefined();
    expect(
      b.replica.entries().some((c) => c.documentId === "record/" + record.id),
    ).toBe(false);
    expect((await b.protocol.storage.status(item)).label).toBe("Remote only");
    await b.protocol.storage.setCopy(item, a.replica.identity.id, false);
    await b.synchronize();
    await a.synchronize();
    expect(a.records.get(record.id)).toBeDefined();
    await b.protocol.storage.setCopy(item, b.replica.identity.id, true);
    await b.synchronize();
    await a.synchronize();
    expect(b.records.get(record.id)?.data.value).toBe("No browser copy");
    expect(a.records.get(record.id)).toBeUndefined();
  });
  it("rejects delayed handoffs after an off/on/off decision while the other peer releases", async () => {
    const { a, b, item, record } = await pair();
    await a.protocol.storage.setCopy(item, a.replica.identity.id, false);
    await a.protocol.storage.reconcile(async (_, version) => {
      await b.protocol.storage.retain(item, version);
      await a.protocol.storage.setCopy(item, a.replica.identity.id, true);
      await b.protocol.storage.setCopy(item, b.replica.identity.id, false);
      await b.protocol.storage.reconcile(async (_, otherVersion) => {
        await a.protocol.storage.retain(item, otherVersion);
        return true;
      });
      expect(b.records.get(record.id)).toBeUndefined();
      await a.protocol.storage.setCopy(item, a.replica.identity.id, false);
      return true; // The original acknowledgement finally arrives.
    });
    expect(a.records.get(record.id)).toBeDefined();
  });
  it("uses compressed Automerge snapshots without losing conflicts or signed history", async () => {
    const { a, b, record } = await pair();
    await a.records.put(
      "variables",
      { ...record.data, value: "Laptop" },
      record.id,
    );
    await b.records.put(
      "variables",
      { ...record.data, value: "Server" },
      record.id,
    );
    await a.synchronize();
    const expected = canonical(a.records.get(record.id)),
      hashes = a.replica.hashes();
    const before = Object.values(
      a.replica.conflicts("record/" + record.id, "value", true),
    ).sort();
    expect(before).toEqual(["Laptop", "Server"]);
    a.replica.compact(1);
    expect(canonical(a.records.get(record.id))).toBe(expected);
    expect(a.replica.hashes()).toEqual(hashes);
    expect(
      Object.values(
        a.replica.conflicts("record/" + record.id, "value", true),
      ).sort(),
    ).toEqual(before);
  });
});
