import "fake-indexeddb/auto";
import { it, expect } from "vitest";
import { LocalDatabase } from "../packages/data-dexie";
import { ReplicaRecords } from "../packages/core/records";
import { Replica } from "../packages/core/replica";
import { MemoryStorage } from "../packages/storage";
import { createIdentity, publicIdentity } from "../packages/core/crypto";
import {
  createWorkspaceAccess,
  approveMember,
  acceptPolicies,
} from "../packages/core/identity";
import { getSchema } from "@taskasaur/platform/core/catalog";
import { field, type Value } from "@taskasaur/platform/field-types";
import { collectionColumns } from "@taskasaur/platform/core/collection-tables";
import { pluginNavigation } from "../packages/app-ui/navigation";
import { navigationService } from "../packages/app-ui/navigation-service";
import { manifestById } from "@taskasaur/platform/core/catalog";
import { scopedTableStore } from "../packages/app-ui/collection-tables";
import { WorkspaceSearch } from "../packages/app-ui/search-index";
import type { AppRuntime } from "../packages/app-ui/runtime";

it("replicates independent plugin tables and validates custom fields on the shared write path", async () => {
  const alice = await createIdentity("Laptop"),
    bob = await createIdentity("Phone");
  let access = await createWorkspaceAccess(alice, "Tables");
  access = await approveMember(access, alice, publicIdentity(bob), "editor");
  const a = await new Replica(alice, access, new MemoryStorage()).open();
  const b = await new Replica(
    bob,
    await acceptPolicies(bob, access.policies),
    new MemoryStorage(),
  ).open();
  const records = new ReplicaRecords(a),
    schema = getSchema("tasks");
  const columns = [
    ...collectionColumns(schema),
    field("budget", "Budget", "numeric"),
  ];
  const table = await records.put(
    "tables",
    {
      name: "Work",
      collection_id: "tasks",
      columns: columns as unknown as Value,
    },
    undefined,
    { managedBy: "tasks" },
  );
  const first = await records.put("tasks", {
    table_id: table.id,
    custom_fields: { budget: "12345678901234567890.12" },
  });
  expect(first.data.uid).toBeTypeOf("string");
  expect(first.data.title).toBeNull();
  const changed = await records.put(
    "tasks",
    { ...first.data, title: "Optional title" },
    first.id,
  );
  expect(changed.data.uid).toBe(first.data.uid);
  expect(changed.data.dtstamp).toBe(first.data.dtstamp);
  await expect(
    records.put("tasks", { table_id: crypto.randomUUID() }),
  ).rejects.toMatchObject({ kind: "INVALID_TABLE" });
  await expect(
    records.put("tasks", {
      table_id: table.id,
      custom_fields: { budget: "invalid" },
    }),
  ).rejects.toThrow();
  await expect(
    records.put(
      "tables",
      {
        ...table.data,
        columns: columns.filter((f) => f.id !== "uid") as unknown as Value,
      },
      table.id,
    ),
  ).rejects.toMatchObject({ kind: "REQUIRED_COLUMN" });
  await expect(
    records.resolve(first.id, "custom_fields", { budget: "not numeric" }),
  ).rejects.toThrow();
  await expect(
    records.put(
      "tables",
      {
        ...table.data,
        columns: columns.filter((f) => f.id !== "budget") as unknown as Value,
      },
      table.id,
    ),
  ).rejects.toThrow();
  for (const change of a.entries()) await b.accept(change);
  const replica = new ReplicaRecords(b);
  expect(replica.get(table.id)?.managedBy).toBe("tasks");
  expect(replica.get(first.id)?.data.custom_fields).toEqual({
    budget: "12345678901234567890.12",
  });
  const userFile = await records.put("files", {
    name: "Shared.txt",
    media_type: "text/plain",
  });
  expect(
    (
      await records.put(
        "files",
        { ...userFile.data, name: "Updated.txt" },
        userFile.id,
        { managedBy: "tasks" },
      )
    ).managedBy,
  ).toBeUndefined();
  const managed = await records.put(
    "variables",
    { name: "cursor" },
    undefined,
    { managedBy: "tasks" },
  );
  expect(
    (
      await records.put(
        "variables",
        { ...managed.data, value: "next" },
        managed.id,
      )
    ).managedBy,
  ).toBe("tasks");
});

