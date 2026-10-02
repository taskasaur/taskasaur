import { createHash, randomUUID } from "node:crypto";
import { Repository } from "./repository";
import type { Principal, ResourceRecord } from "../packages/plugin-sdk";
import type { Value } from "../packages/field-types";
import { reminderTimes } from "../packages/core/calendar-values";
import { CoreError, invariant } from "../packages/core/errors";
export function stableUuid(key: string) {
  const hash = createHash("sha256").update(key).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
export async function createOnce(
  repo: Repository,
  principal: Principal,
  collection: string,
  pluginId: string,
  key: string,
  data: Record<string, Value>,
) {
  const id = stableUuid(principal.workspaceId + ":" + key);
  return repo.db.transaction(async (tx) => {
    await tx.query(
      "SELECT id FROM taskasaur.workspaces WHERE id=$1 FOR UPDATE",
      [principal.workspaceId],
    );
    const store = new Repository(tx),
      existing = await tx.query(
        "SELECT id FROM taskasaur.resources WHERE id=$1",
        [id],
      );
    if (existing.rows.length) return;
    return store.mutate(principal, {
      id: randomUUID(),
      resourceId: id,
      collection,
      pluginId,
      operation: "put",
      baseRevision: 0,
      createdAt: new Date().toISOString(),
      data,
    });
  });
}
export async function processSchedules(
  repo: Repository,
  workspaceId: string,
  now = Date.now(),
) {
  const rows = await repo.db.query<{
    id: string;
    owner_id: string;
    collection: string;
    created_at: Date;
    through: Date | null;
  }>(
    "SELECT r.id,r.owner_id,r.collection,r.created_at,c.through FROM taskasaur.resources r JOIN taskasaur.plugins p ON p.workspace_id=r.workspace_id AND p.id=r.plugin_id AND p.enabled LEFT JOIN taskasaur.scheduler_cursors c ON c.resource_id=r.id WHERE r.workspace_id=$1 AND r.deleted_at IS NULL AND r.collection IN ('reminders','time')",
    [workspaceId],
  );
  for (const row of rows.rows) {
    const actor: Principal = {
      workspaceId,
      userId: row.owner_id,
      pluginId: row.collection,
      permissions: [],
    };
    try {
      const record = await repo.get(actor, row.id);
      if (row.collection === "time") {
        if (
          record.data.ended_at ||
          record.data.paused_at ||
          !record.data.target_seconds
        )
          continue;
        const due =
          Date.parse(String(record.data.started_at)) +
          Number(record.data.paused_ms ?? 0) +
          Number(record.data.target_seconds) * 1000;
        if (due > now) continue;
        await repo.db.transaction(async (tx) => {
          await tx.query(
            "SELECT id FROM taskasaur.workspaces WHERE id=$1 FOR UPDATE",
            [workspaceId],
          );
          const store = new Repository(tx),
            fresh = await store.get(actor, row.id);
          if (fresh.data.ended_at || fresh.data.paused_at) return;
          await store.mutate(actor, {
            id: randomUUID(),
            resourceId: row.id,
            pluginId: "time",
            collection: "time",
            operation: "put",
            baseRevision: fresh.revision,
            createdAt: new Date(now).toISOString(),
            data: { ...fresh.data, ended_at: new Date(due).toISOString() },
          });
          await createOnce(
            store,
            actor,
            "notifications",
            "notifications",
            `timer:${row.id}`,
            {
              title:
                fresh.data.kind === "break"
                  ? "Break finished"
                  : "Focus session finished",
              body: String(fresh.data.title),
              resource_id: row.id,
              dedupe_key: `timer:${row.id}`,
            },
          );
        });
        continue;
      }
      const parent = record.data.parent_id
        ? await repo.get(actor, String(record.data.parent_id))
        : undefined;
      const from = Math.max(
        row.through
          ? new Date(row.through).getTime() + 1
          : new Date(row.created_at).getTime() - 86400000,
        now - 7 * 86400000,
      );
      const times = reminderTimes(record.data, parent?.data, from, now);
      for (const time of times) {
        const key = `reminder:${record.id}:${time}`;
        if (record.data.action === "EMAIL") {
          invariant(
            record.data.mail_account_id,
            "CONFIGURATION_REQUIRED",
            "Email alarms need a sending mail account",
          );
          await repo.requirePlugin(actor, "email-client");
          await createOnce(repo, actor, "mail", "email-client", key, {
            account_id: record.data.mail_account_id,
            to: (record.data.attendees as string[]).map((v) =>
              v.replace(/^mailto:/i, ""),
            ),
            subject: record.data.summary,
            body: record.data.description,
            status: "queued",
            send_operation_id: stableUuid(workspaceId + ":" + key + ":send"),
          });
        } else
          await createOnce(repo, actor, "notifications", "notifications", key, {
            title: String(
              record.data.summary || record.data.description || "Reminder",
            ),
            body: String(record.data.description ?? ""),
            resource_id: record.id,
            dedupe_key: key,
            sound: record.data.action === "AUDIO",
          });
      }
      await repo.db.query(
        "INSERT INTO taskasaur.scheduler_cursors(resource_id,through,error) VALUES($1,$2,NULL) ON CONFLICT(resource_id) DO UPDATE SET through=EXCLUDED.through,error=NULL",
        [row.id, new Date(now).toISOString()],
      );
    } catch (error) {
      // A bad configuration affects this schedule, not unrelated timers and jobs.
      await repo.db.query(
        "INSERT INTO taskasaur.scheduler_cursors(resource_id,error) VALUES($1,$2) ON CONFLICT(resource_id) DO UPDATE SET error=EXCLUDED.error",
        [
          row.id,
          error instanceof CoreError
            ? `${error.kind}: ${error.message}`
            : "Schedule failed",
        ],
      );
    }
  }
}
