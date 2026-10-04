import { it, expect } from "vitest";
import { DeviceCore } from "../packages/core/device";
import { MemoryStorage, snapshotStorage } from "../packages/storage";
import {
  WorkspaceRouter,
  WorkspaceStorage,
} from "../packages/storage/workspace";
import {
  MemoryWorkspaceFiles,
  exportWorkspace,
  openWorkspaceArchive,
  importWorkspace,
  workspaceSnapshot,
} from "../packages/core/workspace-package";
import { utf8 } from "../packages/core/crypto";
import { LocalState } from "../packages/core/local-state";

it("restores a whole workspace only after approval, with a fresh identity and mergeable history", async () => {
  const owner = await DeviceCore.open(
      snapshotStorage(new MemoryStorage()),
      "Owner",
    ),
    a = await owner.createWorkspace("Portable");
  const record = await a.records.put("variables", {
    name: "Versioned",
    value_type: "text",
    value: "old",
  });
  const file = await a.records.put("files", {
    name: "test.txt",
    media_type: "text/plain",
    size: "5",
  });
  const version = await a.protocol.files.save(
    file.id,
    utf8.encode("hello"),
    "text/plain",
    null,
  );
  await owner.setPeers(a.replica.workspaceId, [
    "/dns4/peer.example/tcp/443/wss/p2p/known-peer",
  ]);
  await new LocalState(a.replica, "execution").set("private", {
    run: "do not restore",
  });
  const archive = await openWorkspaceArchive(await exportWorkspace(a));
  expect(
    (await archive.keys("")).some(
      (k) =>
        k.includes("identity") ||
        k.includes("/local/") ||
        k.startsWith("network/"),
    ),
  ).toBe(false);
  const fresh = await DeviceCore.open(
    snapshotStorage(new MemoryStorage()),
    "New computer",
  );
  await expect(importWorkspace(fresh, archive)).rejects.toThrow(
    "Approve this device",
  );
  expect(fresh.profiles()).toHaveLength(0);
  await a.records.put("variables", { ...record.data, value: "new" }, record.id);
  const invitation = await owner.approve(
    a.replica.workspaceId,
    fresh.pairingRequest(),
  );
  const restored = await importWorkspace(fresh, archive, invitation);
  expect(fresh.identity.id).not.toBe(owner.identity.id);
  expect(restored.records.get(record.id)?.data.value).toBe("old");
  expect(
    new TextDecoder().decode(
      (await restored.protocol.files.read(version.id)).bytes,
    ),
  ).toBe("hello");
  expect(restored.link.peers).toContain(
    "/dns4/peer.example/tcp/443/wss/p2p/known-peer",
  );
  for (const entry of a.replica.entries()) await restored.replica.accept(entry);
  expect(restored.records.get(record.id)?.data.value).toBe("new");
  expect(restored.replica.heads("record/" + record.id)).toEqual(
    a.replica.heads("record/" + record.id),
  );
});
it("writes directly into a mounted package and reopens it without cloning private device state", async () => {
  const local = new MemoryStorage(),
    router = new WorkspaceRouter(local),
    device = await DeviceCore.open(snapshotStorage(router), "Writer"),
    node = await device.createWorkspace("Folder");
  const initial = await workspaceSnapshot(node),
    files = new MemoryWorkspaceFiles();
  const folder = await WorkspaceStorage.create(
    files,
    initial.workspace,
    initial.entries,
  );
  await router.mount(folder);
  const row = await node.records.put("variables", {
    name: "Live",
    value_type: "text",
    value: "on disk",
  });
  const reopened = await WorkspaceStorage.open(files);
  expect((await reopened.keys("")).some((k) => k.startsWith("device/"))).toBe(
    false,
  );
  const second = await DeviceCore.open(
    snapshotStorage(new MemoryStorage()),
    "Other device",
  );
  const restored = await importWorkspace(
    second,
    reopened,
    await device.approve(node.replica.workspaceId, second.pairingRequest()),
  );
  expect(restored.records.get(row.id)?.data.value).toBe("on disk");
  expect(await local.get("device/identity")).toBeDefined();
});
it("refuses incomplete exports and corrupt packages", async () => {
  const storage = snapshotStorage(new MemoryStorage()),
    device = await DeviceCore.open(storage, "Owner"),
    node = await device.createWorkspace("Files");
  const file = await node.records.put("files", {
    name: "test.txt",
    media_type: "text/plain",
    size: "5",
  });
  const version = await node.protocol.files.save(
    file.id,
    utf8.encode("hello"),
    "text/plain",
    null,
  );
  await storage.delete(
    `workspace/${node.replica.workspaceId}/blobs/${version.chunks[0]}`,
  );
  await expect(exportWorkspace(node)).rejects.toThrow(
    "Download all workspace copies",
  );
});
it("detects external folder edits before replacing its manifest", async () => {
  const device = await DeviceCore.open(
      snapshotStorage(new MemoryStorage()),
      "Owner",
    ),
    node = await device.createWorkspace("Folder"),
    snapshot = await workspaceSnapshot(node),
    files = new MemoryWorkspaceFiles();
  const first = await WorkspaceStorage.create(
      files,
      snapshot.workspace,
      snapshot.entries,
    ),
    second = await WorkspaceStorage.open(files);
  await first.updateWorkspace({ ...node.link, peers: ["new-address"] });
  await expect(
    second.updateWorkspace({ ...node.link, peers: ["other-address"] }),
  ).rejects.toThrow("changed outside");
});
it("exports an available workspace while another folder is disconnected and rejects unfinished uploads", async () => {
  const router = new WorkspaceRouter(new MemoryStorage()),
    device = await DeviceCore.open(snapshotStorage(router), "Owner");
  const available = await device.createWorkspace("Available"),
    unavailable = await device.createWorkspace("Unavailable");
  router.blocked.add(unavailable.replica.workspaceId);
  const snapshot = await workspaceSnapshot(available);
  expect(snapshot.workspace.id).toBe(available.replica.workspaceId);
  await available.records.put("files", {
    name: "pending.txt",
    media_type: "text/plain",
    size: "5",
  });
  await expect(exportWorkspace(available)).rejects.toThrow(
    "Finish saving all files",
  );
  router.blocked.clear();
  await device.close();
});
it("rejects archive corruption before linking a new device", async () => {
  const { default: JSZip } = await import("jszip");
  const owner = await DeviceCore.open(
      snapshotStorage(new MemoryStorage()),
      "Owner",
    ),
    node = await owner.createWorkspace("Verified");
  await node.records.put("variables", {
    name: "Keep",
    value_type: "text",
    value: "original",
  });
  const exported = await exportWorkspace(node),
    zip = await JSZip.loadAsync(exported);
  const manifest = JSON.parse(
    await zip.file("workspace.json")!.async("string"),
  );
  const entry = Object.values(manifest.entries)[0] as {
    hash: string;
    size: number;
  };
  zip.file(`data/${entry.hash}.bin`, new Uint8Array(entry.size));
  await expect(
    openWorkspaceArchive(await zip.generateAsync({ type: "uint8array" })),
  ).rejects.toThrow("missing or corrupt");
  const fresh = await DeviceCore.open(
    snapshotStorage(new MemoryStorage()),
    "Fresh",
  );
  const source = await openWorkspaceArchive(exported);
  const other = await owner.createWorkspace("Other");
  const wrong = await owner.approve(
    other.replica.workspaceId,
    fresh.pairingRequest(),
  );
  await expect(importWorkspace(fresh, source, wrong)).rejects.toThrow(
    "Approval must be for this workspace",
  );
  expect(fresh.profiles()).toHaveLength(0);
});
it("persists native folder writes, releases removed bytes, and locks out a second writer", async () => {
  const { mkdtemp, rm, readdir } = await import("node:fs/promises"),
    { tmpdir } = await import("node:os"),
    { join } = await import("node:path");
  const { NodeWorkspaceFiles } =
    await import("../packages/platform-node/workspace-files");
  const directory = await mkdtemp(join(tmpdir(), "taskasaur-workspace-test-"));
  const files = await NodeWorkspaceFiles.open(directory);
  try {
    await expect(NodeWorkspaceFiles.open(directory)).rejects.toThrow();
    await expect(
      files.write("../escape", utf8.encode("invalid")),
    ).rejects.toThrow("Invalid workspace path");
    const device = await DeviceCore.open(
        snapshotStorage(new MemoryStorage()),
        "Native",
      ),
      node = await device.createWorkspace("Disk"),
      snapshot = await workspaceSnapshot(node);
    const storage = await WorkspaceStorage.create(
      files,
      snapshot.workspace,
      snapshot.entries,
    );
    const key = `workspace/${node.replica.workspaceId}/blobs/${"a".repeat(64)}`;
    await storage.set(key, utf8.encode("durable"));
    const before = await readdir(join(directory, "data"));
    expect(
      new TextDecoder().decode(
        await (await WorkspaceStorage.open(files)).get(key),
      ),
    ).toBe("durable");
    await storage.delete(key);
    expect((await readdir(join(directory, "data"))).length).toBe(
      before.length - 1,
    );
    await device.close();
  } finally {
    await files.close();
    await rm(directory, { recursive: true, force: true });
  }
});
it("keeps device settings local across restart and omits legacy device-scoped journals", async () => {
  const storage = snapshotStorage(new MemoryStorage()),
    owner = await DeviceCore.open(storage, "Settings"),
    node = await owner.createWorkspace("Local settings");
  const local = await node.records.put("settings", {
    key: "local.preference",
    value: { theme: "dark" },
    scope: "device",
  });
  expect(node.replica.read("record/" + local.id)).toBeUndefined();
  const legacy = { ...local, id: crypto.randomUUID() };
  await node.replica.update(
    "record/" + legacy.id,
    legacy as unknown as Record<string, unknown>,
  );
  const shared = await node.records.put("settings", {
    key: "shared.preference",
    value: "shared",
    scope: "workspace",
  });
  const source = await openWorkspaceArchive(await exportWorkspace(node));
  const second = await DeviceCore.open(
    snapshotStorage(new MemoryStorage()),
    "Second",
  );
  const restored = await importWorkspace(
    second,
    source,
    await owner.approve(node.replica.workspaceId, second.pairingRequest()),
  );
  expect(restored.records.get(local.id)).toBeUndefined();
  expect(restored.replica.read("record/" + legacy.id)).toBeUndefined();
  expect(restored.records.get(shared.id)?.data.value).toBe("shared");
  await owner.close();
  const reopened = await DeviceCore.open(storage, "Settings");
  expect(
    (await reopened.workspace(node.replica.workspaceId)).records.get(local.id)
      ?.data.value,
  ).toEqual({ theme: "dark" });
});
