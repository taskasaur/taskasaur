import Dexie, { type Table } from "dexie";
import type { DurableStorage } from "../storage";
/** Device metadata and each workspace have separate top-level IndexedDB databases. */
export class BrowserStorage implements DurableStorage {
  private db: Dexie;
  private values: Table<{ key: string; bytes: Uint8Array }, string>;
  private workspaces = new Map<
    string,
    { db: Dexie; values: Table<{ key: string; bytes: Uint8Array }, string> }
  >();
  private migrations = new Map<string, Promise<void>>();
  private closed = false;
  constructor(private name = "taskasaur-peer-v1") {
    this.db = this.database(name);
    this.values = this.db.table("values");
  }
  private database(name: string) {
    const db = new Dexie(name);
    db.version(1).stores({ values: "key" });
    return db;
  }
  private async table(key: string) {
    if (this.closed) throw Error("Device storage is closed");
    const id = /^workspace\/([0-9a-f-]{36})\//.exec(key)?.[1];
    if (!id) return this.values;
    let scope = this.workspaces.get(id);
    if (!scope) {
      const db = this.database(`${this.name}.workspace.${id}`);
      scope = { db, values: db.table("values") };
      this.workspaces.set(id, scope);
    }
    if (!this.migrations.has(id)) {
      const target = scope.values;
      const migration = (async () => {
        const rows = await this.values
          .where("key")
          .startsWith(`workspace/${id}/`)
          .toArray();
        // Migrate only the workspace being opened, preserving existing new-store writes.
        await scope!.db.transaction("rw", target, async () => {
          for (const row of rows)
            if (!(await target.get(row.key))) await target.put(row);
        });
        if (rows.length)
          await this.values.bulkDelete(rows.map((row) => row.key));
      })();
      this.migrations.set(id, migration);
      void migration.catch(() => this.migrations.delete(id));
    }
    await this.migrations.get(id);
    return scope.values;
  }
  async get(key: string) {
    return (await (await this.table(key)).get(key))?.bytes;
  }
  async set(key: string, bytes: Uint8Array) {
    await (await this.table(key)).put({ key, bytes: bytes.slice() });
  }
  async delete(key: string) {
    await (await this.table(key)).delete(key);
  }
  async keys(prefix: string) {
    if (/^workspace\/[0-9a-f-]{36}\//.test(prefix))
      return (await this.table(prefix))
        .where("key")
        .startsWith(prefix)
        .primaryKeys();
    const keys = await this.values
      .where("key")
      .startsWith(prefix)
      .primaryKeys();
    const names = await Dexie.getDatabaseNames();
    for (const name of names) {
      if (!name.startsWith(this.name + ".workspace.")) continue;
      const id = name.slice((this.name + ".workspace.").length);
      keys.push(
        ...(await (
          await this.table(`workspace/${id}/`)
        )
          .where("key")
          .startsWith(prefix)
          .primaryKeys()),
      );
    }
    return [...new Set(keys)].sort();
  }
  async snapshot(prefix = "") {
    const entries: Record<string, Uint8Array> = {};
    for (const key of await this.keys(prefix)) {
      const bytes = await this.get(key);
      if (bytes) entries[key] = bytes;
    }
    return entries;
  }
  closeWorkspace(id: string) {
    this.workspaces.get(id)?.db.close();
    this.workspaces.delete(id);
    this.migrations.delete(id);
  }
  close() {
    this.closed = true;
    for (const scope of this.workspaces.values()) scope.db.close();
    this.workspaces.clear();
    this.db.close();
  }
}
