import type { Repository } from "./repository";
import type { Principal, PluginEvent } from "@taskasaur/platform/plugin-sdk";
import { manifestById } from "@taskasaur/platform/core/catalog";
import { invariant, CoreError } from "@taskasaur/platform/core/errors";
import { domainEvent } from "@taskasaur/platform/core/messages";
export async function publishEvent(
  repo: Repository,
  actor: Principal,
  event: PluginEvent,
) {
  const name = event.type.replace(/^taskasaur\./, "").replace(/\.v1$/, "");
  invariant(
    manifestById.get(actor.pluginId)?.provides.events.includes(name),
    "UNDECLARED_EVENT",
    "Event is not declared by this plugin",
  );
  await repo.requirePlugin(actor, actor.pluginId);
  await repo.authorize(actor, event.data.resourceId);
  invariant(
    event.id.length <= 200 &&
      Number.isInteger(event.data.revision) &&
      event.data.revision >= 0,
    "VALIDATION_FAILED",
    "Invalid event identity",
  );
  const envelope = domainEvent(
    actor,
    name,
    event.data.resourceId,
    event.data.revision,
    event.data.value,
    event.id,
  );
  invariant(
    JSON.stringify(envelope).length <= 262144,
    "PAYLOAD_TOO_LARGE",
    "Event exceeds 256 KB",
  );
  await repo.db.transaction(async (tx) => {
    // Use the record outbox's workspace lock so cursors cannot skip a late commit.
    await tx.query(
      "SELECT id FROM taskasaur.workspaces WHERE id=$1 FOR UPDATE",
      [actor.workspaceId],
    );
    const inserted = await tx.query(
      "INSERT INTO taskasaur.plugin_events(id,workspace_id,actor_id,event) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO NOTHING RETURNING id",
      [event.id, actor.workspaceId, actor.userId, JSON.stringify(envelope)],
    );
    if (!inserted.rows.length) {
      const same = await tx.query(
        "SELECT id FROM taskasaur.plugin_events WHERE id=$1 AND workspace_id=$2 AND actor_id=$3 AND event->>'type'=$4 AND event->'data'=$5::jsonb",
        [
          event.id,
          actor.workspaceId,
          actor.userId,
          envelope.type,
          JSON.stringify(envelope.data),
        ],
      );
      invariant(
        same.rows.length,
        "IDEMPOTENCY_CONFLICT",
        "Event identity was already used for different data",
      );
    }
  });
  await repo.db.core.workspaces
    .get(actor.workspaceId)!
    .replica.update(
      "event/" + event.id,
      envelope as unknown as Record<string, unknown>,
    );
}
export async function pullEvents(
  repo: Repository,
  actor: Principal,
  cursor: string,
) {
  invariant(/^\d+$/.test(cursor), "VALIDATION_FAILED", "Invalid event cursor");
  await repo.membership(actor);
  const rows = (
      await repo.db.query<{ sequence: string; event: PluginEvent }>(
        "SELECT sequence,event FROM taskasaur.plugin_events WHERE workspace_id=$1 AND sequence>$2 ORDER BY sequence LIMIT 100",
        [actor.workspaceId, cursor],
      )
    ).rows,
    events: PluginEvent[] = [];
  for (const row of rows) {
    try {
      await repo.authorize(actor, row.event.data.resourceId);
      events.push(row.event);
    } catch (error) {
      if (!(
        error instanceof CoreError &&
        ["PERMISSION_DENIED", "NOT_FOUND"].includes(error.kind)
      ))
        throw error;
    }
  }
  return {
    events,
    cursor: String(rows.at(-1)?.sequence ?? cursor),
    hasMore: rows.length === 100,
  };
}
