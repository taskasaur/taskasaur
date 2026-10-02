import assert from "node:assert/strict";
import { database, closeDatabase } from "../../server/database";
import { encodeSqlField, decodeSqlField } from "../../server/field-codecs";
import {
  field,
  pgTypes,
  sqlType,
  type Value,
} from "../../packages/field-types";
process.loadEnvFile(".env");
process.env.DATABASE_URL = `postgres://postgres:${encodeURIComponent(process.env.POSTGRES_PASSWORD!)}@127.0.0.1:58532/postgres`;
const fixtures: Record<string, Value> = {
  text: "a,b\n雪",
  "character varying": "Short",
  uuid: crypto.randomUUID(),
  boolean: true,
  smallint: 32767,
  integer: 2147483647,
  bigint: "9223372036854775807",
  numeric: "12345678901234567890123.000001",
  "double precision": 1.2345,
  date: "2024-02-29",
  "time without time zone": "12:34:56.123456",
  "timestamp without time zone": "2026-10-02T12:34:56.123456",
  "timestamp with time zone": "2026-10-02T12:34:56.123456+00:00",
  interval: "-PT5M",
  jsonb: { nested: [true, "x"] },
  bytea: "AAEC/w==",
};
try {
  for (const pgType of pgTypes)
    for (const array of [false, true]) {
      const descriptor = field("value", "Value", pgType, { array }),
        input = array ? [fixtures[pgType], fixtures[pgType]] : fixtures[pgType];
      const result = await database().query(
        "SELECT $1::" + sqlType(descriptor) + " AS value",
        [encodeSqlField(descriptor, input)],
      );
      assert.deepEqual(
        decodeSqlField(descriptor, result.rows[0].value),
        input,
        sqlType(descriptor),
      );
    }
  console.log(
    "All 16 PostgreSQL scalar and array types preserve precision, timestamps, intervals and bytes",
  );
} finally {
  await closeDatabase();
}
