import "fake-indexeddb/auto";
import Dexie from "dexie";
import { it, expect } from "vitest";
import { BrowserStorage } from "../packages/platform-browser/storage";
import { DeviceCore } from "../packages/core/device";
import { snapshotStorage } from "../packages/storage";
import { utf8 } from "../packages/core/crypto";

it("migrates only the opened workspace and keeps physical browser databases separate", async () => {
  const name = "isolation-" + crypto.randomUUID(),
    a = crypto.randomUUID(),
    b = crypto.randomUUID();
  const keyA = `workspace/${a}/blobs/a`,
    keyB = `workspace/${b}/blobs/b`;
  const legacy = new Dexie(name);
  legacy.version(1).stores({ values: "key" });
  await legacy.table("values").bulkPut([
    { key: keyA, bytes: utf8.encode("office A") },
    { key: keyB, bytes: utf8.encode("office B") },
  ]);
  const storage = new BrowserStorage(name);
  try {
    expect(await storage.get(keyA)).toEqual(utf8.encode("office A"));
    expect(await Dexie.getDatabaseNames()).not.toContain(
      `${name}.workspace.${b}`,
    );
    expect(await legacy.table("values").toArray()).toEqual([
      { key: keyB, bytes: utf8.encode("office B") },
    ]);
    storage.closeWorkspace(a);
    await storage.set(keyB, utf8.encode("new B"));
    expect(await storage.snapshot(`workspace/${b}/`)).toEqual({
      [keyB]: utf8.encode("new B"),
    });
    expect(await storage.snapshot(`workspace/${a}/`)).toEqual({
      [keyA]: utf8.encode("office A"),
    });
    const databaseA = new Dexie(`${name}.workspace.${a}`);
    await databaseA.open();
    expect(await databaseA.table("values").toArray()).toEqual([
      { key: keyA, bytes: utf8.encode("office A") },
    ]);
    databaseA.close();
  } finally {
    storage.close();
    legacy.close();
    await Promise.all(
      [name, `${name}.workspace.${a}`, `${name}.workspace.${b}`].map((name) =>
        Dexie.delete(name),
      ),
    );
  }
});

it("leaving a workspace disables stale records and sync handlers, while another workspace stays empty", async () => {
  const name = "lifecycle-" + crypto.randomUUID(),
    storage = new BrowserStorage(name);
  const device = await DeviceCore.open(snapshotStorage(storage), "Browser");
  const a = await device.createWorkspace("A");
  const row = await a.records.put("files", {
    name: "private.odt",
    media_type: "application/vnd.oasis.opendocument.text",
    size: "7",
  });
  const version = await a.protocol.files.save(
    row.id,
    utf8.encode("private"),
    "application/vnd.oasis.opendocument.text",
    null,
  );
  const packet = await a.protocol.pack({ kind: "capabilities" });
  const id = a.replica.workspaceId;
  await device.closeWorkspace(id);
  expect(device.protocols.has(id)).toBe(false);
  expect(() => a.records.get(row.id)).toThrow("closed");
  await expect(a.protocol.receive(packet)).rejects.toThrow("closed");
  await expect(
    a.records.put("variables", { name: "stale", value_type: "text" }),
  ).rejects.toThrow("closed");
  const b = await device.createWorkspace("B");
  expect(b.records.get(row.id)).toBeUndefined();
  await expect(b.protocol.files.read(version.id)).rejects.toThrow();
  const reopened = await device.workspace(id);
  expect(reopened.records.get(row.id)?.data.name).toBe("private.odt");
  expect((await reopened.protocol.files.read(version.id)).bytes).toEqual(
    utf8.encode("private"),
  );
  await device.close();
  await Promise.all(
    [
      name,
      `${name}.workspace.${id}`,
      `${name}.workspace.${b.replica.workspaceId}`,
    ].map((name) => Dexie.delete(name)),
  );
});
