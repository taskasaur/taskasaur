import Dexie, { liveQuery, type Table } from "dexie";
import type { Mutation, Principal, ResourceRecord } from "../plugin-sdk";
import { getSchema, manifestById, isRequiredCore } from "../core/catalog";
import { invariant } from "../core/errors";
import { validateRecord, queryRecords, type Query } from "../field-types";
import type { PluginState } from "../core/registry";
import {
  validateDynamicData,
  validateTableValues,
} from "../core/dynamic-fields";

export interface PendingMutation extends Mutation {
  sequence?: number;
  state: "pending" | "sending" | "conflict" | "rejected";
  error?: string;
  serverRecord?: ResourceRecord;
}
export interface FileVersion {
  id: string;
  fileId: string;
  parentVersionId: string | null;
  blob: Blob;
  createdAt: string;
  synced: boolean;
  error?: string;
  recoveryFileId?: string;
}
interface Metadata {
  key: string;
  value: unknown;
}
export class LocalDatabase extends Dexie {
  records!: Table<ResourceRecord, string>;
  outbox!: Table<PendingMutation, number>;
  metadata!: Table<Metadata, string>;
  plugins!: Table<PluginState, string>;
  fileVersions!: Table<FileVersion, string>;
  constructor(
    public readonly workspaceId: string,
    public readonly userId: string,
    name?: string,
  ) {
    super(name ?? `taskasaur-v2-${userId}-${workspaceId}`);
    this.version(1).stores({
      records: "id,collection,pluginId,updatedAt,[collection+deletedAt]",
      outbox: "++sequence,&id,resourceId,state",
      metadata: "key",
      plugins: "id",
      fileVersions: "id,fileId,createdAt",
    });
  }
  pluginPersistence() {
    return {
      load: () => this.plugins.toArray(),
      save: async (state: PluginState) => {
        await this.plugins.put(state);
      },
    };
  }
  async getMetadata<T>(key: string): Promise<T | undefined> {
    return (await this.metadata.get(key))?.value as T | undefined;
  }
  async setMetadata(key: string, value: unknown) {
    await this.metadata.put({ key, value });
  }
  async canWrite(record?: ResourceRecord) {
    const snapshot = await this.getMetadata<{
      writableIds: string[];
      workspaceWrite: boolean;
      checkedAt: number;
    }>("access.snapshot");
    if (!snapshot) return !record || record.ownerId === this.userId;
    if (!snapshot.workspaceWrite || Date.now() - snapshot.checkedAt > 86400000)
      return false;
    return (
      !record ||
      (record.revision === 0 && record.ownerId === this.userId) ||
      snapshot.writableIds.includes(record.id)
    );
  }
  scoped(
    principal: Principal,
    pluginId: string,
    sync: "synced" | "local-only" | "cache" = "local-only",
  ) {
    invariant(
      principal.userId === this.userId &&
        principal.workspaceId === this.workspaceId,
      "PERMISSION_DENIED",
      "Storage scope mismatch",
    );
    const manifest = manifestById.get(pluginId);
    invariant(
      manifest?.storage.local.mode === "dexie",
      "UNDECLARED_CAPABILITY",
      "Plugin did not declare local persistence",
    );
    const collection = (id: string) => {
      invariant(
        manifest.storage.local.collections.includes(id),
        "UNDECLARED_COLLECTION",
        `Collection ${id} is not declared by ${pluginId}`,
      );
      const schema = getSchema(id);
      const authorize = async () => {
        const state = await this.plugins.get(pluginId);
        invariant(
          isRequiredCore(pluginId) || state?.enabled,
          "FEATURE_DISABLED",
          `${pluginId} is disabled`,
        );
      };
      const list = async (query: Query = {}) => {
        await authorize();
        const rows = (
          await this.records.where("collection").equals(id).toArray()
        ).filter(
          (r) => !r.deletedAt && r.workspaceId === principal.workspaceId,
        );
        return queryRecords(rows, schema, query);
      };
      return {
        list,
        observe: (query: Query = {}) => liveQuery(() => list(query)),
        get: async (resourceId: string) => {
          await authorize();
          const record = await this.records.get(resourceId);
          invariant(
            !record || record.collection === id,
            "PERMISSION_DENIED",
            "Resource belongs to another collection",
          );
          return record;
        },
        put: async (input: unknown, resourceId = crypto.randomUUID()) => {
          invariant(
            sync !== "cache",
            "READ_ONLY",
            "Cache projections are ingestion-only",
          );
          const data = validateRecord(schema, input);
          const now = new Date().toISOString();
          return this.transaction(
            "rw",
            this.records,
            this.outbox,
            this.plugins,
            this.metadata,
            async () => {
              await authorize();
              validateDynamicData(id, data);
              if (id === "time" && !data.ended_at) {
                const active = await this.records
                  .where("collection")
                  .equals("time")
                  .filter(
                    (r) =>
                      !r.deletedAt &&
                      r.ownerId === principal.userId &&
                      !r.data.ended_at &&
                      r.id !== resourceId,
                  )
                  .first();
                invariant(
                  !active,
                  "TIMER_ALREADY_RUNNING",
                  "Stop the active timer before starting another",
                );
              }
              if (id === "table_rows") {
                const definition = await this.records.get(
                  String(data.table_id),
                );
                invariant(
                  definition?.collection === "tables" && !definition.deletedAt,
                  "NOT_FOUND",
                  "Table definition was not found",
                );
                data.values = validateTableValues(
                  definition.data.columns,
                  data.values,
                );
              }
              const previous = await this.records.get(resourceId);
              invariant(
                await this.canWrite(previous),
                "PERMISSION_DENIED",
                "Editing access is unavailable; reconnect to refresh permissions",
              );
              invariant(
                !previous ||
                  (previous.collection === id &&
                    (await this.canWrite(previous))),
                "PERMISSION_DENIED",
                "Cannot replace this resource",
              );
              const record: ResourceRecord = {
                id: resourceId,
                workspaceId: principal.workspaceId,
                ownerId: previous?.ownerId ?? principal.userId,
                pluginId,
                collection: id,
                revision: previous?.revision ?? 0,
                createdAt: previous?.createdAt ?? now,
                updatedAt: now,
                deletedAt: null,
                data,
              };
              await this.records.put(record);
              if (sync === "synced")
                await this.outbox.add({
                  id: crypto.randomUUID(),
                  resourceId,
                  pluginId,
                  collection: id,
                  operation: "put",
                  baseRevision: record.revision,
                  data,
                  createdAt: now,
                  state: "pending",
                });
              return record;
            },
          );
        },
        delete: async (resourceId: string) => {
          invariant(
            sync !== "cache",
            "READ_ONLY",
            "Cache projections are ingestion-only",
          );
          return this.transaction(
            "rw",
            this.records,
            this.outbox,
            this.plugins,
            this.metadata,
            async () => {
              await authorize();
              const old = await this.records.get(resourceId);
              invariant(
                old?.collection === id && (await this.canWrite(old)),
                "PERMISSION_DENIED",
                "Cannot delete this resource",
              );
              const now = new Date().toISOString();
              await this.records.put({
                ...old,
                deletedAt: now,
                updatedAt: now,
              });
              if (sync === "synced")
                await this.outbox.add({
                  id: crypto.randomUUID(),
                  resourceId,
                  pluginId,
                  collection: id,
                  operation: "delete",
                  baseRevision: old.revision,
                  data: {},
                  createdAt: now,
                  state: "pending",
                });
            },
          );
        },
      };
    };
    return { collection };
  }
  async saveFile(
    principal: Principal,
    fileId: string,
    blob: Blob,
    parentVersionId: string | null,
  ) {
    invariant(
      principal.userId === this.userId &&
        principal.workspaceId === this.workspaceId,
      "PERMISSION_DENIED",
      "Storage scope mismatch",
    );
    const id = crypto.randomUUID(),
      now = new Date().toISOString();
    // Blob and metadata share an IndexedDB transaction. Failure cannot acknowledge a partial save.
    await this.transaction(
      "rw",
      this.records,
      this.fileVersions,
      this.metadata,
      async () => {
        const resource = await this.records.get(fileId);
        invariant(
          resource?.collection === "files" && (await this.canWrite(resource)),
          "PERMISSION_DENIED",
          "File access denied",
        );
        invariant(
          (resource.data.version_id ?? null) === parentVersionId,
          "REVISION_CONFLICT",
          "File changed since it was opened",
        );
        await this.fileVersions.add({
          id,
          fileId,
          parentVersionId,
          blob,
          createdAt: now,
          synced: false,
        });
        await this.records.put({
          ...resource,
          updatedAt: now,
          data: {
            ...resource.data,
            size: String(blob.size),
            media_type: blob.type || "application/octet-stream",
            version_id: id,
          },
        });
      },
    );
    return id;
  }
  async ingest(records: ResourceRecord[], cursor: string) {
    await this.transaction(
      "rw",
      this.records,
      this.outbox,
      this.metadata,
      this.fileVersions,
      async () => {
        for (const record of records) {
          invariant(
            record.workspaceId === this.workspaceId,
            "PERMISSION_DENIED",
            "Ingestion scope mismatch",
          );
          const pending = await this.outbox
            .where("resourceId")
            .equals(record.id)
            .count();
          if (!pending) await this.mergeServerRecord(record);
          else
            await this.outbox
              .where("resourceId")
              .equals(record.id)
              .modify((entry) => {
                if (entry.state === "conflict") entry.serverRecord = record;
              });
        }
        await this.metadata.put({ key: "sync.cursor", value: cursor });
      },
    );
  }
  async acknowledge(mutationId: string, record: ResourceRecord) {
    await this.transaction(
      "rw",
      this.records,
      this.outbox,
      this.fileVersions,
      async () => {
        const mutation = await this.outbox
          .where("id")
          .equals(mutationId)
          .first();
        if (!mutation) return;
        await this.outbox.delete(mutation.sequence!);
        const later = await this.outbox
          .where("resourceId")
          .equals(record.id)
          .sortBy("sequence");
        if (!later.length) await this.mergeServerRecord(record);
        else {
          await this.outbox.update(later[0].sequence!, {
            baseRevision: record.revision,
          });
          const local = await this.records.get(record.id);
          if (local)
            await this.records.put({ ...local, revision: record.revision });
        }
      },
    );
  }
  private async mergeServerRecord(record: ResourceRecord) {
    const local = await this.records.get(record.id);
    const current =
      local?.collection === "files" && local.data.version_id
        ? await this.fileVersions.get(String(local.data.version_id))
        : undefined;
    if (current && !current.synced && !current.recoveryFileId && local) {
      await this.records.put({
        ...record,
        data: {
          ...record.data,
          version_id: current.id,
          size: String(current.blob.size),
          media_type: current.blob.type || String(local.data.media_type),
          upload_state: "local",
        },
      });
    } else await this.records.put(record);
  }
  async acknowledgeFile(versionId: string, record: ResourceRecord) {
    await this.transaction(
      "rw",
      this.records,
      this.fileVersions,
      this.outbox,
      async () => {
        const version = await this.fileVersions.get(versionId);
        invariant(
          version?.fileId === record.id,
          "INVALID_RESPONSE",
          "File acknowledgement does not match the local version",
        );
        await this.fileVersions.update(versionId, {
          synced: true,
          error: undefined,
        });
        await this.mergeServerRecord(record);
        const next = await this.outbox
          .where("resourceId")
          .equals(record.id)
          .first();
        if (next)
          await this.outbox.update(next.sequence!, {
            baseRevision: record.revision,
          });
      },
    );
  }
  async reconcileAccess(ids: string[]) {
    const allowed = new Set(ids);
    await this.transaction(
      "rw",
      this.records,
      this.outbox,
      this.fileVersions,
      async () => {
        const revoked = await this.records
          .filter((r) => r.revision > 0 && !allowed.has(r.id))
          .toArray();
        for (const record of revoked) {
          await this.records.delete(record.id);
          await this.fileVersions.where("fileId").equals(record.id).delete();
          await this.outbox.where("resourceId").equals(record.id).modify({
            state: "rejected",
            data: {},
            error: "Access was revoked; cached content has been removed",
          });
        }
      },
    );
  }
  async resolveConflict(
    resourceId: string,
    resolution: "server" | "local",
    revision: number,
  ) {
    return this.transaction(
      "rw",
      this.records,
      this.outbox,
      this.metadata,
      this.fileVersions,
      async () => {
        const pending = await this.outbox
            .where("resourceId")
            .equals(resourceId)
            .sortBy("sequence"),
          entry = pending[0],
          local = await this.records.get(resourceId),
          server = entry?.serverRecord;
        invariant(
          entry?.state === "conflict" && server && local,
          "NOT_FOUND",
          "Synchronize to load both versions before resolving",
        );
        invariant(
          server.revision === revision,
          "REVISION_CONFLICT",
          "The server changed again; review the latest version",
        );
        if (resolution === "local")
          invariant(
            await this.canWrite(server),
            "PERMISSION_DENIED",
            "Write permission is unavailable",
          );
        await this.outbox.where("resourceId").equals(resourceId).delete();
        if (resolution === "server") {
          await this.mergeServerRecord(server);
          return;
        }
        invariant(
          !server.deletedAt,
          "REVISION_CONFLICT",
          "The server deleted this record; export or copy the local values first",
        );
        const now = new Date().toISOString();
        await this.records.put({
          ...local,
          revision: server.revision,
          updatedAt: now,
        });
        await this.outbox.add({
          id: crypto.randomUUID(),
          resourceId,
          pluginId: local.pluginId,
          collection: local.collection,
          operation: local.deletedAt ? "delete" : "put",
          baseRevision: server.revision,
          data: local.deletedAt ? {} : local.data,
          createdAt: now,
          state: "pending",
        });
      },
    );
  }
}
