import { PGlite } from "@electric-sql/pglite";
import { it, expect } from "vitest";
import { migrate } from "../server/schema";
import { Repository } from "../server/repository";
import type { Database } from "../server/database";
import type { Mutation } from "../packages/plugin-sdk";
import { AccessService } from "../server/access";
import { JobService } from "../server/jobs";
function adapter(pg: PGlite): Database {
  return {
    query: async (sql, values) => {
      if (!values?.length && sql.includes(";")) {
        const result = await pg.exec(sql);
        return { rows: (result.at(-1)?.rows ?? []) as never[] };
      }
      return pg.query(sql, values);
    },
    transaction: async (fn) => {
      if (typeof pg.transaction === "function")
        return pg.transaction((tx) => fn(adapter(tx as unknown as PGlite)));
      const point = "test_" + crypto.randomUUID().replaceAll("-", "");
      await pg.query("SAVEPOINT " + point);
      try {
        const result = await fn(adapter(pg));
        await pg.query("RELEASE SAVEPOINT " + point);
        return result;
      } catch (error) {
        await pg.query("ROLLBACK TO SAVEPOINT " + point);
        throw error;
      }
    },
  };
}
it("uses native PostgreSQL columns with isolation, atomic outbox, deduplication and revisions", async () => {
  const pg = new PGlite();
  const db = adapter(pg);
  await migrate(db);
  const repository = new Repository(db);
  const userId = crypto.randomUUID(),
    workspaceId = await repository.createWorkspace(userId, "Test");
  const principal = {
    userId,
    workspaceId,
    pluginId: "tasks",
    permissions: ["tasks.read", "tasks.write"],
  };
  await db.query(
    "INSERT INTO taskasaur.plugins(workspace_id,id,version,installed,enabled) VALUES($1,'tasks','1.0.0',true,true)",
    [workspaceId],
  );
  const mutation: Mutation = {
    id: crypto.randomUUID(),
    resourceId: crypto.randomUUID(),
    pluginId: "tasks",
    collection: "tasks",
    operation: "put",
    baseRevision: 0,
    data: { title: "Stored" },
    createdAt: new Date().toISOString(),
  };
  const first = await repository.mutate(principal, mutation);
  expect(first.data.title).toBe("Stored");
  expect(first.revision).toBe(1);
  expect(await repository.mutate(principal, mutation)).toEqual(first);
  await expect(
    repository.mutate(principal, { ...mutation, data: { title: "Other" } }),
  ).rejects.toMatchObject({ kind: "IDEMPOTENCY_CONFLICT" });
  await expect(
    repository.mutate(principal, {
      ...mutation,
      id: crypto.randomUUID(),
      data: { title: "Stale" },
    }),
  ).rejects.toMatchObject({ kind: "REVISION_CONFLICT" });
  await expect(
    repository.get({ ...principal, userId: crypto.randomUUID() }, first.id),
  ).rejects.toMatchObject({ kind: "PERMISSION_DENIED" });
  const pull = await repository.pull(principal, "0");
  expect(pull.records).toHaveLength(1);
  expect(pull.cursor).toBe("1");
  await expect(
    db.query("UPDATE taskasaur.p_tasks SET priority=5 WHERE id=$1", [first.id]),
  ).rejects.toThrow();
  expect((await repository.get(principal, first.id)).data.priority).toBe(0);
  const teammate = { ...principal, userId: crypto.randomUUID() };
  await db.query(
    "INSERT INTO taskasaur.memberships(workspace_id,user_id,role) VALUES($1,$2,'editor')",
    [workspaceId, teammate.userId],
  );
  const access = new AccessService(repository);
  await access.grant(principal, first.id, teammate.userId, "viewer", null);
  expect((await repository.pull(teammate, "0")).authorizedIds).toContain(
    first.id,
  );
  expect((await repository.pull(teammate, "0")).writableIds).not.toContain(
    first.id,
  );
  await expect(
    repository.authorize(teammate, first.id, true),
  ).rejects.toMatchObject({ kind: "PERMISSION_DENIED" });
  await access.grant(principal, first.id, teammate.userId, "editor", null);
  expect((await repository.pull(teammate, "0")).writableIds).toContain(
    first.id,
  );
  await access.grant(principal, first.id, teammate.userId, null, null);
  expect((await repository.pull(teammate, "0")).authorizedIds).not.toContain(
    first.id,
  );
  await expect(repository.get(teammate, first.id)).rejects.toMatchObject({
    kind: "PERMISSION_DENIED",
  });
  const jobs = new JobService(repository),
    operationId = crypto.randomUUID();
  const job = await jobs.enqueue(
    principal,
    "tasks.list",
    { query: {} },
    { operationId },
  );
  expect(
    (
      await jobs.enqueue(
        principal,
        "tasks.list",
        { query: {} },
        { operationId },
      )
    ).id,
  ).toBe(job.id);
  const claim = await jobs.claim("first-worker");
  expect(claim?.record.id).toBe(job.id);
  expect(await jobs.claim("second-worker")).toBeUndefined();
  await db.query(
    "UPDATE taskasaur.job_leases SET expires_at=now()-interval '1 minute' WHERE job_id=$1",
    [job.id],
  );
  const recovered = await jobs.claim("second-worker");
  expect(recovered?.epoch).not.toBe(claim?.epoch);
  await expect(jobs.settle(claim!)).rejects.toMatchObject({
    kind: "LEASE_EXPIRED",
  });
  await jobs.settle(recovered!);
  expect((await repository.get(principal, job.id)).data.status).toBe(
    "completed",
  );
  await pg.close();
}, 30000);
