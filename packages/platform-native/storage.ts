import { Filesystem, Directory } from "@capacitor/filesystem";
import { registerPlugin } from "@capacitor/core";
import type { DurableStorage } from "../storage";
import { base64, unbase64 } from "../core/crypto";
const atomic = registerPlugin<{
  write(options: { path: string; data: string }): Promise<void>;
  read(options: { path: string }): Promise<{ data: string | null }>;
}>("ReplicaStorage");
/** Native app-private files are independent of WebView cache eviction. */
export class NativeStorage implements DurableStorage {
  constructor(private namespace = "replica") {}
  private path(key: string) {
    const encoded = encodeURIComponent(key);
    return `${this.namespace}/${encoded.length > 180 ? "long/" + encoded.match(/.{1,120}/g)!.join("/") : encoded}`;
  }
  async get(key: string) {
    try {
      const result = await atomic.read({ path: this.path(key) });
      return result.data === null ? undefined : unbase64(result.data);
    } catch (error) {
      const message = String((error as Error).message);
      if (/not exist|not found|ENOENT/i.test(message)) return undefined;
      throw error;
    }
  }
  async set(key: string, bytes: Uint8Array) {
    await atomic.write({ path: this.path(key), data: base64(bytes) });
  }
  async delete(key: string) {
    if (await this.get(key))
      await Filesystem.deleteFile({
        directory: Directory.Data,
        path: this.path(key),
      });
  }
  async keys(prefix: string) {
    await Filesystem.mkdir({
      directory: Directory.Data,
      path: this.namespace,
      recursive: true,
    }).catch(async (error) => {
      await Filesystem.stat({
        directory: Directory.Data,
        path: this.namespace,
      }).catch(() => {
        throw error;
      });
    });
    const names: string[] = [];
    const walk = async (path: string, encoded = "") => {
      const { files } = await Filesystem.readdir({
        directory: Directory.Data,
        path,
      });
      for (const file of files) {
        if (file.type === "directory")
          await walk(
            path + "/" + file.name,
            encoded + (file.name === "long" && !encoded ? "" : file.name),
          );
        else if (!/\.(tmp|new)$/.test(file.name))
          names.push(encoded + file.name.replace(/\.bak$/, ""));
      }
    };
    await walk(this.namespace);
    return [
      ...new Set(
        names
          .map((name) => decodeURIComponent(name))
          .filter((k) => k.startsWith(prefix)),
      ),
    ].sort();
  }
}
