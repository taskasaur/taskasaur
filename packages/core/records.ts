import type { Replica } from "./replica";
import { LocalState } from "./local-state";
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
  templateValues,
} from "@taskasaur/platform/core/collection-tables";
export function deviceRecordId(identityId: string) {
  return `${identityId.slice(0, 8)}-${identityId.slice(8, 12)}-4${identityId.slice(13, 16)}-8${identityId.slice(17, 20)}-${identityId.slice(20, 32)}`;
}
export class ReplicaRecords {
  private localRecords = new Map<string, ResourceRecord>();
  constructor(readonly replica: Replica) {}
  private isLocal(row?: ResourceRecord) {
    return row?.collection === "settings" && row.data.scope === "device";
  }
  async open() {
    const storage = new LocalState(this.replica, "settings-records");
    for (const id of await storage.ids()) {
      const row = await storage.get<ResourceRecord>(id);
      if (row && this.isLocal(row)) this.localRecords.set(id, row);
    }
    // Migrate old device-scoped settings only on a device that actually authored them.
    const own = new Set(
      this.replica
        .entries()
        .filter((c) => c.author === this.replica.identity.id)
        .map((c) => c.documentId),
    );
    for (const id of this.replica.ids("record/")) {
      const row = this.replica.read<ResourceRecord>(id)!;
      if (this.isLocal(row) && own.has(id) && !this.localRecords.has(row.id)) {
        await storage.set(row.id, row);
        this.localRecords.set(row.id, row);
      }
    }
  }
  get(id: string) {
    const local = this.localRecords.get(id);
    if (local) return structuredClone(local);
    const row = this.replica.read<ResourceRecord>("record/" + id);
    return this.isLocal(row) ? undefined : row;
  }
  all() {
    const shared = this.replica
      .ids("record/")
      .flatMap((id) => this.replica.read<ResourceRecord>(id) ?? [])
      .filter((row) => !this.isLocal(row));
    return [
      ...shared.filter((row) => !this.localRecords.has(row.id)),
      ...[...this.localRecords.values()].map((row) => structuredClone(row)),
    ];
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
      old = this.get(id);
    let prepared = generatedValues(schema, input, old?.data);
    const definition =
      schema.tables && prepared.table_id
        ? this.get(String(prepared.table_id))
        : undefined;
    if (
      definition?.collection === "tables" &&
      definition.data.collection_id === collection
    )
      prepared = templateValues(
        schema,
        definition.data.columns,
        prepared,
        old?.data,
      );
    const data = validateRecord(schema, prepared);
    const local = collection === "settings" && data.scope === "device";
    invariant(
      local || this.canWrite(),
      "PERMISSION_DENIED",
      "Workspace is read only",
    );
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
    if (local) {
      invariant(
        !old || this.isLocal(old),
        "SCOPE_CHANGE",
        "Create a new device setting instead of changing a shared setting's scope",
      );
      await new LocalState(this.replica, "settings-records").set(id, record);
      this.localRecords.set(id, record);
      for (const listener of this.replica.listeners) listener("record/" + id);
      return structuredClone(record);
    }
    invariant(
      !old || !this.isLocal(old),
      "SCOPE_CHANGE",
      "Create a new shared setting instead of changing a device setting's scope",
    );
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
    if (this.isLocal(old)) {
      const row = {
        ...old,
        deletedAt: new Date().toISOString(),
        revision: old.revision + 1,
      };
      await new LocalState(this.replica, "settings-records").set(id, row);
      this.localRecords.set(id, row);
      for (const listener of this.replica.listeners) listener("record/" + id);
      return;
    }
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
        customValues(target, data.columns, row.data.custom_fields, row.data);
    }
    if (collection === "tables" && !data.collection_id)
      for (const row of this.all().filter(
        (r) =>
          !r.deletedAt &&
          r.collection === "table_rows" &&
          r.data.table_id === id,
      ))
        validateTableValues(data.columns, row.data.values);
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
          data,
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
      data.values = validateTableValues(definition.data.columns, {
        ...((old?.data.values as Record<string, Value>) ?? {}),
        ...(data.values as Record<string, Value>),
      });
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
