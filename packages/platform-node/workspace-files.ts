import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { WorkspaceFiles } from "../storage/workspace";
import { lockDirectory } from "./lock";
export async function atomicWorkspaceWrite(target: string, bytes: Uint8Array) {
  const temp = target + "." + crypto.randomUUID() + ".tmp";
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  try {
    const fd = await open(temp, "wx", 0o600);
    try {
      await fd.writeFile(bytes);
      await fd.sync();
    } finally {
      await fd.close();
    }
    await rename(temp, target);
    if (process.platform !== "win32") {
      const dir = await open(path.dirname(target), "r");
      try {
        await dir.sync();
      } finally {
        await dir.close();
      }
    }
  } finally {
    await rm(temp, { force: true });
  }
}
/** The same package layout as the browser's selected directory adapter. */
export class NodeWorkspaceFiles implements WorkspaceFiles {
  private constructor(
    readonly directory: string,
    private release: () => Promise<void>,
  ) {}
  static async open(directory: string) {
    const root = path.resolve(directory);
    return new NodeWorkspaceFiles(root, await lockDirectory(root));
  }
  private file(name: string) {
    if (name !== "workspace.json" && !/^data\/[a-f0-9]{64}\.bin$/.test(name))
      throw Error("Invalid workspace path");
    return path.join(this.directory, name);
  }
  async read(name: string) {
    try {
      return new Uint8Array(await readFile(this.file(name)));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
      throw e;
    }
  }
  async write(name: string, bytes: Uint8Array) {
    await atomicWorkspaceWrite(this.file(name), bytes);
  }
  async remove(name: string) {
    const target = this.file(name);
    await rm(target, { force: true });
    if (process.platform !== "win32") {
      const dir = await open(path.dirname(target), "r");
      try {
        await dir.sync();
      } finally {
        await dir.close();
      }
    }
  }
  close() {
    return this.release();
  }
}
