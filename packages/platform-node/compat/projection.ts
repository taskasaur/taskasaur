import type { Database } from "./database";
import type { WorkspaceNode } from "../../core/device";
import type { ResourceRecord } from "@taskasaur/platform/plugin-sdk";
import { schemaById } from "@taskasaur/platform/core/catalog";
import { sqlIdentifier } from "@taskasaur/platform/field-types";
import { encodeSqlField } from "./field-codecs";
import { currentPolicy } from "../../core/identity";
import { seedCorePlugins } from "./schema";
export async function deleteWorkspaceProjection(db: Database, id: string) {
  await db.transaction(async (tx) => {
    await tx.query(
      "DELETE FROM taskasaur.event_receipts WHERE event_id IN (SELECT id FROM taskasaur.plugin_events WHERE workspace_id=$1)",
      [id],
    );
    await tx.query(
      "DELETE FROM taskasaur.workflow_versions WHERE workflow_id IN (SELECT id FROM taskasaur.resources WHERE workspace_id=$1)",
      [id],
    );
    const tables = await tx.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname='taskasaur' AND left(tablename,2)='p_'",
    );
    const references: Array<[string, string]> = [
      ...tables.rows.map(
        ({ tablename }) => [tablename, "id"] as [string, string],
      ),
      ["grants", "resource_id"],
      ["changes", "resource_id"],
      ["secrets", "resource_id"],
      ["file_versions", "file_id"],
      ["device_keys", "device_id"],
      ["job_leases", "job_id"],
      ["scheduler_cursors", "resource_id"],
      ["workflow_triggers", "workflow_id"],
      ["workflow_hooks", "workflow_id"],
      ["workflow_signals", "run_id"],
    ];
    for (const [table, column] of references)
      await tx.query(
        `DELETE FROM taskasaur.${sqlIdentifier(table)} WHERE ${sqlIdentifier(column)} IN (SELECT id FROM taskasaur.resources WHERE workspace_id=$1)`,
        [id],
      );
    for (const table of [
      "resources",
      "memberships",
      "plugins",
      "mutations",
      "audit",
      "enrollments",
      "stream_tickets",
      "dispatches",
      "plugin_events",
      "changes",
    ])
      await tx.query(
        `DELETE FROM taskasaur.${sqlIdentifier(table)} WHERE workspace_id=$1`,
        [id],
      );
    await tx.query("DELETE FROM taskasaur.workspaces WHERE id=$1", [id]);
  });
}
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