it("keeps the searchable cache local, redacts credentials, and removes revoked/disabled content", async () => {
  const identity = await createIdentity("Search"),
    access = await createWorkspaceAccess(identity, "Search");
  const replica = await new Replica(
      identity,
      access,
      new MemoryStorage(),
    ).open(),
    records = new ReplicaRecords(replica);
  const task = await records.put("tasks", {
    title: "Café planning",
    description: "Offline notes",
  });
  const credential = await records.put("credentials", {
    name: "Mail account",
    provider: "imap",
    allowed_destinations: ["https://private.example"],
  });
  const db = new LocalDatabase(
    replica.workspaceId,
    replica.member.userId,
    crypto.randomUUID(),
  );
  try {
    await db.records.bulkPut([
      task,
      {
        ...credential,
        data: { ...credential.data, password: "never-cache-this" },
      },
    ]);
    const versionId = crypto.randomUUID();
    const file = await records.put("files", {
      name: "Notes.txt",
      media_type: "text/plain",
      version_id: versionId,
    });
    await db.records.put(file);
    await db.fileVersions.put({
      id: versionId,
      fileId: file.id,
      blob: new Blob(["Distinctive nebula text"]),
      parentVersionId: null,
      createdAt: new Date().toISOString(),
      synced: true,
    });
    const enabled = new Set(["tasks", "credentials", "files"]);
    const runtime = {
      db,
      profile: { workspaceId: replica.workspaceId },
      registry: { enabled: (id: string) => enabled.has(id) },
      searchOptions: new Map(),
    } as unknown as AppRuntime;
    const search = new WorkspaceSearch(runtime);
    const before = replica.hashes().length;
    expect((await search.query("nebula"))[0].id).toBe(file.id);
    // A second query uses the cached extraction, and removing bytes clears it.
    expect((await search.query("nebula"))[0].id).toBe(file.id);
    await db.fileVersions.delete(versionId);
    expect(await search.query("nebula")).toEqual([]);
    expect((await search.query("cafe"))[0].id).toBe(task.id);
    expect((await search.query("offline"))[0].id).toBe(task.id);
    expect((await search.query("Mail account"))[0].id).toBe(credential.id);
    expect(await search.query("never-cache-this")).toEqual([]);
    expect(JSON.stringify(await db.searchDocuments.toArray())).not.toContain(
      "private.example",
    );
    expect(await db.outbox.count()).toBe(0);
    expect(replica.hashes()).toHaveLength(before);
    runtime.searchOptions.set("tasks", {
      collection: "tasks",
      fields: ["title"],
    });
    expect(await search.query("offline")).toEqual([]);
    enabled.delete("tasks");
    expect(await search.query("cafe")).toEqual([]);
    expect(await db.searchDocuments.get(task.id)).toBeUndefined();
    await db.reconcileAccess([]);
    expect(await db.searchDocuments.count()).toBe(0);
  } finally {
    await db.delete();
  }
});

it("registers namespaced explicit commands with availability and disposal checks", async () => {
  let enabled = true,
    calls = 0;
  const visited: string[][] = [];
  const runtime = {
    commands: new Map(),
    searchOptions: new Map(),
    registry: { enabled: () => enabled },
    notifySurfaces() {},
    navigate: async (...args: string[]) => {
      visited.push(args);
    },
  } as unknown as AppRuntime;
  const tasks = navigationService(runtime, manifestById.get("tasks")!);
  const command = {
    id: "create",
    title: "Create a task",
    page: "home",
    run: () => {
      calls++;
    },
  };
  const remove = tasks.registerCommand(command);
  expect(calls).toBe(0);
  expect(() => tasks.registerCommand(command)).toThrow();
  const run = runtime.commands.get("tasks:create")!.run;
  await run();
  expect(visited).toEqual([["tasks", "home"]]);
  expect(calls).toBe(1);
  enabled = false;
  await expect(run()).rejects.toMatchObject({ kind: "FEATURE_DISABLED" });
  enabled = true;
  remove();
  await expect(run()).rejects.toMatchObject({ kind: "FEATURE_DISABLED" });
  expect(calls).toBe(1);
  expect(() => tasks.configureSearch({ collection: "credentials" })).toThrow();
  const reset = tasks.configureSearch({
    collection: "tasks",
    fields: ["title"],
  });
  expect(runtime.searchOptions.get("tasks")?.fields).toEqual(["title"]);
  reset();
  expect(runtime.searchOptions.size).toBe(0);
});

it("applies query limits within the selected table, preserving existing row membership on edits", async () => {
  const db = new LocalDatabase(
    crypto.randomUUID(),
    crypto.randomUUID(),
    crypto.randomUUID(),
  );
  try {
    const now = new Date().toISOString();
    const envelope = {
      workspaceId: db.workspaceId,
      ownerId: db.userId,
      createdAt: now,
      updatedAt: now,
      revision: 1,
      deletedAt: null,
    };
    const table = {
      ...envelope,
      id: crypto.randomUUID(),
      pluginId: "tables",
      collection: "tables",
      data: { collection_id: "tasks", is_default: true },
    };
    const another = crypto.randomUUID();
    const rows = [another, table.id, table.id].map((tableId) => ({
      ...envelope,
      id: crypto.randomUUID(),
      pluginId: "tasks",
      collection: "tasks",
      data: { table_id: tableId },
    }));
    await db.records.bulkPut([table, ...rows]);
    const writes: unknown[] = [];
    const runtime = { db } as unknown as AppRuntime;
    const source = {
      list: async (_query?: unknown) => rows,
      put: async (data: unknown, _id?: string) => {
        writes.push(data);
        return rows[0];
      },
    };
    const store = scopedTableStore(runtime, "tasks", source);
    expect(await store.list({ limit: 1 } as never)).toEqual([rows[1]]);
    await store.put({ title: "Updated" }, rows[0].id);
    expect(writes).toMatchObject([{ table_id: another }]);
  } finally {
    await db.delete();
  }
});

it("preserves a plugin's collection-only main page and its read-only contract", () => {
  const base = manifestById.get("tasks")!;
  const manifest = {
    ...base,
    ui: {
      ...base.ui,
      mainPage: "overview",
      pages: [
        {
          id: "overview",
          label: "Overview",
          collection: "tasks",
          readOnly: true,
        },
      ],
    },
  };
  const runtime = {
    surfaces: new Map(),
    registry: {
      manifests: new Map([["tasks", manifest]]),
      states: new Map([["tasks", { installed: true }]]),
      enabled: () => true,
    },
  } as unknown as AppRuntime;
  const entry = pluginNavigation(runtime).find((p) => p.id === "tasks")!;
  expect(entry.main).toMatchObject({
    id: "overview",
    collection: "tasks",
    readOnly: true,
  });
  expect(entry.pages.some((p) => p.columns && p.collection === "tasks")).toBe(
    true,
  );
});
