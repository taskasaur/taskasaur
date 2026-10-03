import { it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FileStorage } from "../packages/platform-node/storage";
import { snapshotStorage } from "../packages/storage";
it("persists long operation keys and takes a consistent snapshot", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskasaur-storage-")),
    storage = snapshotStorage(new FileStorage(directory)),
    key =
      "workspace/" +
      crypto.randomUUID() +
      "/operations/" +
      "a".repeat(64) +
      "/" +
      "step".repeat(64);
  try {
    await storage.set(key, new Uint8Array([1, 2]));
    await storage.set(key, new Uint8Array([3]));
    expect(await storage.keys("workspace/")).toEqual([key]);
    expect(await storage.get(key)).toEqual(new Uint8Array([3]));
    expect((await storage.snapshot!())[key]).toEqual(new Uint8Array([3]));
    await storage.delete(key);
    expect(await storage.keys("workspace/")).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
