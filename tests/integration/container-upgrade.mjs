import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, unlink } from "node:fs/promises";
import path from "node:path";

const base = process.env.TEST_APP_URL ?? "http://localhost:3000";
const filename = path.resolve(".taskasaur/tests/container-upgrade.json");
let fixture;
const cookies = new Map();
async function request(route, body) {
  const url = new URL("/api/" + route, base);
  if (fixture?.workspaceId)
    url.searchParams.set("workspaceId", fixture.workspaceId);
  const response = await fetch(url, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: [...cookies].map(([k, v]) => k + "=" + v).join("; "),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  for (const cookie of response.headers.getSetCookie()) {
    const pair = cookie.split(";")[0],
      at = pair.indexOf("=");
    cookies.set(pair.slice(0, at), pair.slice(at + 1));
  }
  const result = await response.json();
  assert(
    response.ok && !result.error,
    result.error?.message ?? "Deployment request failed",
  );
  return result;
}
const mode = process.argv[2];
assert(
  ["prepare", "verify"].includes(mode),
  "Use prepare before replacing app/worker, then verify",
);
if (mode === "prepare") {
  fixture = {
    email: `upgrade-${crypto.randomUUID()}@example.com`,
    password: crypto.randomUUID() + "aA1!",
  };
  await request("auth/signup", {
    email: fixture.email,
    password: fixture.password,
  });
  fixture.workspaceId = (
    await request("workspaces", { name: "Container upgrade fixture" })
  ).id;
  await request("plugins", { id: "tasks", action: "install" });
  await request("plugins", { id: "tasks", action: "enable" });
  fixture.mutation = {
    id: crypto.randomUUID(),
    resourceId: crypto.randomUUID(),
    pluginId: "tasks",
    collection: "tasks",
    operation: "put",
    baseRevision: 0,
    data: { title: "Retained across image replacement" },
    createdAt: new Date().toISOString(),
  };
  fixture.rpc = {
    context: { workspaceId: fixture.workspaceId, pluginId: "tasks" },
    request: {
      jsonrpc: "2.0",
      id: fixture.mutation.id,
      method: "tasks.put",
      params: fixture.mutation,
    },
  };
  fixture.record = (await request("rpc", fixture.rpc)).result;
  const extension = (await request("plugins/packages")).find(
    (p) => p.manifest.id === "example.notes",
  );
  if (extension) {
    fixture.extensionDigest = extension.digest;
    await request("plugins", { id: "example.notes", action: "install" });
    await request("plugins", { id: "example.notes", action: "enable" });
    const mutation = {
      ...fixture.mutation,
      id: crypto.randomUUID(),
      resourceId: crypto.randomUUID(),
      pluginId: "example.notes",
      collection: "example_notes_entries",
      data: { title: "Plugin retained across image replacement" },
    };
    fixture.extensionRecord = (
      await request("rpc", {
        context: {
          workspaceId: fixture.workspaceId,
          pluginId: "example.notes",
        },
        request: {
          jsonrpc: "2.0",
          id: mutation.id,
          method: "example_notes_entries.put",
          params: mutation,
        },
      })
    ).result;
  }
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  await writeFile(filename, JSON.stringify(fixture), {
    flag: "wx",
    mode: 0o600,
  });
  console.log(
    "Created private upgrade fixture; replace app/worker before verification.",
  );
} else {
  fixture = JSON.parse(await readFile(filename, "utf8"));
  await request("auth/login", {
    email: fixture.email,
    password: fixture.password,
  });
  const records = (await request("sync?cursor=0")).records;
  const retained = records.find((r) => r.id === fixture.record.id);
  assert.deepEqual(
    retained,
    fixture.record,
    "Saved record changed during image replacement",
  );
  const inventory = await request("plugins");
  assert(
    inventory.some((p) => p.state.id === "tasks" && p.state.enabled),
    "Plugin state did not survive replacement",
  );
  assert.deepEqual(
    (await request("rpc", fixture.rpc)).result,
    fixture.record,
    "Mutation retry did not retain its original receipt",
  );
  if (fixture.extensionDigest) {
    const extension = (await request("plugins/packages")).find(
      (p) => p.manifest.id === "example.notes",
    );
    assert.equal(
      extension?.digest,
      fixture.extensionDigest,
      "Installed package changed or disappeared",
    );
    assert.deepEqual(
      records.find((r) => r.id === fixture.extensionRecord.id),
      fixture.extensionRecord,
      "Plugin record was not preserved",
    );
    const result = await request("rpc", {
      context: { workspaceId: fixture.workspaceId, pluginId: "example.notes" },
      request: {
        jsonrpc: "2.0",
        id: crypto.randomUUID(),
        method: "example.notes.count",
        params: {},
      },
    });
    assert.equal(
      result.result.count,
      1,
      "Plugin command did not load after replacement",
    );
  }
  await unlink(filename);
  console.log(
    "Accounts, records, plugin state and mutation receipts survive app/worker replacement.",
  );
}
