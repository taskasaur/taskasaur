import type { WorkspaceNode } from "./device";
import { deviceRecordId } from "./records";
import { LocalState } from "./local-state";
import { digest, utf8, canonical } from "./crypto";
import { currentPolicy } from "./identity";
import { reminderTimes } from "@taskasaur/platform/core/calendar-values";
export const operationId = async (key: string) =>
  deviceRecordId(await digest(utf8.encode(key)));
/** Foreground or headless scheduling. A workflow only runs on its explicitly selected device. */
export async function workflowTriggers(
  node: WorkspaceNode,
  start: (input: Record<string, any>) => Promise<unknown>,
  now = Date.now(),
) {
  const store = new LocalState(node.replica, "workflow-triggers"),
    target = deviceRecordId(node.replica.identity.id);
  for (const workflow of node.records
    .all()
    .filter(
      (r) =>
        r.collection === "workflows" &&
        !r.deletedAt &&
        r.data.enabled &&
        r.data.target_device_id === target &&
        Number(r.data.published_version) > 0,
    )) {
    const data = workflow.data,
      key = await digest(
        utf8.encode(
          canonical([
            data.published_version,
            data.trigger_kind,
            data.schedule_start,
            data.schedule_seconds,
            data.event_type,
            data.catch_up,
          ]),
        ),
      );
    const prior = await store.get<{
        key: string;
        slot: number;
        events: string[];
      }>(workflow.id),
      cursor =
        prior?.key === key
          ? prior
          : { key, slot: -1, events: node.replica.ids("event/") };
    if (data.trigger_kind === "schedule") {
      const interval = Number(data.schedule_seconds) * 1000,
        startAt = Date.parse(String(data.schedule_start));
      if (interval < 10000 || !Number.isFinite(startAt)) continue;
      const current = Math.floor((now - startAt) / interval);
      if (current < 0 || current <= cursor.slot) continue;
      const first =
          data.catch_up === "all"
            ? Math.max(
                cursor.slot + 1,
                current - Math.floor(604800000 / interval),
              )
            : current,
        last = Math.min(current, first + 99);
      for (let slot = first; slot <= last; slot++) {
        if (
          data.catch_up === "skip" &&
          now - (startAt + slot * interval) > 10000
        )
          continue;
        await start({
          id: workflow.id,
          targetDeviceId: target,
          operationId: await operationId(
            workflow.id + ":" + key + ":schedule:" + slot,
          ),
          input: {
            trigger: "schedule",
            scheduledAt: new Date(startAt + slot * interval).toISOString(),
          },
        });
      }
      cursor.slot = last;
    } else if (data.trigger_kind === "event") {
      for (const id of node.replica
        .ids("event/")
        .filter((id) => !cursor.events.includes(id))
        .slice(0, 100)) {
        const event = node.replica.read<{ type: string; id: string }>(id)!;
        if (event.type === data.event_type)
          await start({
            id: workflow.id,
            targetDeviceId: target,
            operationId: await operationId(
              workflow.id + ":" + key + ":event:" + event.id,
            ),
            input: { trigger: "event", event },
          });
        cursor.events.push(id);
      }
    }
    await store.set(workflow.id, cursor);
  }
}
export async function reminders(
  node: WorkspaceNode,
  enabled: (id: string) => boolean,
  now = Date.now(),
) {
  if (!enabled("reminders") || !node.records.canWrite()) return;
  const assignment = node.replica.read<{ deviceId: string }>(
    "setting/service.reminders",
  );
  if (
    (assignment?.deviceId ?? currentPolicy(node.replica.access).owner.id) !==
    node.replica.identity.id
  )
    return;
  const store = new LocalState(node.replica, "reminders");
  for (const record of node.records
    .all()
    .filter((r) => r.collection === "reminders" && !r.deletedAt)) {
    const parent = record.data.parent_id
        ? node.records.get(String(record.data.parent_id))
        : undefined,
      prior = await store.get<{ through: number }>(record.id);
    try {
      const from = Math.max(
        prior ? prior.through + 1 : Date.parse(record.createdAt) - 86400000,
        now - 604800000,
      );
      for (const time of reminderTimes(record.data, parent?.data, from, now)) {
        const key = `reminder:${record.id}:${time}`,
          id = await operationId(node.replica.workspaceId + ":" + key);
        if (node.records.get(id)) continue;
        if (record.data.action === "EMAIL") {
          if (!enabled("email-client") || !record.data.mail_account_id)
            throw Error(
              "Email alarms need an enabled email plugin and sending account",
            );
          await node.records.put(
            "mail",
            {
              account_id: record.data.mail_account_id,
              to: (record.data.attendees as string[]).map((v) =>
                v.replace(/^mailto:/i, ""),
              ),
              subject: record.data.summary,
              body: record.data.description,
              status: "queued",
              send_operation_id: await operationId(
                node.replica.workspaceId + ":" + key + ":send",
              ),
            },
            id,
            { createdAt: new Date(time).toISOString() },
          );
        } else
          await node.records.put(
            "notifications",
            {
              title: String(
                record.data.summary || record.data.description || "Reminder",
              ),
              body: String(record.data.description ?? ""),
              resource_id: record.id,
              dedupe_key: key,
              sound: record.data.action === "AUDIO",
            },
            id,
            { createdAt: new Date(time).toISOString() },
          );
      }
      await store.set(record.id, { through: now });
    } catch (error) {
      await store.set(record.id, {
        through: prior?.through ?? now - 604800000,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
