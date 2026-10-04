import { it, expect } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ArchiveWorkspaceFiles,
  assertArchiveUnchanged,
  decodeWorkspaceArchive,
  encodeWorkspaceArchive,
} from "../packages/storage/workspace-archive";
import {
  WorkspaceStorage,
  WorkspaceRouter,
  parseWorkspaceManifest,
} from "../packages/storage/workspace";
import { openNodeWorkspaceArchive } from "../packages/platform-node/workspace-archive";
import { DeviceCore } from "../packages/core/device";
import { MemoryStorage, snapshotStorage } from "../packages/storage";
import {
  workspaceSnapshot,
  exportWorkspace,
  importWorkspace,
  openWorkspaceArchive,
} from "../packages/core/workspace-package";
import { canonical, utf8 } from "../packages/core/crypto";

it("commits shared edits and file versions directly to one portable file, preserving identity separation and history", async () => {
  const directory = await mkdtemp(join(tmpdir(), "taskasaur-live-file-")),
    filename = join(directory, "live.taskasaur");
  const local = new MemoryStorage(),
    router = new WorkspaceRouter(local);
  const owner = await DeviceCore.open(snapshotStorage(router), "Owner");
  const other = await DeviceCore.open(
    snapshotStorage(new MemoryStorage()),
    "Other",
  );
  try {
    const node = await owner.createWorkspace("Live file"),
      snapshot = await workspaceSnapshot(node);
    const files = await openNodeWorkspaceArchive(filename, true);
    const target = await WorkspaceStorage.create(
      files,
      snapshot.workspace,
      snapshot.entries,
    );
    await router.mount(target);
    const variable = await node.records.put("variables", {
      name: "Persisted",
      value_type: "text",
      value: "Immediately on disk",
    });
    const row = await node.records.put("files", {
      name: "live.txt",
      media_type: "text/plain",
      size: "10",
    });
    const version = await node.protocol.files.save(
      row.id,
      utf8.encode("live bytes"),
      "text/plain",
      null,
    );
    await owner.setPeers(node.replica.workspaceId, [
      "/dns4/example.test/tcp/443/wss",
    ]);
    await node.records.put("settings", {
      key: "local",
      scope: "device",
      value: "private",
    });
    const invitation = await owner.approve(
      node.replica.workspaceId,
      other.pairingRequest(),
    );
    const heads = node.replica.heads("record/" + variable.id);
    const bytes = new Uint8Array(await readFile(filename)); // No export or close needed to observe the durable bytes.
    const archive = await openWorkspaceArchive(bytes);
    expect(
      Object.keys(archive.manifest.entries).some((k) =>
        /device\/|\/local\//.test(k),
      ),
    ).toBe(false);
    await owner.close();
    const reopened = await WorkspaceStorage.open(
      await openNodeWorkspaceArchive(filename),
    );
    const restored = await importWorkspace(other, reopened, invitation);
    expect(restored.records.get(variable.id)?.data.value).toBe(
      "Immediately on disk",
    );
    expect(restored.replica.heads("record/" + variable.id)).toEqual(heads);
    expect(restored.link.peers).toContain("/dns4/example.test/tcp/443/wss");
    expect(
      new TextDecoder().decode(
        (await restored.protocol.files.read(version.id)).bytes,
      ),
    ).toBe("live bytes");
    expect(other.identity.id).not.toBe(owner.identity.id);
    await reopened.close();
    expect(await readdir(directory)).toEqual(["live.taskasaur"]);
  } finally {
    await owner.close();
    await other.close();
    await rm(directory, { recursive: true, force: true });
  }
});
it("leaves the last valid archive intact after a failed commit and permits a safe retry", async () => {
  let disk: Uint8Array | undefined,
    fail = false;
  const files = await ArchiveWorkspaceFiles.open(
    {
      read: async () => disk?.slice(),
      replace: async (next, expected) => {
        await assertArchiveUnchanged(disk, expected);
        if (fail) throw Error("Disk full");
        disk = next.slice();
      },
    },
    true,
  );
  const device = await DeviceCore.open(
    snapshotStorage(new MemoryStorage()),
    "Owner",
  );
  try {
    const node = await device.createWorkspace("Atomic"),
      snapshot = await workspaceSnapshot(node);
    const storage = await WorkspaceStorage.create(
      files,
      snapshot.workspace,
      snapshot.entries,
    );
    const before = disk!.slice(),
      revision = storage.manifest.revision;
    const key = `workspace/${node.replica.workspaceId}/blobs/${"a".repeat(64)}`;
    fail = true;
    await expect(storage.set(key, utf8.encode("new content"))).rejects.toThrow(
      "Disk full",
    );
    expect(disk).toEqual(before);
    expect(storage.manifest.revision).toBe(revision);
    expect(await storage.get(key)).toBeUndefined();
    fail = false;
    await storage.set(key, utf8.encode("new content"));
    expect(await (await openWorkspaceArchive(disk!)).get(key)).toEqual(
      utf8.encode("new content"),
    );
    const withBlob = await decodeWorkspaceArchive(disk!);
    await storage.delete(key);
    expect((await decodeWorkspaceArchive(disk!)).size).toBe(withBlob.size - 1);
    await storage.close();
  } finally {
    await device.close();
  }
});
it("opens old exports in place, refuses duplicate writers and never overwrites external changes or existing save targets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "taskasaur-file-lock-")),
    filename = join(directory, "existing.taskasaur");
  const device = await DeviceCore.open(
    snapshotStorage(new MemoryStorage()),
    "Owner",
  );
  try {
    const node = await device.createWorkspace("Existing export");
    const original = await exportWorkspace(node);
    await writeFile(filename, original);
    await expect(openNodeWorkspaceArchive(filename, true)).rejects.toThrow(
      "Choose a new file",
    );
    expect(new Uint8Array(await readFile(filename))).toEqual(original);
    const files = await openNodeWorkspaceArchive(filename),
      storage = await WorkspaceStorage.open(files);
    await expect(openNodeWorkspaceArchive(filename)).rejects.toThrow(
      "already open",
    );
    const values = await decodeWorkspaceArchive(original),
      manifest = parseWorkspaceManifest(values.get("workspace.json")!);
    manifest.revision++;
    manifest.workspace.peers = ["external"];
    values.set("workspace.json", utf8.encode(canonical(manifest)));
    const external = await encodeWorkspaceArchive(values);
    await writeFile(filename, external);
    await expect(
      storage.updateWorkspace({ ...node.link, peers: ["overwrite"] }),
    ).rejects.toThrow("changed outside");
    expect(new Uint8Array(await readFile(filename))).toEqual(external);
    await storage.close();
    const reopened = await WorkspaceStorage.open(
      await openNodeWorkspaceArchive(filename),
    );
    expect(reopened.manifest.workspace.peers).toEqual(["external"]);
    await reopened.close();
    expect(await readdir(directory)).toEqual(["existing.taskasaur"]);
  } finally {
    await device.close();
    await rm(directory, { recursive: true, force: true });
  }
});
