import "fake-indexeddb/auto";
import Dexie from "dexie";
import { it, expect } from "vitest";
import { DeviceCore } from "../packages/core/device";
import { BrowserStorage } from "../packages/platform-browser/storage";
import { MemoryStorage, snapshotStorage } from "../packages/storage";
import {
  WorkspaceRouter,
  WorkspaceStorage,
} from "../packages/storage/workspace";
import {
  MemoryWorkspaceFiles,
  workspaceSnapshot,
} from "../packages/core/workspace-package";
import { utf8 } from "../packages/core/crypto";
import { mkdtemp, rm, writeFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FileStorage } from "../packages/platform-node/storage";
import { NativeServices } from "../packages/platform-node/services";

it("cleans desktop service projections, workflow state, and temporary replica files while keeping another workspace", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskasaur-delete-"));
  const storage = new FileStorage(path.join(directory, "replicas"));
  const core = await DeviceCore.open(
    snapshotStorage(new WorkspaceRouter(storage)),
    "Services",
  );
  const a = await core.createWorkspace("Delete"),
    b = await core.createWorkspace("Keep");
  await a.records.put("variables", {
    name: "Delete cached row",
    value_type: "text",
  });
  const keep = await b.records.put("variables", {
    name: "Keep cached row",
    value_type: "text",
  });
  const services = new NativeServices(core, {
    directory,
    terminal: false,
    automation: false,
    trustedCode: false,
    background: false,
    plugins: false,
  });
  try {
    await services.initialize();
    const id = a.replica.workspaceId;
    const key = `workspace/${id}/blobs/unfinished`;
    const temporary =
      Buffer.from(key).toString("base64url") +
      "." +
      crypto.randomUUID() +
      ".tmp";
    await writeFile(
      path.join(directory, "replicas", temporary),
      "unfinished data",
    );
    await writeFile(
      path.join(directory, `workflow-${id}.sqlite`),
      "execution state",
    );
    await services.deleteWorkspace(id);
    expect(core.profiles().map((p) => p.id)).toEqual([b.replica.workspaceId]);
    expect(await storage.keys(`workspace/${id}/`)).toEqual([]);
    expect(await readdir(path.join(directory, "replicas"))).not.toContain(
      temporary,
    );
    expect(await readdir(directory)).not.toContain(`workflow-${id}.sqlite`);
    expect(b.records.get(keep.id)?.data.name).toBe("Keep cached row");
    // The SQL delete succeeds with real foreign keys, including typed plugin tables.
    const { database } =
      await import("../packages/platform-node/compat/database");
    expect(
      (
        await database().query(
          "SELECT id FROM taskasaur.workspaces ORDER BY id",
        )
      ).rows,
    ).toEqual([{ id: b.replica.workspaceId }]);
    expect(
      (
        await database().query(
          "SELECT id FROM taskasaur.resources WHERE workspace_id=$1",
          [id],
        )
      ).rows,
    ).toEqual([]);
  } finally {
    await services.close();
    await core.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("deletes the physical workspace database and stale handlers without removing another workspace or the device identity", async () => {
  const name = "delete-" + crypto.randomUUID();
  const storage = new BrowserStorage(name),
    core = await DeviceCore.open(
      snapshotStorage(new WorkspaceRouter(storage)),
      "Browser",
    );
  const a = await core.createWorkspace("Delete"),
    b = await core.createWorkspace("Keep");
  const id = a.replica.workspaceId,
    keep = b.replica.workspaceId;
  const file = await a.records.put("files", {
    name: "private.txt",
    media_type: "text/plain",
    size: "7",
  });
  await a.protocol.files.save(
    file.id,
    utf8.encode("private"),
    "text/plain",
    null,
  );
  await core.storage.set(
    `workspace/${id}/local/connection-credential`,
    utf8.encode("private credential"),
  );
  const row = await b.records.put("variables", {
    name: "Keep me",
    value_type: "text",
  });
  const identity = core.identity.id,
    packet = await a.protocol.pack({ kind: "capabilities" });
  await core.deleteWorkspace(id);
  expect(await Dexie.getDatabaseNames()).not.toContain(
    `${name}.workspace.${id}`,
  );
  expect(core.profiles().map((p) => p.id)).toEqual([keep]);
  expect(core.protocols.has(id)).toBe(false);
  await expect(a.protocol.receive(packet)).rejects.toThrow("closed");
  await expect(core.workspace(id)).rejects.toThrow("not linked");
  expect(b.records.get(row.id)?.data.name).toBe("Keep me");
  await core.deleteWorkspace(id); // Safe retry after partial UI cleanup.
  await core.close();
  const reopened = await DeviceCore.open(
    snapshotStorage(new BrowserStorage(name)),
    "Browser",
  );
  expect(reopened.identity.id).toBe(identity);
  expect(reopened.profiles().map((p) => p.id)).toEqual([keep]);
  expect((await reopened.workspace(keep)).records.get(row.id)?.data.name).toBe(
    "Keep me",
  );
  await reopened.close();
  for (const database of [name, `${name}.workspace.${keep}`])
    await Dexie.delete(database);
});

it("removes local data and unmounts an external workspace without modifying the external file", async () => {
  const local = new MemoryStorage(),
    router = new WorkspaceRouter(local);
  const core = await DeviceCore.open(snapshotStorage(router), "Owner"),
    node = await core.createWorkspace("External");
  await node.records.put("variables", {
    name: "External data",
    value_type: "text",
  });
  const snapshot = await workspaceSnapshot(node, { includeCredentials: true });
  const files = new MemoryWorkspaceFiles();
  const source = await WorkspaceStorage.create(
    files,
    snapshot.workspace,
    snapshot.entries,
    snapshot.connectionCredential,
  );
  await router.mount(source, true, snapshot.excludedKeys);
  const before = await files.read("workspace.json");
  await core.deleteWorkspace(node.replica.workspaceId);
  expect(await local.keys(`workspace/${node.replica.workspaceId}/`)).toEqual(
    [],
  );
  expect(await files.read("workspace.json")).toEqual(before);
  expect(router.mounts.size).toBe(0);
  expect(router.blocked.size).toBe(0);
  expect(core.profiles()).toEqual([]);
  await core.close();
});
