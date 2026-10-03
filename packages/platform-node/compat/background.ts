import { randomUUID } from "node:crypto";
import { executionForResource, executionActive } from "../../core/execution";
import type { Repository } from "./repository";
import { JobService } from "./jobs";
import { routerFor } from "./api";
import { serverPluginHost } from "./plugin-host";
import { loadPackageCatalog } from "./plugin-packages";
import { CoreError, invariant } from "@taskasaur/platform/core/errors";
import type { PluginEvent, Principal } from "@taskasaur/platform/plugin-sdk";
const workerId = randomUUID();
export async function processBackground(repo: Repository) {
  const jobs = new JobService(repo);
  for (let count = 0; count < 10; count++) {
    const job = await jobs.claim(workerId);
    if (!job) break;
    const router = await routerFor(repo, job.actor),
      host = await serverPluginHost(repo, job.actor, router);
    let failure: unknown;
    const controller = new AbortController(),
      timeout = setTimeout(() => controller.abort(), 90000);
    try {
      const response = await Promise.race([
        router.receive(
          {
            jsonrpc: "2.0",
            id: job.payload.operationId,
            method: job.payload.command,
            params: job.payload.input,
          },
          {
            principal: {
              ...job.actor,
              permissions: [
                ...job.actor.permissions,
                router.permissionFor(job.payload.command) ??
                  job.payload.command,
              ],
            },
            signal: controller.signal,
            mutationId: job.payload.operationId,
          },
        ),
        new Promise<never>((_, reject) =>
          controller.signal.addEventListener(
            "abort",
            () =>
              reject(
                new CoreError(
                  "COMMAND_TIMEOUT",
                  "Job timed out; retry uses the same operation ID",
                ),
              ),
            { once: true },
          ),
        ),
      ]);
      if (response?.error)
        throw new CoreError(
          (response.error.data as { kind?: string })?.kind ?? "COMMAND_FAILED",
          response.error.message,
        );
    } catch (error) {
      failure = error;
    } finally {
      clearTimeout(timeout);
      await host.close();
    }
    await jobs.settle(job, failure);
  }
  const packages = await loadPackageCatalog();
  for (const entry of packages) {
    if (
      !entry.manifest.entrypoints.server ||
      !entry.manifest.consumes.events.length
    )
      continue;
    const types = entry.manifest.consumes.events.map(
      (name) => `taskasaur.${name}.v1`,
    );
    const events = await repo.db.query<{
      id: string;
      workspace_id: string;
      actor_id: string;
      event: PluginEvent;
    }>(
      `SELECT e.* FROM taskasaur.plugin_events e JOIN taskasaur.plugins p ON p.workspace_id=e.workspace_id AND p.id=$1 AND p.enabled LEFT JOIN taskasaur.event_receipts r ON r.event_id=e.id AND r.plugin_id=$1 WHERE e.event->>'type'=ANY($2::text[]) AND (r.event_id IS NULL OR r.delivered_at IS NULL AND r.attempt<5 AND r.next_attempt_at<=now()) ORDER BY e.sequence LIMIT 20`,
      [entry.manifest.id, types],
    );
    for (const row of events.rows) {
      const node = repo.db.core.workspaces.get(row.workspace_id)!;
      const execution = executionForResource(
        node,
        entry.manifest.id,
        row.event.data.resourceId,
      );
      if (
        !execution ||
        !(await executionActive(node, execution.record, execution.slot))
      )
        continue;
      const claimed = await repo.db.query<{ attempt: number }>(
        `INSERT INTO taskasaur.event_receipts(event_id,plugin_id,attempt,next_attempt_at) VALUES($1,$2,1,now()+interval '2 minutes') ON CONFLICT(event_id,plugin_id) DO UPDATE SET attempt=taskasaur.event_receipts.attempt+1,next_attempt_at=now()+interval '2 minutes' WHERE taskasaur.event_receipts.delivered_at IS NULL AND taskasaur.event_receipts.attempt<5 AND taskasaur.event_receipts.next_attempt_at<=now() RETURNING attempt`,
        [row.id, entry.manifest.id],
      );
      if (!claimed.rows.length) continue;
      const actor: Principal = {
        userId: row.actor_id,
        workspaceId: row.workspace_id,
        pluginId: entry.manifest.id,
        permissions: entry.manifest.permissions,
      };
      let host: Awaited<ReturnType<typeof serverPluginHost>> | undefined;
      try {
        await repo.authorize(actor, row.event.data.resourceId);
        host = await serverPluginHost(
          repo,
          actor,
          await routerFor(repo, actor),
        );
        invariant(
          host.subscribers(row.event).includes(entry.manifest.id),
          "MISSING_HANDLER",
          "Declared event subscription has no registered handler",
        );
        const controller = new AbortController(),
          timer = setTimeout(() => controller.abort(), 30000);
        try {
          await Promise.race([
            host.deliver(row.event, entry.manifest.id),
            new Promise<never>((_, reject) =>
              controller.signal.addEventListener(
                "abort",
                () => reject(new Error("Event handler timeout")),
                { once: true },
              ),
            ),
          ]);
        } finally {
          clearTimeout(timer);
        }
        await repo.db.query(
          "UPDATE taskasaur.event_receipts SET delivered_at=now() WHERE event_id=$1 AND plugin_id=$2 AND attempt=$3",
          [row.id, entry.manifest.id, claimed.rows[0].attempt],
        );
      } catch (error) {
        const denied =
          error instanceof CoreError &&
          ["PERMISSION_DENIED", "FEATURE_DISABLED"].includes(error.kind);
        await repo.db.query(
          `UPDATE taskasaur.event_receipts SET attempt=CASE WHEN $4 THEN 5 ELSE attempt END,next_attempt_at=now()+interval '1 second'*$3 WHERE event_id=$1 AND plugin_id=$2`,
          [
            row.id,
            entry.manifest.id,
            Math.min(3600, 2 ** claimed.rows[0].attempt * 10),
            denied,
          ],
        );
      } finally {
        await host?.close();
      }
    }
  }
}
