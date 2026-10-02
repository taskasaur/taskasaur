import "fake-indexeddb/auto";
import { it, expect } from "vitest";
import { LocalDatabase } from "../packages/data-dexie";
import { PluginRegistry } from "@taskasaur/platform/core/registry";
import { requiredCoreIds } from "@taskasaur/platform/core/catalog";
const user = crypto.randomUUID(),
  workspace = crypto.randomUUID();
const principal = {
  userId: user,
  workspaceId: workspace,
  pluginId: "tasks",
  permissions: ["tasks.read", "tasks.write"],
};
it("installs mandatory providers and keeps consumer use scoped", async () => {
  const db = new LocalDatabase(workspace, user, crypto.randomUUID());
  const registry = new PluginRegistry(db.pluginPersistence());
  await registry.initialize();
  expect(
    registry
      .list()
      .filter((p) => p.state.enabled)
      .map((p) => p.manifest.id),
  ).toEqual([...requiredCoreIds]);
  await expect(registry.disable("files")).rejects.toMatchObject({
    kind: "CORE_PLUGIN_REQUIRED",
  });
  await expect(registry.uninstall("credentials")).rejects.toMatchObject({
    kind: "CORE_PLUGIN_REQUIRED",
  });
  expect(() => db.scoped(principal, "tasks").collection("files")).toThrow();
  await expect(
    db.scoped(principal, "tasks").collection("tasks").put({ title: "Task" }),
  ).rejects.toMatchObject({ kind: "FEATURE_DISABLED" });
  await registry.install("tasks");
  await registry.enable("tasks");
  const record = await db
    .scoped(principal, "tasks", "local-only")
    .collection("tasks")
    .put({ title: "Offline" });
  expect(await db.outbox.count()).toBe(0);
  await registry.uninstall("tasks");
  expect(await db.records.get(record.id)).toBeDefined();
  expect(registry.enabled("files")).toBe(true);
  await db.delete();
});
it("atomically stores edits and outbox, preserves later edits after acknowledgement", async () => {
  const db = new LocalDatabase(workspace, user, crypto.randomUUID());
  const registry = new PluginRegistry(db.pluginPersistence());
  await registry.initialize();
  await registry.install("tasks");
  await registry.enable("tasks");
  const tasks = db.scoped(principal, "tasks", "synced").collection("tasks");
  const first = await tasks.put({ title: "First" });
  await tasks.put({ ...first.data, title: "Second" }, first.id);
  const pending = await db.outbox.orderBy("sequence").toArray();
  expect(pending).toHaveLength(2);
  await db.acknowledge(pending[0].id, { ...first, revision: 1 });
  expect((await tasks.get(first.id))?.data.title).toBe("Second");
  expect((await db.outbox.toArray())[0].baseRevision).toBe(1);
  await expect(tasks.put({ title: "Bad", undeclared: 1 })).rejects.toThrow();
  expect(await db.records.count()).toBe(1);
  await db.delete();
});
it("preserves unsynced file bytes and versions across metadata acknowledgement and server pulls", async () => {
  const db = new LocalDatabase(workspace, user, crypto.randomUUID()),
    registry = new PluginRegistry(db.pluginPersistence());
  await registry.initialize();
  const files = db
    .scoped({ ...principal, pluginId: "files" }, "files", "synced")
    .collection("files");
  const file = await files.put({
    name: "Report.odt",
    media_type: "application/vnd.oasis.opendocument.text",
  });
  const version = await db.saveFile(
    principal,
    file.id,
    new Blob(["original"]),
    null,
  );
  const pending = (await db.outbox.toArray())[0];
  await db.acknowledge(pending.id, { ...file, revision: 1 });
  expect((await files.get(file.id))?.data.version_id).toBe(version);
  const second = await db.saveFile(
    principal,
    file.id,
    new Blob(["newer"]),
    version,
  );
  await db.acknowledgeFile(version, {
    ...file,
    revision: 2,
    data: { ...file.data, version_id: version },
  });
  expect((await files.get(file.id))?.data.version_id).toBe(second);
  await db.ingest(
    [{ ...file, revision: 2, data: { ...file.data, version_id: version } }],
    "2",
  );
  expect((await files.get(file.id))?.data.version_id).toBe(second);
  expect(await (await db.fileVersions.get(second))?.blob.text()).toBe("newer");
  await db.delete();
});
it("retains shared ownership and removes cached content and pending edits on revocation", async () => {
  const db = new LocalDatabase(workspace, user, crypto.randomUUID()),
    registry = new PluginRegistry(db.pluginPersistence());
  await registry.initialize();
  await registry.install("tasks");
  await registry.enable("tasks");
  const tasks = db.scoped(principal, "tasks", "synced").collection("tasks"),
    own = await tasks.put({ title: "Shared" }),
    ownerId = crypto.randomUUID();
  await db.outbox.clear();
  const shared = { ...own, ownerId, revision: 1 };
  await db.ingest([shared], "1");
  await db.setMetadata("access.snapshot", {
    writableIds: [],
    workspaceWrite: true,
    checkedAt: Date.now(),
  });
  await expect(tasks.put({ title: "Denied" }, shared.id)).rejects.toMatchObject(
    { kind: "PERMISSION_DENIED" },
  );
  await db.setMetadata("access.snapshot", {
    writableIds: [shared.id],
    workspaceWrite: true,
    checkedAt: Date.now(),
  });
  expect((await tasks.put({ title: "Allowed" }, shared.id)).ownerId).toBe(
    ownerId,
  );
  await db.reconcileAccess([]);
  expect(await db.records.get(shared.id)).toBeUndefined();
  expect((await db.outbox.toArray())[0]).toMatchObject({
    state: "rejected",
    data: {},
  });
  await db.delete();
});
it("rebases an explicitly resolved conflict without replacing newer local values", async () => {
  const db = new LocalDatabase(workspace, user, crypto.randomUUID()),
    registry = new PluginRegistry(db.pluginPersistence());
  await registry.initialize();
  await registry.install("tasks");
  await registry.enable("tasks");
  const store = db.scoped(principal, "tasks", "synced").collection("tasks"),
    first = await store.put({ title: "Initial" });
  await db.acknowledge((await db.outbox.toArray())[0].id, {
    ...first,
    revision: 1,
  });
  await store.put({ title: "Local edit" }, first.id);
  const pending = (await db.outbox.toArray())[0];
  await db.outbox.update(pending.sequence!, { state: "conflict" });
  await db.ingest(
    [{ ...first, revision: 2, data: { ...first.data, title: "Server edit" } }],
    "2",
  );
  await store.put({ title: "Newer local edit" }, first.id);
  await db.resolveConflict(first.id, "local", 2);
  expect((await store.get(first.id))?.data.title).toBe("Newer local edit");
  expect(await db.outbox.count()).toBe(1);
  expect((await db.outbox.toArray())[0].baseRevision).toBe(2);
  await db.delete();
});
