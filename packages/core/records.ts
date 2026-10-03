import type { Replica } from "./replica";
import type { ResourceRecord } from "@taskasaur/platform/plugin-sdk";
import { getSchema } from "@taskasaur/platform/core/catalog";
import {
  queryRecords,
  validateRecord,
  type Query,
  type Value,
} from "@taskasaur/platform/field-types";
import {
  validateDynamicData,
  validateTableValues,
} from "@taskasaur/platform/core/dynamic-fields";
import { invariant } from "@taskasaur/platform/core/errors";
import { validateGraph, allNodes } from "@taskasaur/platform/core/workflows";
import { domainEvent } from "@taskasaur/platform/core/messages";
import {
  collectionColumns,
  customValues,
  generatedValues,
} from "@taskasaur/platform/core/collection-tables";
export function deviceRecordId(identityId: string) {
  return `${identityId.slice(0, 8)}-${identityId.slice(8, 12)}-4${identityId.slice(13, 16)}-8${identityId.slice(17, 20)}-${identityId.slice(20, 32)}`;
}
export class ReplicaRecords {
  constructor(readonly replica: Replica) {}
  get(id: string) {
    return this.replica.read<ResourceRecord>("record/" + id);
  }
  all() {
    return this.replica
      .ids("record/")
      .flatMap((id) => this.replica.read<ResourceRecord>(id) ?? []);
  }
  list(collection: string, query: Query = {}) {
    return queryRecords(
      this.all().filter((r) => r.collection === collection && !r.deletedAt),
      getSchema(collection),
      query,
    );
  }
  canWrite() {
    return Boolean(
      this.replica.member && this.replica.member.role !== "viewer",
    );
  }
  async put(
    collection: string,
    input: unknown,
    id: string = crypto.randomUUID(),
    options: {
      ownerId?: string;
      createdAt?: string;
      eventId?: string;
      managedBy?: string;
    } = {},
  ) {
    const schema = getSchema(collection),
      old = this.get(id),
      data = validateRecord(schema, generatedValues(schema, input, old?.data));
    invariant(this.canWrite(), "PERMISSION_DENIED", "Workspace is read only");
    invariant(
      !old || old.collection === collection,
      "PERMISSION_DENIED",
      "Resource kind cannot change",
    );
    invariant(
      !old || schema.version >= (old.schemaVersion ?? 1),
      "SCHEMA_UPGRADE_REQUIRED",
      "Update this plugin before editing newer data",
    );
    this.validateData(
      collection,
      data,
      id,
      old ? old.managedBy : options.managedBy,
    );
    if (collection === "workflows" && Number(data.published_version) > 0) {
      invariant(
        data.target_device_id,
        "VALIDATION_FAILED",
        "Published workflows require an explicit device",
      );
      const graph = validateGraph(data.graph),
        trusted = allNodes(graph).some((n) => n.type === "typescript");
      invariant(
        !trusted || data.allow_trusted_code === true,
        "PERMISSION_DENIED",
        "Enable trusted TypeScript before publishing code nodes",
      );
      const pin = "setting/workflow." + id + "." + data.published_version;
      if (!this.replica.read(pin))
        await this.replica.update(pin, {
          graph,
          targetDeviceId: data.target_device_id,
          trusted,
          version: data.published_version,
        });
    }
    const now = new Date().toISOString();
    const record: ResourceRecord = {
      ...((old ? old.managedBy : options.managedBy)
        ? { managedBy: old ? old.managedBy : options.managedBy }
        : {}),
      schemaVersion: schema.version,
      id,
      workspaceId: this.replica.workspaceId,
      ownerId: old?.ownerId ?? options.ownerId ?? this.replica.member.userId,
      pluginId: schema.pluginId,
      collection,
      revision: (old?.revision ?? 0) + 1,
      createdAt: old?.createdAt ?? options.createdAt ?? now,
      updatedAt: now,
      deletedAt: null,
      data,
    };
    await this.replica.update(
      "record/" + id,
      record as unknown as Record<string, unknown>,
    );
    await this.event(record, "put", options.eventId);
    return this.get(id)!;
  }
  async delete(id: string, eventId?: string) {
    const old = this.get(id);
    invariant(old, "NOT_FOUND", "Record not found");
    if (old.collection === "tables") {
      invariant(
        !old.data.is_default,
        "DEFAULT_TABLE",
        "The default table cannot be deleted",
      );
      invariant(
        !this.all().some((r) => !r.deletedAt && r.data.table_id === id),
        "TABLE_NOT_EMPTY",
        "Move or delete this table's entries first",
      );
    }
    await this.replica.update("record/" + id, {
      ...old,
      deletedAt: new Date().toISOString(),
      revision: old.revision + 1,
    });
    await this.event(this.get(id)!, "delete", eventId);
  }
  private validateData(
    collection: string,
    data: Record<string, Value>,
    id: string,
    managedBy?: string,
  ) {
    const schema = getSchema(collection),
      old = this.get(id);
    validateDynamicData(collection, data);
    if (collection === "tables" && old) {
      invariant(
        old.data.collection_id === data.collection_id &&
          Boolean(old.data.is_default) === Boolean(data.is_default),
        "INVALID_TABLE",
        "A table's collection and default status cannot change",
      );
    }
    if (collection === "tables" && data.collection_id) {
      const target = getSchema(String(data.collection_id));
      invariant(
        target.tables && managedBy === target.pluginId,
        "PERMISSION_DENIED",
        "Plugin tables must be created through their owning plugin",
      );
      collectionColumns(target, data.columns);
      // Schema changes cannot invalidate existing rows or silently drop stored values.
      for (const row of this.all().filter(
        (r) =>
          !r.deletedAt && r.collection === target.id && r.data.table_id === id,
      ))
        customValues(target, data.columns, row.data.custom_fields);
    }
    if (schema.tables) {
      const definition = data.table_id
        ? this.get(String(data.table_id))
        : undefined;
      invariant(
        !data.table_id ||
          (definition?.collection === "tables" &&
            !definition.deletedAt &&
            definition.data.collection_id === collection &&
            definition.managedBy === schema.pluginId),
        "INVALID_TABLE",
        "Choose a table belonging to this collection",
      );
      if (definition)
        data.custom_fields = customValues(
          schema,
          definition.data.columns,
          data.custom_fields,
        );
      else
        invariant(
          !data.custom_fields || !Object.keys(data.custom_fields).length,
          "INVALID_TABLE",
          "Custom fields require a table",
        );
    }
    if (collection === "table_rows") {
      const definition = this.get(String(data.table_id));
      invariant(
        definition?.collection === "tables" && !definition.deletedAt,
        "NOT_FOUND",
        "Table definition was not found",
      );
      data.values = validateTableValues(definition.data.columns, data.values);
    }
  }
  private async event(
    record: ResourceRecord,
    operation: string,
    id: string = crypto.randomUUID(),
  ) {
    if (record.collection === "devices") return;
    const event = domainEvent(
      {
        workspaceId: this.replica.workspaceId,
        userId: this.replica.member.userId,
        pluginId: record.pluginId,
        permissions: [],
      },
      record.collection + ".changed",
      record.id,
      record.revision,
      { operation },
      id,
    );
    if (!this.replica.read("event/" + id))
      await this.replica.update(
        "event/" + id,
        event as unknown as Record<string, unknown>,
      );
  }
  async resolve(id: string, field: string, value: Value) {
    const record = this.get(id);
    invariant(record, "NOT_FOUND", "Record not found");
    const data = validateRecord(getSchema(record.collection), {
      ...record.data,
      [field]: value,
    });
    this.validateData(record.collection, data, id, record.managedBy);
    await this.replica.update(
      "record/" + id,
      {
        ...record,
        data,
        revision: record.revision + 1,
        updatedAt: new Date().toISOString(),
      },
      ["data." + field],
    );
    return this.get(id)!;
  }
}
