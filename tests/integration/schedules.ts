import assert from "node:assert/strict";
import { database, closeDatabase } from "../../server/database";
import { Repository } from "../../server/repository";
import { migrate } from "../../server/schema";
import { processSchedules } from "../../server/schedules";
import { TestClient } from "./client";
process.loadEnvFile(".env");
process.env.DATABASE_URL = `postgres://postgres:${encodeURIComponent(process.env.POSTGRES_PASSWORD!)}@127.0.0.1:58532/postgres`;
try {
  await migrate(database());
  const client = await new TestClient().setup();
  for (const id of ["calendar", "reminders", "time"]) await client.enable(id);
  const now = Date.now(),
    parent = await client.put("calendar", "calendar", {
      uid: crypto.randomUUID(),
      dtstamp: new Date(now).toISOString(),
      dtstart: new Date(now + 60000).toISOString().replace(/\.\d+Z$/, "Z"),
    });
  const reminder = await client.put("reminders", "reminders", {
    action: "DISPLAY",
    trigger: "-PT2M",
    description: "Relative alarm",
    parent_id: parent.id,
    repeat: 1,
    duration: "PT10S",
  });
  const timer = await client.put("time", "time", {
    title: "Background focus",
    started_at: new Date(now - 60000).toISOString(),
    target_seconds: 30,
    kind: "focus",
  });
  const repo = new Repository(database()),
    actor = {
      workspaceId: client.workspaceId,
      userId: client.userId,
      pluginId: "records",
      permissions: [],
    };
  await processSchedules(repo, client.workspaceId, now);
  await processSchedules(repo, client.workspaceId, now + 1000);
  const notifications = await repo.list(actor, "notifications");
  assert.equal(
    notifications.filter((r) => r.data.resource_id === reminder.id).length,
    2,
  );
  assert.equal(
    notifications.filter((r) => r.data.resource_id === timer.id).length,
    1,
  );
  assert.equal(
    (await repo.get(actor, timer.id)).data.ended_at,
    new Date(now - 30000)
      .toISOString()
      .replace(/\.000Z$/, "+00:00")
      .replace(/Z$/, "+00:00"),
  );
  const errors = await database().query(
    "SELECT error FROM taskasaur.scheduler_cursors c JOIN taskasaur.resources r ON r.id=c.resource_id WHERE r.workspace_id=$1 AND c.error IS NOT NULL",
    [client.workspaceId],
  );
  assert.equal(errors.rows.length, 0);
  console.log(
    "Relative/repeated alarms, duplicate suppression and focus completion with the client absent passed",
  );
} finally {
  await closeDatabase();
}
