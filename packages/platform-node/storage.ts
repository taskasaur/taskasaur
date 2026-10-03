import { mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import type { DurableStorage } from '../storage';
export class FileStorage implements DurableStorage {
  constructor(readonly directory: string) {}
  private file(key: string) { return path.join(this.directory, Buffer.from(key).toString('base64url')); }
  async get(key: string) {
    try { return new Uint8Array(await readFile(this.file(key))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  }
  async set(key: string, bytes: Uint8Array) {
    await mkdir(this.directory, {recursive:true, mode:0o700});
    const destination = this.file(key), temporary = destination + '.' + crypto.randomUUID() + '.tmp';
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); }
    finally { await handle.close(); }
    try { await rename(temporary, destination); }
    catch (error) { await rm(temporary, {force:true}); throw error; }
    // fsync the directory where supported so the rename survives power loss.
    if (process.platform !== 'win32') {
      const directory = await open(this.directory, 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    }
  }
  async delete(key: string) { await rm(this.file(key), {force:true}); }
  async keys(prefix: string) {
    await mkdir(this.directory, {recursive:true, mode:0o700});
    return (await readdir(this.directory)).filter(f => !f.endsWith('.tmp')).map(f => Buffer.from(f, 'base64url').toString()).filter(k => k.startsWith(prefix)).sort();
  }
}
