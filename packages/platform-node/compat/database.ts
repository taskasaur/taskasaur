import { PGlite } from "@electric-sql/pglite";
import type { WorkspaceNode } from "../../core/device";
import type { DeviceCore } from "../../core/device";
export interface Database {
  core: DeviceCore;
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: T[]; rowCount?: number | null }>;
  transaction<T>(fn: (db: Database) => Promise<T>): Promise<T>;
}
let active: Database | undefined;
export async function openDatabase(directory: string, core: DeviceCore) {
  const db = new PGlite(directory);
  await db.waitReady;
  function wrap(
    client: Pick<PGlite, "query" | "exec">,
    inside = false,
  ): Database {
    return {
      core,
      async query<T extends Record<string, unknown>>(
        sql: string,
        values?: unknown[],
      ) {
        // Multi-statement migrations use exec; parameterized plugin statements use query.
        if (!values?.length && sql.includes(";")) {
          const results = await client.exec(sql);
          const result = results.at(-1);
          return {
            rows: (result?.rows ?? []) as T[],
            rowCount: result?.affectedRows,
          };
        }
        const result = await client.query<T>(sql, values);
        return { rows: result.rows, rowCount: result.affectedRows };
      },
      transaction: (fn) =>
        inside
          ? fn(wrap(client, true))
          : db.transaction((tx) => fn(wrap(tx, true))),
    };
  }
  active = wrap(db);
  return { database: active, close: () => db.close() };
}
export function database() {
  if (!active) throw Error("Initialize the embedded device database first");
  return active;
}
export function nodeFor(db: Database, workspaceId: string): WorkspaceNode {
  const node = db.core.workspaces.get(workspaceId);
  if (!node) throw Error("Workspace is not linked to this device");
  return node;
}
