/** Values must be committed durably and atomically before set() resolves. */
export interface DurableStorage {
  get(key: string): Promise<Uint8Array | undefined>;
  set(key: string, bytes: Uint8Array): Promise<void>;
  delete(key: string): Promise<void>;
  keys(prefix: string): Promise<string[]>;
  snapshot?(prefix?: string): Promise<Record<string, Uint8Array>>;
  close?(): Promise<void> | void;
  closeWorkspace?(id: string): Promise<void> | void;
  deleteWorkspace?(id: string): Promise<void>;
}
/** Remove only app-owned data; file adapters override this to preserve external files. */
export async function deleteWorkspaceData(storage: DurableStorage, id: string) {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
  )
    throw Error("Invalid workspace ID");
  if (storage.deleteWorkspace) return storage.deleteWorkspace(id);
  for (const key of await storage.keys(`workspace/${id}/`))
    await storage.delete(key);
}
export class MemoryStorage implements DurableStorage {
  readonly data = new Map<string, Uint8Array>();
  async get(key: string) {
    return this.data.get(key)?.slice();
  }
  async set(key: string, bytes: Uint8Array) {
    this.data.set(key, bytes.slice());
  }
  async delete(key: string) {
    this.data.delete(key);
  }
  async keys(prefix: string) {
    return [...this.data.keys()].filter((k) => k.startsWith(prefix)).sort();
  }
  async snapshot(prefix = "") {
    return Object.fromEntries(
      [...this.data]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, bytes]) => [key, bytes.slice()]),
    );
  }
}
/** Serializes writes and snapshots without changing each adapter's durability contract. */
export function snapshotStorage(source: DurableStorage): DurableStorage {
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>) => {
    const next = queue.then(work);
    queue = next.catch(() => {});
    return next;
  };
  return {
    get: (key) => source.get(key),
    keys: (prefix) => source.keys(prefix),
    set: (key, bytes) => serial(() => source.set(key, bytes)),
    delete: (key) => serial(() => source.delete(key)),
    deleteWorkspace: (id) => serial(() => deleteWorkspaceData(source, id)),
    close: async () => {
      await queue;
      await source.close?.();
    },
    closeWorkspace: (id) =>
      serial(async () => {
        await source.closeWorkspace?.(id);
      }),
    snapshot: (prefix = "") =>
      serial(async () => {
        if (source.snapshot)
          return Object.fromEntries(
            Object.entries(await source.snapshot(prefix)).filter(([key]) =>
              key.startsWith(prefix),
            ),
          );
        const entries: Record<string, Uint8Array> = {};
        for (const key of await source.keys(prefix)) {
          const value = await source.get(key);
          if (value) entries[key] = value;
        }
        return entries;
      }),
  };
}
