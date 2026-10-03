import { deviceRecordId } from "../../core/records";
import { randomUUID } from "node:crypto";
import { Repository } from "./repository";
import { manifestById } from "@taskasaur/platform/core/catalog";
import { invariant, CoreError } from "@taskasaur/platform/core/errors";
import type { Principal, ResourceRecord } from "@taskasaur/platform/plugin-sdk";
import type { Value } from "@taskasaur/platform/field-types";
import { operationUuid } from "./runner-dispatch";
type JobPayload = {
  pluginId: string;
  command: string;
  input: Value;
  operationId: string;
  intervalSeconds?: number;
};
export type ClaimedJob = {
  record: ResourceRecord;
  actor: Principal;
  owner: string;
  epoch: string;
  payload: JobPayload;
};
export class JobService {
  constructor(private repo: Repository) {}
  async enqueue(
    actor: Principal,
    command: string,
    input: Value,
    options: {
      operationId?: string;
      dueAt?: string;
      intervalSeconds?: number;
    } = {},
  ) {
    const manifest = manifestById.get(actor.pluginId);
    invariant(
      manifest &&
        (manifest.provides.commands.includes(command) ||
          manifest.consumes.commands.includes(command)),
      "UNDECLARED_COMMAND",
      "Jobs must use a declared command",
    );
    await this.repo.requirePlugin(actor, actor.pluginId);
    invariant(
      JSON.stringify(input).length <= 262144,
      "PAYLOAD_TOO_LARGE",
      "Job input exceeds 256 KB",
    );
    invariant(
      !options.intervalSeconds ||
        (Number.isInteger(options.intervalSeconds) &&
          options.intervalSeconds >= 60),
      "VALIDATION_FAILED",
      "Schedules must be at least 60 seconds apart",
    );
    const operationId = options.operationId ?? randomUUID(),
      id = operationUuid(
        `${actor.workspaceId}:${actor.userId}:${actor.pluginId}:${operationId}`,
      );
    const payload: JobPayload = {
      pluginId: actor.pluginId,
      command,
      input,
      operationId,
      ...(options.intervalSeconds
        ? { intervalSeconds: options.intervalSeconds }
        : {}),
    };
    return this.repo.db.transaction(async (tx) => {
      const record = await new Repository(tx).mutate(actor, {
        id: operationUuid(id + ":enqueue"),
        resourceId: id,
        pluginId: "jobs",
        collection: "jobs",
        operation: "put",
        baseRevision: 0,
        createdAt: new Date(0).toISOString(),
        data: {
          kind: command,
          target_device_id: deviceRecordId(this.repo.db.core.identity.id),
          payload: payload as unknown as Value,
          run_at: options.dueAt ?? new Date(0).toISOString(),
        },
      });
      await tx.query(
        "INSERT INTO taskasaur.job_leases(job_id) VALUES($1) ON CONFLICT DO NOTHING",
        [id],
      );
      return record;
    });
  }
  async cancel(actor: Principal, id: string) {
    const record = await this.repo.get(actor, id);
    invariant(
      record.collection === "jobs",
      "VALIDATION_FAILED",
      "Expected a job",
    );
    await this.repo.mutate(actor, {
      id: randomUUID(),
      resourceId: id,
      pluginId: "jobs",
      collection: "jobs",
      operation: "put",
      baseRevision: record.revision,
      createdAt: new Date().toISOString(),
      data: { ...record.data, status: "cancelled" },
    });
  }
  async claim(owner: string): Promise<ClaimedJob | undefined> {
    const candidates = await this.repo.db.query<{
      id: string;
      workspace_id: string;
      owner_id: string;
    }>(
      `SELECT r.id,r.workspace_id,r.owner_id FROM taskasaur.resources r JOIN taskasaur.p_jobs j ON j.id=r.id JOIN taskasaur.job_leases l ON l.job_id=r.id JOIN taskasaur.plugins p ON p.workspace_id=r.workspace_id AND p.id=j.payload->>'pluginId' AND p.enabled WHERE r.deleted_at IS NULL AND j.status IN('queued','running','waiting') AND COALESCE(j.run_at,now())<=now() AND (l.expires_at IS NULL OR l.expires_at<now()) ORDER BY j.run_at LIMIT 20`,
    );
    for (const row of candidates.rows) {
      const candidate = await this.repo.get(
        {
          workspaceId: row.workspace_id,
          userId: row.owner_id,
          pluginId: "jobs",
          permissions: [],
        },
        row.id,
      );
      if (
        candidate.data.target_device_id !==
        deviceRecordId(this.repo.db.core.identity.id)
      )
        continue;
      const node=this.repo.db.core.workspaces.get(row.workspace_id)!,plugin=String((candidate.data.payload as unknown as JobPayload).pluginId);
      if(node.replica.read('setting/service.'+plugin)&&!await (await import('../../core/services')).assignedService(node,plugin))continue;
      const result = await this.repo.db.transaction(async (tx) => {
        await tx.query(
          "SELECT id FROM taskasaur.workspaces WHERE id=$1 FOR UPDATE",
          [row.workspace_id],
        );
        const lease = (
          await tx.query<{ epoch: string }>(
            "SELECT epoch FROM taskasaur.job_leases WHERE job_id=$1 AND (expires_at IS NULL OR expires_at<now()) FOR UPDATE SKIP LOCKED",
            [row.id],
          )
        ).rows[0];
        if (!lease) return;
        const repository = new Repository(tx),
          actor = {
            userId: row.owner_id,
            workspaceId: row.workspace_id,
            pluginId: "jobs",
            permissions: [],
          },
          record = await repository.get(actor, row.id);
        if (
          !["queued", "running", "waiting"].includes(String(record.data.status))
        )
          return;
        const payload = record.data.payload as unknown as JobPayload,
          manifest = manifestById.get(payload.pluginId);
        invariant(manifest, "PLUGIN_NOT_FOUND", "Job provider is missing");
        actor.pluginId = payload.pluginId;
        actor.permissions = manifest.permissions as never[];
        await repository.membership(actor, true);
        const epoch = (
          await tx.query<{ epoch: string }>(
            "UPDATE taskasaur.job_leases SET owner=$2,epoch=epoch+1,expires_at=now()+interval '2 minutes' WHERE job_id=$1 RETURNING epoch",
            [row.id, owner],
          )
        ).rows[0].epoch;
        const current = await repository.mutate(actor, {
          id: randomUUID(),
          resourceId: record.id,
          pluginId: "jobs",
          collection: "jobs",
          operation: "put",
          baseRevision: record.revision,
          createdAt: new Date().toISOString(),
          data: {
            ...record.data,
            status: "running",
            attempt: Number(record.data.attempt) + 1,
            error: null,
          },
        });
        return { record: current, actor, owner, epoch, payload };
      });
      if (result) return result;
    }
  }
  async settle(job: ClaimedJob, error?: unknown) {
    await this.repo.db.transaction(async (tx) => {
      await tx.query(
        "SELECT id FROM taskasaur.workspaces WHERE id=$1 FOR UPDATE",
        [job.actor.workspaceId],
      );
      const lease = (
        await tx.query<{ epoch: string; owner: string }>(
          "SELECT epoch,owner FROM taskasaur.job_leases WHERE job_id=$1 AND expires_at>now() FOR UPDATE",
          [job.record.id],
        )
      ).rows[0];
      invariant(
        lease &&
          String(lease.epoch) === String(job.epoch) &&
          lease.owner === job.owner,
        "LEASE_EXPIRED",
        "Job lease expired",
      );
      const repository = new Repository(tx),
        current = await repository.get(job.actor, job.record.id);
      if (current.data.status === "cancelled") {
        await tx.query(
          "UPDATE taskasaur.job_leases SET expires_at=NULL,owner=NULL WHERE job_id=$1",
          [current.id],
        );
        return;
      }
      const attempt = Number(current.data.attempt),
        retry =
          error &&
          attempt < 5 &&
          !(
            error instanceof CoreError &&
            [
              "PERMISSION_DENIED",
              "SMTP_AMBIGUOUS",
              "SMTP_OUTCOME_UNKNOWN",
              "INVALID_MAIL_STATE",
              "MAILBOX_CHANGED",
              "MAIL_MOVE_FAILED",
              "VALIDATION_FAILED",
              "UNDECLARED_COMMAND",
            ].includes(error.kind)
          );
      const status = error
        ? retry
          ? "waiting"
          : "failed"
        : job.payload.intervalSeconds
          ? "queued"
          : "completed";
      const runAt = retry
        ? new Date(
            Date.now() + Math.min(3600, 2 ** attempt * 5) * 1000,
          ).toISOString()
        : job.payload.intervalSeconds
          ? new Date(
              Date.now() + job.payload.intervalSeconds * 1000,
            ).toISOString()
          : current.data.run_at;
      const payload = {
        ...job.payload,
        ...(!error && job.payload.intervalSeconds
          ? { operationId: randomUUID() }
          : {}),
      };
      await repository.mutate(job.actor, {
        id: randomUUID(),
        resourceId: current.id,
        pluginId: "jobs",
        collection: "jobs",
        operation: "put",
        baseRevision: current.revision,
        createdAt: new Date().toISOString(),
        data: {
          ...current.data,
          status,
          run_at: runAt,
          error:
            error instanceof CoreError
              ? `${error.kind}: ${error.message}`
              : error
                ? "Command failed"
                : null,
          attempt: !error && job.payload.intervalSeconds ? 0 : attempt,
          payload: payload as unknown as Value,
        },
      });
      await tx.query(
        "UPDATE taskasaur.job_leases SET expires_at=NULL,owner=NULL WHERE job_id=$1",
        [current.id],
      );
    });
  }
}
