import type { AppRuntime } from "./runtime";
import type { ResourceRecord } from "@taskasaur/platform/plugin-sdk";
import type { Value } from "@taskasaur/platform/field-types";
import { getSchema, schemaById } from "@taskasaur/platform/core/catalog";
import { collectionColumns } from "@taskasaur/platform/core/collection-tables";
import { digest, utf8 } from "../core/crypto";
import { deviceRecordId } from "../core/records";
import { invariant } from "@taskasaur/platform/core/errors";

export const tableSelectionKey = (collection: string) =>
  "navigation.table." + collection;
export async function defaultTableId(runtime: AppRuntime, collection: string) {
  return deviceRecordId(
    await digest(
      utf8.encode(runtime.profile.workspaceId + "/table/" + collection),
    ),
  );
}
export function tableDefinitions(runtime: AppRuntime, collection: string) {
  return runtime.db.records
    .where("collection")
    .equals("tables")
    .filter((r) => !r.deletedAt && r.data.collection_id === collection)
    .toArray();
}
export async function createCollectionTable(
  runtime: AppRuntime,
  collection: string,
  name: string,
  isDefault = false,
) {
  const schema = getSchema(collection);
  invariant(
    schema.tables && runtime.registry.enabled(schema.pluginId),
    "FEATURE_DISABLED",
    "This collection does not support tables",
  );
  const id = isDefault
    ? await defaultTableId(runtime, collection)
    : crypto.randomUUID();
  const existing = runtime.node.records.get(id);
  if (existing && !existing.deletedAt) return existing;
  const store = runtime.db
    .scoped({ ...runtime.principal, pluginId: schema.pluginId }, "tables")
    .collection("tables");
  const presets = collectionColumns(schema),
    required = presets.filter((f) => f.required);
  const columns = isDefault
    ? presets
    : required.length
      ? required
      : [
          presets.find((f) => ["title", "subject", "name"].includes(f.id)) ??
            presets[0],
        ];
  return store.put(
    {
      name: name.trim() || schema.name,
      collection_id: collection,
      is_default: isDefault,
      columns: columns as unknown as Value,
    },
    id,
  );
}
export async function ensureCollectionTables(runtime: AppRuntime) {
  if (!runtime.node.records.canWrite()) return;
  for (const schema of schemaById.values())
    if (schema.tables && runtime.registry.enabled(schema.pluginId))
      await createCollectionTable(runtime, schema.id, schema.name, true);
}
export async function selectedCollectionTable(
  runtime: AppRuntime,
  collection: string,
) {
  const id = await runtime.db.getMetadata<string>(
    tableSelectionKey(collection),
  );
  const definitions = await tableDefinitions(runtime, collection);
  return (
    definitions.find((t) => t.id === id) ??
    definitions.find((t) => t.data.is_default) ??
    definitions[0]
  );
}
export function belongsToTable(row: ResourceRecord, table?: ResourceRecord) {
  return (
    !table ||
    row.data.table_id === table.id ||
    (!row.data.table_id && Boolean(table.data.is_default))
  );
}
export function scopedTableStore<
  T extends {
    list: (...args: any[]) => Promise<ResourceRecord[]>;
    put: (data: any, id?: string) => Promise<ResourceRecord>;
  },
>(runtime: AppRuntime, collection: string, source: T): T {
  if (!getSchema(collection).tables) return source;
  return {
    ...source,
    list: async (query?: { limit?: number; [key: string]: unknown }) => {
      const table = await selectedCollectionTable(runtime, collection);
      // Apply the limit after table membership; other tables cannot consume it.
      const rows = (
        await source.list(query ? { ...query, limit: undefined } : undefined)
      ).filter((row) => belongsToTable(row, table));
      return query?.limit === undefined ? rows : rows.slice(0, query.limit);
    },
    put: async (input: Record<string, Value>, id?: string) => {
      const old = id ? await runtime.db.records.get(id) : undefined;
      const table = await selectedCollectionTable(runtime, collection);
      return source.put(
        {
          ...input,
          table_id: old
            ? (old.data.table_id ?? null)
            : (input.table_id ?? table?.id ?? null),
          custom_fields: input.custom_fields ?? old?.data.custom_fields ?? {},
        },
        id,
      );
    },
  };
}
