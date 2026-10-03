import Dexie, { type Table } from 'dexie';
import type { DurableStorage } from '../storage';
export class BrowserStorage implements DurableStorage {
  private db: Dexie;
  private values: Table<{key:string; bytes:Uint8Array}, string>;
  constructor(name = 'taskasaur-peer-v1') {
    this.db = new Dexie(name);
    this.db.version(1).stores({ values:'key' });
    this.values = this.db.table('values');
  }
  async get(key: string) { return (await this.values.get(key))?.bytes; }
  async set(key: string, bytes: Uint8Array) { await this.values.put({key, bytes:bytes.slice()}); }
  async delete(key: string) { await this.values.delete(key); }
  async keys(prefix: string) { return this.values.where('key').startsWith(prefix).primaryKeys(); }
  close() { this.db.close(); }
}
