import { mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { DurableStorage } from "../storage";
export class FileStorage implements DurableStorage {
  constructor(readonly directory: string) {}
  private file(key: string) {
    const encoded = Buffer.from(key).toString("base64url");
    return path.join(
      this.directory,
      ...(encoded.length > 180
        ? ["long", ...encoded.match(/.{1,120}/g)!]
        : [encoded]),
    );
  }
  async get(key: string) {
    try {
      return new Uint8Array(await readFile(this.file(key)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        const encoded = Buffer.from(key).toString("base64url");
        if (encoded.length > 180 && encoded.length <= 255)
          try {
            return new Uint8Array(
              await readFile(path.join(this.directory, encoded)),
            );
          } catch (legacy) {
            if ((legacy as NodeJS.ErrnoException).code !== "ENOENT")
              throw legacy;
          }
        return undefined;
      }
      throw error;
    }
  }
  async set(key: string, bytes: Uint8Array) {
    await mkdir(path.dirname(this.file(key)), { recursive: true, mode: 0o700 });
    const destination = this.file(key),
      temporary = destination + "." + crypto.randomUUID() + ".tmp";
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporary, destination);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
    // fsync the directory where supported so the rename survives power loss.
    if (process.platform !== "win32") {
      const directory = await open(path.dirname(destination), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
  }
  async delete(key: string) {
    await rm(this.file(key), { force: true });
    const encoded = Buffer.from(key).toString("base64url");
    if (encoded.length > 180 && encoded.length <= 255)
      await rm(path.join(this.directory, encoded), { force: true });
  }
  async deleteWorkspace(id: string) {
    const changed = new Set<string>();
    const walk = async (folder: string, encoded = "") => {
      let entries;
      try {
        entries = await readdir(folder, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      for (const entry of entries) {
        const file = path.join(folder, entry.name);
        const name =
          encoded +
          (folder === this.directory && entry.name === "long"
            ? ""
            : entry.name);
        if (entry.isDirectory()) await walk(file, name);
        else if (entry.isFile()) {
          const key = Buffer.from(
            name.replace(/\.[0-9a-f-]{36}\.tmp$/, ""),
            "base64url",
          ).toString();
          if (key.startsWith(`workspace/${id}/`)) {
            await rm(file);
            changed.add(folder);
          }
        }
      }
    };
    await walk(this.directory);
    if (process.platform !== "win32")
      for (const folder of changed) {
        const directory = await open(folder, "r");
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      }
  }
  async keys(prefix: string) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const flat = (await readdir(this.directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
    const long: string[] = [];
    const walk = async (folder: string, encoded = "") => {
      for (const entry of await readdir(folder, { withFileTypes: true })) {
        if (entry.isDirectory())
          await walk(path.join(folder, entry.name), encoded + entry.name);
        else long.push(encoded + entry.name);
      }
    };
    try {
      await walk(path.join(this.directory, "long"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return [...new Set([...flat, ...long])]
      .filter((f) => !f.endsWith(".tmp"))
      .map((f) => Buffer.from(f, "base64url").toString())
      .filter((k) => k.startsWith(prefix))
      .sort();
  }
}
