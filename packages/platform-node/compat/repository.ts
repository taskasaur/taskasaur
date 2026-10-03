import { createHash } from "node:crypto";
import { type Database, nodeFor } from "./database";
import { currentPolicy } from "../../core/identity";
import { projectRecord } from "./projection";
import { getSchema, isRequiredCore } from "@taskasaur/platform/core/catalog";
import { invariant } from "@taskasaur/platform/core/errors";
import { domainEvent } from "@taskasaur/platform/core/messages";
import type {
  Principal,
  Mutation,
  ResourceRecord,
} from "@taskasaur/platform/plugin-sdk";
import type { Query, Value } from "@taskasaur/platform/field-types";
export class Repository {
  constructor(readonly db: Database) {}
  async membership(actor: Principal, write = false, _tx = this.db) {
    const node = nodeFor(this.db, actor.workspaceId),
      members = Object.values(
        currentPolicy(node.replica.access).members,
      ).filter((m) => m.userId === actor.userId);
    const role = members.some((m) => m.role === "owner")
      ? "owner"
      : members.some((m) => m.role === "editor")
        ? "editor"
        : members[0]?.role;
    invariant(
      role && (!write || role !== "viewer"),
      "PERMISSION_DENIED",
      "Workspace access denied",
    );
    return role;
  }
  async authorize(actor: Principal, id: string, write = false, _tx = this.db) {
    await this.membership(actor, write);
    const record = nodeFor(this.db, actor.workspaceId).records.get(id);
    invariant(record, "NOT_FOUND", "Resource not found");
    return {
      id: record.id,
      workspace_id: record.workspaceId,
      owner_id: record.ownerId,
      plugin_id: record.pluginId,
      collection: record.collection,
      revision: record.revision,
      created_at: record.createdAt,
      updated_at: record.updatedAt,
      deleted_at: record.deletedAt,
    };
  }
  async get(actor: Principal, id: string) {
    await this.authorize(actor, id);
    return nodeFor(this.db, actor.workspaceId).records.get(id)!;
  }
  async list(actor: Principal, collection: string, query: Query = {}) {
    await this.membership(actor);
    await this.requirePlugin(actor, getSchema(collection).pluginId);
    return nodeFor(this.db, actor.workspaceId).records.list(collection, query);
  }
  async featureEnabled(actor: Principal, id: string, feature: string) {
    if (isRequiredCore(id)) return true;
    const { rows } = await this.db.query<{
      enabled: boolean;
      features: string[];
    }>(
      "SELECT enabled,features FROM taskasaur.plugins WHERE workspace_id=$1 AND id=$2",
      [actor.workspaceId, id],
    );
    return Boolean(rows[0]?.enabled && rows[0].features.includes(feature));
  }
  async requirePlugin(actor: Principal, id: string, tx = this.db) {
    if (isRequiredCore(id)) return;
    const { rows } = await tx.query<{ enabled: boolean }>(
      "SELECT enabled FROM taskasaur.plugins WHERE workspace_id=$1 AND id=$2 AND installed",
      [actor.workspaceId, id],
    );
    invariant(
      rows[0]?.enabled,
      "FEATURE_DISABLED",
      `${id} is disabled on this device`,
    );
  }
  async createWorkspace(userId: string, name: string, id?: string) {
    const node = await this.db.core.createWorkspace(name, id, userId);
    const { projectWorkspace } = await import("./projection");
    await projectWorkspace(this.db, node);
    return node.replica.workspaceId;
  }
  async mutate(
    actor: Principal,
    mutation: Mutation,
    source: "service" | "plugin" = "service",
  ) {
    await this.membership(actor, true);
    const schema = getSchema(mutation.collection);
    invariant(
      schema.pluginId === mutation.pluginId,
      "UNDECLARED_COLLECTION",
      "Wrong collection owner",
    );
    await this.requirePlugin(actor, schema.pluginId);
    if (source === "plugin")
      invariant(
        ![
          "devices",
          "jobs",
          "workflow_runs",
          "mailboxes",
          "github_issues",
        ].includes(schema.id),
        "PERMISSION_DENIED",
        "Use the owning service to change this collection",
      );
    const hash = createHash("sha256")
      .update(JSON.stringify(mutation))
      .digest("hex");
    const prior = await this.db.query<{
      request_hash: string;
      result: ResourceRecord;
    }>(
      "SELECT request_hash,result FROM taskasaur.mutations WHERE workspace_id=$1 AND user_id=$2 AND id=$3",
      [actor.workspaceId, actor.userId, mutation.id],
    );
    if (prior.rows[0]) {
      invariant(
        prior.rows[0].request_hash === hash,
        "IDEMPOTENCY_CONFLICT",
        "Mutation ID was reused",
      );
      return prior.rows[0].result;
    }
    const node = nodeFor(this.db, actor.workspaceId);
    let data = mutation.data;
    if (mutation.operation === "put")
      await (
        await import("./plugin-runtime")
      ).pluginMutation("beforeMutation", {
        repo: this,
        principal: actor,
        mutation,
        data,
        schema,
      });
    let record: ResourceRecord;
    if (mutation.operation === "delete") {
      await node.records.delete(mutation.resourceId, mutation.id);
      record = node.records.get(mutation.resourceId)!;
    } else
      record = await node.records.put(schema.id, data, mutation.resourceId, {
        ownerId: actor.userId,
        eventId: mutation.id,
        ...(["tables", "variables", "credentials", "files"].includes(
          schema.id,
        ) &&
        !isRequiredCore(actor.pluginId) &&
        actor.pluginId !== "core"
          ? { managedBy: actor.pluginId }
          : {}),
      });
    await projectRecord(this.db, record);
    await (
      await import("./plugin-runtime")
    ).pluginMutation("afterMutation", {
      repo: this,
      principal: actor,
      mutation,
      data,
      schema,
      record,
    });
    await this.db.query(
      "INSERT INTO taskasaur.mutations(workspace_id,user_id,id,request_hash,result) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
      [
        actor.workspaceId,
        actor.userId,
        mutation.id,
        hash,
        JSON.stringify(record),
      ],
    );
    const event = node.replica.read("event/" + mutation.id);
    await this.db.query(
      "INSERT INTO taskasaur.plugin_events(id,workspace_id,actor_id,event) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO NOTHING",
      [mutation.id, actor.workspaceId, actor.userId, JSON.stringify(event)],
    );
    return record;
  }
}
