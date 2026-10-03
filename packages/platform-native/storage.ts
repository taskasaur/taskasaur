import { Filesystem, Directory } from '@capacitor/filesystem';
import type { DurableStorage } from '../storage';
import { base64, unbase64 } from '../core/crypto';
/** Native app-private files are independent of WebView cache eviction. */
export class NativeStorage implements DurableStorage {
  constructor(private namespace = 'replica') {}
  private path(key: string) { return `${this.namespace}/${encodeURIComponent(key)}`; }
  async get(key: string) {
    try {
      const result = await Filesystem.readFile({directory:Directory.Data, path:this.path(key)});
      return typeof result.data === 'string' ? unbase64(result.data) : new Uint8Array(await result.data.arrayBuffer());
    } catch (error) {
      const message = String((error as Error).message);
      if (/not exist|not found|ENOENT/i.test(message)) return undefined;
      throw error;
    }
  }
  async set(key: string, bytes: Uint8Array) {
    const temporary = this.path(key) + '.' + crypto.randomUUID() + '.tmp';
    await Filesystem.writeFile({directory:Directory.Data, path:temporary, data:base64(bytes), recursive:true});
    await Filesystem.rename({directory:Directory.Data, from:temporary, to:this.path(key)});
  }
  async delete(key: string) {
    if (await this.get(key)) await Filesystem.deleteFile({directory:Directory.Data, path:this.path(key)});
  }
  async keys(prefix: string) {
    await Filesystem.mkdir({directory:Directory.Data, path:this.namespace, recursive:true}).catch(async error => {
      await Filesystem.stat({directory:Directory.Data, path:this.namespace}).catch(() => {throw error;});
    });
    const {files} = await Filesystem.readdir({directory:Directory.Data, path:this.namespace});
    return files.filter(f => !f.name.endsWith('.tmp')).map(f => decodeURIComponent(f.name)).filter(k => k.startsWith(prefix)).sort();
  }
}
