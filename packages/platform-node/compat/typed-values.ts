import {
  pgTypes,
  sqlIdentifier,
  sqlType,
  type Field,
  type Value,
} from "@taskasaur/platform/field-types";
import { tableFields } from "@taskasaur/platform/core/dynamic-fields";
import type { Database } from "./database";
import { encodeSqlField, decodeSqlField } from "./field-codecs";
export const valueTable = (field: Pick<Field, "pgType" | "array">) =>
  "v_" + field.pgType.replaceAll(" ", "_") + (field.array ? "_array" : "");
export async function migrateTypedValues(db: Database) {
  for (const pgType of pgTypes)
    for (const array of [false, true]) {
      const descriptor = { pgType, array } as Field,
        name = valueTable(descriptor);
      await db.query(`CREATE TABLE IF NOT EXISTS taskasaur.${sqlIdentifier(name)}(row_id uuid NOT NULL REFERENCES taskasaur.resources(id),table_id uuid NOT NULL REFERENCES taskasaur.resources(id),field_id text NOT NULL,value ${sqlType(descriptor)} NOT NULL,PRIMARY KEY(row_id,field_id));
      CREATE INDEX IF NOT EXISTS ${sqlIdentifier(name + "_lookup")} ON taskasaur.${sqlIdentifier(name)}(table_id,field_id);`);
      if (!array && pgType !== "jsonb" && pgType !== "bytea")
        await db.query(
          `CREATE INDEX IF NOT EXISTS ${sqlIdentifier(name + "_value")} ON taskasaur.${sqlIdentifier(name)}(table_id,field_id,value)`,
        );
    }
}
export async function writeTypedValues(
  db: Database,
  rowId: string,
  tableId: string,
  columns: unknown,
  values: Record<string, Value>,
) {
  for (const pgType of pgTypes)
    for (const array of [false, true])
      await db.query(
        `DELETE FROM taskasaur.${sqlIdentifier(valueTable({ pgType, array }))} WHERE row_id=$1`,
        [rowId],
      );
  for (const field of tableFields(columns)) {
    const value = values[field.id];
    if (value == null) continue;
    const encoded = encodeSqlField(field, value);
    await db.query(
      `INSERT INTO taskasaur.${sqlIdentifier(valueTable(field))}(row_id,table_id,field_id,value) VALUES($1,$2,$3,$4)`,
      [rowId, tableId, field.id, encoded],
    );
  }
}
export async function readTypedValues(
  db: Database,
  rowId: string,
  columns: unknown,
) {
  const values: Record<string, Value> = {};
  for (const field of tableFields(columns)) {
    const result = await db.query<{ value: unknown }>(
      `SELECT value FROM taskasaur.${sqlIdentifier(valueTable(field))} WHERE row_id=$1 AND field_id=$2`,
      [rowId, field.id],
    );
    const value = result.rows[0]?.value;
    values[field.id] = decodeSqlField(field, value);
  }
  return values;
}
