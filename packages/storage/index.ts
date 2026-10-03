/** Values must be committed durably and atomically before set() resolves. */
export interface DurableStorage {
  get(key: string): Promise<Uint8Array | undefined>;
  set(key: string, bytes: Uint8Array): Promise<void>;
  delete(key: string): Promise<void>;
  keys(prefix: string): Promise<string[]>;
  close?(): Promise<void> | void;
}
export class MemoryStorage implements DurableStorage {
  readonly data = new Map<string, Uint8Array>();
  async get(key: string) { return this.data.get(key)?.slice(); }
  async set(key: string, bytes: Uint8Array) { this.data.set(key, bytes.slice()); }
  async delete(key: string) { this.data.delete(key); }
  async keys(prefix: string) { return [...this.data.keys()].filter(k => k.startsWith(prefix)).sort(); }
}
