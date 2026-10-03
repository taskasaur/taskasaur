import type { Database } from "./database";
import type { WorkspaceNode } from "../../core/device";
import type { ResourceRecord } from "@taskasaur/platform/plugin-sdk";
import { schemaById } from "@taskasaur/platform/core/catalog";
import { sqlIdentifier } from "@taskasaur/platform/field-types";
import { encodeSqlField } from "./field-codecs";
import { currentPolicy } from "../../core/identity";
import { seedCorePlugins } from "./schema";
export async function projectRecord(db: Database, record: ResourceRecord) {
  const schema = schemaById.get(record.collection);
  if (!schema || (record.schemaVersion ?? 1) > schema.version) return;
  await db.query(
    "INSERT INTO taskasaur.resources(id,workspace_id,owner_id,plugin_id,collection,revision,created_at,updated_at,deleted_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(id) DO UPDATE SET revision=EXCLUDED.revision,updated_at=EXCLUDED.updated_at,deleted_at=EXCLUDED.deleted_at",
    [
      record.id,
      record.workspaceId,
      record.ownerId,
      record.pluginId,
      record.collection,
      record.revision,
      record.createdAt,
      record.updatedAt,
      record.deletedAt,
    ],
  );
  const names = schema.fields.map((f) => sqlIdentifier(f.id)),
    values = schema.fields.map((f) => encodeSqlField(f, record.data[f.id]));
  await db.query(
    `INSERT INTO taskasaur.${sqlIdentifier("p_" + schema.id)}(id,${names.join(",")}) VALUES($1,${values.map((_, i) => "$" + (i + 2)).join(",")}) ON CONFLICT(id) DO UPDATE SET ${names.map((n) => `${n}=EXCLUDED.${n}`).join(",")}`,
    [record.id, ...values],
  );
}
export async function projectWorkspace(db: Database, node: WorkspaceNode) {
  const policy = currentPolicy(node.replica.access);
  await db.transaction(async (tx) => {
    await tx.query(
      "INSERT INTO taskasaur.workspaces(id,owner_id,name) VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name",
      [policy.workspaceId, policy.members[policy.owner.id].userId, policy.name],
    );
    await tx.query("DELETE FROM taskasaur.memberships WHERE workspace_id=$1", [
      policy.workspaceId,
    ]);
    const roles = new Map<string, string>();
    for (const m of Object.values(policy.members)) {
      if (
        roles.get(m.userId) !== "owner" &&
        (roles.get(m.userId) !== "editor" || m.role === "owner")
      )
        roles.set(m.userId, m.role);
    }
    for (const [userId, role] of roles)
      await tx.query(
        "INSERT INTO taskasaur.memberships(workspace_id,user_id,role) VALUES($1,$2,$3)",
        [policy.workspaceId, userId, role],
      );
    await seedCorePlugins(tx, policy.workspaceId);
    // A policy update can quarantine formerly projected records. A projection is
    // disposable and must never retain data the authoritative replica rejected.
    const visible = node.records
      .all()
      .filter((record) => {
        const schema = schemaById.get(record.collection);
        return schema && (record.schemaVersion ?? 1) <= schema.version;
      })
      .map((record) => record.id);
    await tx.query(
      "DELETE FROM taskasaur.resources WHERE workspace_id=$1 AND NOT(id=ANY($2::uuid[]))",
      [policy.workspaceId, visible],
    );
    for (const record of node.records.all()) await projectRecord(tx, record);
  });
}
