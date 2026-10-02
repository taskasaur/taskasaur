import { createHash, randomUUID } from "node:crypto";
import type { Database } from "./database";
import { getSchema, isRequiredCore } from "../packages/core/catalog";
import {
  validateRecord,
  sqlIdentifier,
  queryRecords,
  type Value,
  type Query,
} from "../packages/field-types";
import type {
  Principal,
  Mutation,
  ResourceRecord,
} from "../packages/plugin-sdk";
import { invariant, CoreError } from "../packages/core/errors";
import { domainEvent } from "../packages/core/messages";
import { seedCorePlugins } from "./schema";
import {
  validateDynamicData,
  validateTableValues,
} from "../packages/core/dynamic-fields";
import { writeTypedValues, readTypedValues } from "./typed-values";
import { validateGraph, allNodes } from "../packages/core/workflows";
import { compileTypeScript } from "./typescript";
import { encodeSqlField, decodeSqlField } from "./field-codecs";

type ResourceRow = {
  id: string;
  workspace_id: string;
  owner_id: string;
  plugin_id: string;
  collection: string;
  revision: string | number;
  created_at: string | Date;
  updated_at: string | Date;
  deleted_at: string | Date | null;
} & Record<string, unknown>;
const iso = (value: unknown) =>
  value instanceof Date
    ? value.toISOString()
    : String(value)
        .replace(" ", "T")
        .replace(/([+-]\d{2})$/, "$1:00");
