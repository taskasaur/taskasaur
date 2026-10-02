import pg from "pg";
import { invariant } from "../packages/core/errors";
export interface Database {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: T[]; rowCount?: number | null }>;
  transaction<T>(fn: (db: Database) => Promise<T>): Promise<T>;
}
let pool: pg.Pool | undefined;
function wrap(
  client: pg.Pool | pg.PoolClient,
  inTransaction = false,
): Database {
  return {
    query: async (sql, values) => client.query(sql, values),
    transaction: async (fn) => {
      if (inTransaction) {
        const savepoint = `s_${crypto.randomUUID().replaceAll("-", "")}`;
        await client.query(`SAVEPOINT ${savepoint}`);
        try {
          const value = await fn(wrap(client, true));
          await client.query(`RELEASE SAVEPOINT ${savepoint}`);
          return value;
        } catch (error) {
          await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
          throw error;
        }
      }
      const connection =
        "connect" in client
          ? await (client as pg.Pool).connect()
          : (client as pg.PoolClient);
      try {
        await connection.query("BEGIN");
        const result = await fn(wrap(connection, true));
        await connection.query("COMMIT");
        return result;
      } catch (error) {
        await connection.query("ROLLBACK");
        throw error;
      } finally {
        if (connection !== client) connection.release();
      }
    },
  };
}
export function database(): Database {
  invariant(
    process.env.DATABASE_URL,
    "CONFIGURATION_REQUIRED",
    "DATABASE_URL is required",
  );
  if (!pool) {
    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      max: 10,
      connectionTimeoutMillis: 5000,
    });
    // Idle sockets can close during a database restart. Do not emit pg client
    // objects (which contain connection configuration) or crash the worker.
    pool.on("error", () =>
      console.error(
        "Database connection interrupted; the pool will reconnect.",
      ),
    );
  }
  // Keep exact numeric and timestamp wire values out of lossy JavaScript conversions.
  pg.types.setTypeParser(20, (v) => v);
  pg.types.setTypeParser(1700, (v) => v);
  const textArray = pg.types.getTypeParser(1009 as never);
  for (const oid of [1016, 1231, 1182, 1115, 1185])
    pg.types.setTypeParser(oid, textArray);
  pg.types.setTypeParser(1082, (v) => v);
  pg.types.setTypeParser(1114, (v) => v.replace(" ", "T"));
  pg.types.setTypeParser(1184, (v) =>
    v.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00"),
  );
  return wrap(pool);
}
export async function closeDatabase() {
  await pool?.end();
  pool = undefined;
}