export class Repository {
  constructor(public readonly db: Database) {}
  async featureEnabled(principal: Principal, id: string, feature: string) {
    if (isRequiredCore(id)) return true;
    const result = await this.db.query<{
      enabled: boolean;
      features: string[];
    }>(
      "SELECT enabled,features FROM taskasaur.plugins WHERE workspace_id=$1 AND id=$2",
      [principal.workspaceId, id],
    );
    return Boolean(
      result.rows[0]?.enabled && result.rows[0].features.includes(feature),
    );
  }
  async requirePlugin(principal: Principal, id: string, tx = this.db) {
    const result = await tx.query<{ enabled: boolean }>(
      "SELECT enabled FROM taskasaur.plugins WHERE workspace_id=$1 AND id=$2 AND installed",
      [principal.workspaceId, id],
    );
    invariant(
      result.rows[0]?.enabled,
      isRequiredCore(id) ? "CORE_DEPENDENCY_UNAVAILABLE" : "FEATURE_DISABLED",
      isRequiredCore(id)
        ? `Required provider ${id} is unavailable; run the matching release migration`
        : `${id} is disabled`,
    );
  }
  async createWorkspace(userId: string, name: string, id = randomUUID()) {
    await this.db.transaction(async (tx) => {
      await tx.query(
        "INSERT INTO taskasaur.workspaces(id,owner_id,name) VALUES($1,$2,$3)",
        [id, userId, name],
      );
      await tx.query(
        "INSERT INTO taskasaur.memberships(workspace_id,user_id,role) VALUES($1,$2,'owner')",
        [id, userId],
      );
      await seedCorePlugins(tx, id);
    });
    return id;
  }
  async membership(principal: Principal, write = false, tx = this.db) {
    const result = await tx.query<{ role: string }>(
      "SELECT role FROM taskasaur.memberships WHERE workspace_id=$1 AND user_id=$2",
      [principal.workspaceId, principal.userId],
    );
    invariant(
      result.rows.length && (!write || result.rows[0].role !== "viewer"),
      "PERMISSION_DENIED",
      "Workspace access denied",
    );
    return result.rows[0].role;
  }
  async authorize(
    principal: Principal,
    id: string,
    write = false,
    tx = this.db,
  ): Promise<ResourceRow> {
    await this.membership(principal, write, tx);
    const result = await tx.query<ResourceRow>(
      "SELECT * FROM taskasaur.resources WHERE id=$1 AND workspace_id=$2",
      [id, principal.workspaceId],
    );
    const resource = result.rows[0];
    invariant(resource, "NOT_FOUND", "Resource not found");
    if (resource.owner_id !== principal.userId) {
      const grants = await tx.query<{ role: string }>(
        "SELECT role FROM taskasaur.grants WHERE resource_id=$1 AND subject_id=$2 AND (expires_at IS NULL OR expires_at>now())",
        [id, principal.userId],
      );
      invariant(
        grants.rows.length && (!write || grants.rows[0].role === "editor"),
        "PERMISSION_DENIED",
        "Resource access denied",
      );
      invariant(
        resource.collection !== "credentials",
        "PERMISSION_DENIED",
        "Credential metadata requires an explicit credential grant",
      );
    }
    return resource;
  }
  private async hydrate(
    row: ResourceRow,
    tx = this.db,
  ): Promise<ResourceRecord> {
    const schema = getSchema(row.collection);
    const result = await tx.query(
      `SELECT * FROM taskasaur.${sqlIdentifier("p_" + schema.id)} WHERE id=$1`,
      [row.id],
    );
    const data = result.rows[0];
    invariant(data, "DATA_INTEGRITY_ERROR", "Resource payload is missing");
    const payload: Record<string, Value> = {};
    for (const f of schema.fields)
      payload[f.id] = decodeSqlField(f, data[f.id]);
    if (schema.id === "table_rows") {
      const definition = (
        await tx.query<{ columns: unknown }>(
          "SELECT columns FROM taskasaur.p_tables WHERE id=$1",
          [payload.table_id],
        )
      ).rows[0];
      invariant(
        definition,
        "DATA_INTEGRITY_ERROR",
        "Table definition is missing",
      );
      payload.values = await readTypedValues(tx, row.id, definition.columns);
    }
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      ownerId: row.owner_id,
      pluginId: row.plugin_id,
      collection: row.collection,
      revision: Number(row.revision),
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
      deletedAt: row.deleted_at ? iso(row.deleted_at) : null,
      data: payload,
    };
  }
  async get(principal: Principal, id: string) {
    return this.hydrate(await this.authorize(principal, id));
  }
  async list(principal: Principal, collection: string, query: Query = {}) {
    await this.membership(principal);
    const schema = getSchema(collection);
    await this.requirePlugin(principal, schema.pluginId);
    const result = await this.db.query<ResourceRow>(
      `SELECT r.* FROM taskasaur.resources r WHERE r.workspace_id=$1 AND r.collection=$2 AND r.deleted_at IS NULL AND (r.owner_id=$3 OR (r.collection<>'credentials' AND EXISTS(SELECT 1 FROM taskasaur.grants g WHERE g.resource_id=r.id AND g.subject_id=$3 AND (g.expires_at IS NULL OR g.expires_at>now())))) ORDER BY r.id LIMIT 10000`,
      [principal.workspaceId, collection, principal.userId],
    );
    const rows = await Promise.all(result.rows.map((row) => this.hydrate(row)));
    return queryRecords(rows, schema, query);
  }
  async mutate(
    principal: Principal,
    mutation: Mutation,
    source: "service" | "plugin" = "service",
  ) {
    const schema = getSchema(mutation.collection);
    invariant(
      mutation.pluginId === schema.pluginId,
      "UNDECLARED_COLLECTION",
      "Wrong collection owner",
    );
    let data =
      mutation.operation === "put" ? validateRecord(schema, mutation.data) : {};
    const hash = createHash("sha256")
      .update(JSON.stringify(mutation))
      .digest("hex");
    return this.db.transaction(async (tx) => {
      await this.membership(principal, true, tx);
      // Workspace serialization makes the change cursor commit ordered and fences deduplication.
      await tx.query(
        "SELECT id FROM taskasaur.workspaces WHERE id=$1 FOR UPDATE",
        [principal.workspaceId],
      );
      const prior = await tx.query<{
        request_hash: string;
        result: ResourceRecord;
      }>(
        "SELECT request_hash,result FROM taskasaur.mutations WHERE workspace_id=$1 AND user_id=$2 AND id=$3",
        [principal.workspaceId, principal.userId, mutation.id],
      );
      if (prior.rows.length) {
        invariant(
          prior.rows[0].request_hash === hash,
          "IDEMPOTENCY_CONFLICT",
          "Mutation ID was used for another request",
        );
        return prior.rows[0].result;
      }
      if (source === "plugin")
        invariant(
          !["devices", "jobs", "workflow_runs"].includes(schema.id),
          "PERMISSION_DENIED",
          "Use the owning core service to change this resource",
        );
      if (mutation.operation === "put") {
        validateDynamicData(schema.id, data);
        if (schema.id === "workflows" && data.published_version) {
          invariant(
            data.target_device_id,
            "VALIDATION_FAILED",
            "Published workflows require an explicit device",
          );
          const graph = validateGraph(data.graph);
          if (data.enabled && data.trigger_kind === "schedule")
            invariant(
              Number(data.schedule_seconds) >= 10 && data.schedule_start,
              "VALIDATION_FAILED",
              "An enabled schedule needs an interval and start instant",
            );
          if (data.enabled && data.trigger_kind === "event")
            invariant(
              typeof data.event_type === "string" &&
                /^taskasaur\.[a-zA-Z0-9._-]+\.v1$/.test(data.event_type),
              "VALIDATION_FAILED",
              "An event trigger needs a versioned committed event type",
            );
          for (const node of allNodes(graph))
            if (node.type === "typescript") {
              invariant(
                data.allow_trusted_code === true,
                "PERMISSION_DENIED",
                "Enable trusted TypeScript before publishing code nodes",
              );
              compileTypeScript(String(node.config.source));
            }
        }
        if (schema.id === "time" && !data.ended_at) {
          const active = await tx.query(
            "SELECT r.id FROM taskasaur.resources r JOIN taskasaur.p_time p ON p.id=r.id WHERE r.workspace_id=$1 AND r.owner_id=$2 AND r.deleted_at IS NULL AND p.ended_at IS NULL AND r.id<>$3",
            [principal.workspaceId, principal.userId, mutation.resourceId],
          );
          invariant(
            !active.rows.length,
            "TIMER_ALREADY_RUNNING",
            "Stop the active timer before starting another",
          );
        }
        if (schema.id === "table_rows") {
          const table = await this.hydrate(
            await this.authorize(principal, String(data.table_id), true, tx),
            tx,
          );
          invariant(
            table.collection === "tables" && !table.deletedAt,
            "NOT_FOUND",
            "Table definition was not found",
          );
          data.values = validateTableValues(table.data.columns, data.values);
        }
      }
      if (!isRequiredCore(schema.pluginId)) {
        const plugin = await tx.query<{ enabled: boolean }>(
          "SELECT enabled FROM taskasaur.plugins WHERE workspace_id=$1 AND id=$2",
          [principal.workspaceId, schema.pluginId],
        );
        invariant(
          plugin.rows[0]?.enabled,
          "FEATURE_DISABLED",
          `${schema.pluginId} is disabled`,
        );
      }
      const existing = await tx.query<ResourceRow>(
        "SELECT * FROM taskasaur.resources WHERE id=$1",
        [mutation.resourceId],
      );
      if (source === "plugin") {
        invariant(
          !["mailboxes", "github_issues"].includes(schema.id),
          "READ_ONLY",
          "Use the provider command to update this projection",
        );
        if (schema.id === "mail") {
          const current = existing.rows[0]
            ? (await this.hydrate(existing.rows[0], tx)).data
            : undefined;
          invariant(
            !current || ["draft", "failed"].includes(String(current.status)),
            "INVALID_MAIL_STATE",
            "Only editable drafts can be changed; use mailbox operations for received mail",
          );
          if (mutation.operation === "put") {
            invariant(
              ["draft", "queued"].includes(String(data.status)),
              "INVALID_MAIL_STATE",
              "Delivery status is managed by the mail service",
            );
            for (const key of [
              "provider_uid",
              "uid_validity",
              "received_at",
              "html",
            ])
              invariant(
                data[key] == null,
                "PERMISSION_DENIED",
                "Provider mail fields cannot be supplied by clients",
              );
            if (data.status === "queued")
              invariant(
                data.account_id &&
                  data.send_operation_id &&
                  Array.isArray(data.to) &&
                  data.to.length,
                "VALIDATION_FAILED",
                "Queued mail needs an account, recipients and send operation ID",
              );
          }
        }
        if (schema.id === "mail_operations")
          invariant(
            !existing.rows.length && data.status === "queued",
            "READ_ONLY",
            "Queued mailbox operations are immutable",
          );
      }
      if (existing.rows.length) {
        const old = await this.authorize(
          principal,
          mutation.resourceId,
          true,
          tx,
        );
        invariant(
          old.collection === schema.id,
          "PERMISSION_DENIED",
          "Resource kind cannot change",
        );
        invariant(
          Number(old.revision) === mutation.baseRevision,
          "REVISION_CONFLICT",
          "Resource has changed since your edit",
        );
        invariant(!old.deleted_at, "REVISION_CONFLICT", "Resource was deleted");
        await tx.query(
          "UPDATE taskasaur.resources SET revision=revision+1,updated_at=now(),deleted_at=CASE WHEN $2 THEN now() ELSE NULL END WHERE id=$1",
          [mutation.resourceId, mutation.operation === "delete"],
        );
      } else {
        invariant(
          mutation.baseRevision === 0 && mutation.operation === "put",
          "REVISION_CONFLICT",
          "Resource no longer exists",
        );
        await tx.query(
          "INSERT INTO taskasaur.resources(id,workspace_id,owner_id,plugin_id,collection) VALUES($1,$2,$3,$4,$5)",
          [
            mutation.resourceId,
            principal.workspaceId,
            principal.userId,
            schema.pluginId,
            schema.id,
          ],
        );
      }
      if (mutation.operation === "put") {
        if (source === "plugin" && schema.id === "files") {
          const current = existing.rows[0]
            ? (await this.hydrate(existing.rows[0], tx)).data
            : {};
          data = {
            ...data,
            version_id: current.version_id ?? null,
            checksum: current.checksum ?? null,
            upload_state: current.upload_state ?? "local",
            size: current.size ?? "0",
          };
        }
        const names = schema.fields.map((f) => sqlIdentifier(f.id));
        const values = schema.fields.map((f) => encodeSqlField(f, data[f.id]));
        await tx.query(
          `INSERT INTO taskasaur.${sqlIdentifier("p_" + schema.id)}(id,${names.join(",")}) VALUES($1,${values.map((_, i) => "$" + (i + 2)).join(",")}) ON CONFLICT(id) DO UPDATE SET ${names.map((name) => `${name}=EXCLUDED.${name}`).join(",")}`,
          [mutation.resourceId, ...values],
        );
        if (schema.id === "table_rows") {
          const definition = (
            await tx.query<{ columns: unknown }>(
              "SELECT columns FROM taskasaur.p_tables WHERE id=$1",
              [data.table_id],
            )
          ).rows[0];
          await writeTypedValues(
            tx,
            mutation.resourceId,
            String(data.table_id),
            definition.columns,
            data.values as Record<string, Value>,
          );
        }
      }
      const row = (
        await tx.query<ResourceRow>(
          "SELECT * FROM taskasaur.resources WHERE id=$1",
          [mutation.resourceId],
        )
      ).rows[0];
      const record = await this.hydrate(row, tx);
      if (
        schema.id === "workflows" &&
        mutation.operation === "put" &&
        data.published_version
      )
        await tx.query(
          "INSERT INTO taskasaur.workflow_versions(workflow_id,version,graph,target_device_id,trusted_code) VALUES($1,$2,$3,$4,$5) ON CONFLICT(workflow_id,version) DO NOTHING",
          [
            record.id,
            data.published_version,
            JSON.stringify(validateGraph(data.graph)),
            data.target_device_id,
            data.allow_trusted_code === true,
          ],
        );
      const seq = (
        await tx.query<{ revision: string }>(
          "UPDATE taskasaur.workspaces SET revision=revision+1 WHERE id=$1 RETURNING revision",
          [principal.workspaceId],
        )
      ).rows[0].revision;
      await tx.query(
        "INSERT INTO taskasaur.changes(workspace_id,sequence,resource_id,event) VALUES($1,$2,$3,$4)",
        [
          principal.workspaceId,
          seq,
          record.id,
          JSON.stringify(
            domainEvent(
              { ...principal, pluginId: schema.pluginId },
              `${schema.id}.changed`,
              record.id,
              record.revision,
              { operation: mutation.operation },
              mutation.id,
            ),
          ),
        ],
      );
      await tx.query(
        "INSERT INTO taskasaur.mutations(workspace_id,user_id,id,request_hash,result) VALUES($1,$2,$3,$4,$5)",
        [
          principal.workspaceId,
          principal.userId,
          mutation.id,
          hash,
          JSON.stringify(record),
        ],
      );
      await tx.query(
        "INSERT INTO taskasaur.plugin_events(id,workspace_id,actor_id,event) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO NOTHING",
        [
          mutation.id,
          principal.workspaceId,
          principal.userId,
          JSON.stringify(
            domainEvent(
              { ...principal, pluginId: schema.pluginId },
              `${schema.id}.changed`,
              record.id,
              record.revision,
              { operation: mutation.operation },
              mutation.id,
            ),
          ),
        ],
      );
      return record;
    });
  }
  async pull(principal: Principal, cursor: string) {
    const role = await this.membership(principal);
    invariant(/^\d+$/.test(cursor), "VALIDATION_FAILED", "Invalid sync cursor");
    const changes = await this.db.query<{
      sequence: string;
      resource_id: string;
    }>(
      "SELECT sequence,resource_id FROM taskasaur.changes WHERE workspace_id=$1 AND sequence>$2 ORDER BY sequence LIMIT 250",
      [principal.workspaceId, cursor],
    );
    const records: ResourceRecord[] = [];
    for (const id of new Set(changes.rows.map((c) => c.resource_id))) {
      try {
        records.push(await this.get(principal, id));
      } catch (error) {
        if (!(
          error instanceof CoreError &&
          ["PERMISSION_DENIED", "NOT_FOUND"].includes(error.kind)
        ))
          throw error;
      }
    }
    return {
      records,
      authorizedIds: (
        await this.db.query<{ id: string }>(
          "SELECT r.id FROM taskasaur.resources r WHERE r.workspace_id=$1 AND (r.owner_id=$2 OR (r.collection<>'credentials' AND EXISTS(SELECT 1 FROM taskasaur.grants g WHERE g.resource_id=r.id AND g.subject_id=$2 AND (g.expires_at IS NULL OR g.expires_at>now()))))",
          [principal.workspaceId, principal.userId],
        )
      ).rows.map((r) => r.id),
      writableIds:
        role === "viewer"
          ? []
          : (
              await this.db.query<{ id: string }>(
                "SELECT r.id FROM taskasaur.resources r WHERE r.workspace_id=$1 AND (r.owner_id=$2 OR (r.collection<>'credentials' AND EXISTS(SELECT 1 FROM taskasaur.grants g WHERE g.resource_id=r.id AND g.subject_id=$2 AND g.role='editor' AND (g.expires_at IS NULL OR g.expires_at>now()))))",
                [principal.workspaceId, principal.userId],
              )
            ).rows.map((r) => r.id),
      workspaceWrite: role !== "viewer",
      cursor: String(changes.rows.at(-1)?.sequence ?? cursor),
      hasMore: changes.rows.length === 250,
    };
  }
}
