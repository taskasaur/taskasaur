import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  packPlugin,
  installPackage,
  loadPackageCatalog,
} from "../../server/plugin-packages";
import { database, closeDatabase } from "../../server/database";
import { Repository } from "../../server/repository";
import { processBackground } from "../../server/background";
import { TestClient } from "./client";
process.loadEnvFile(".env");
process.env.DATABASE_URL = `postgres://postgres:${encodeURIComponent(process.env.POSTGRES_PASSWORD!)}@127.0.0.1:58532/postgres`;
const keys = generateKeyPairSync("ed25519"),
  privateKey = keys.privateKey
    .export({ format: "pem", type: "pkcs8" })
    .toString(),
  publicKey = keys.publicKey.export({ format: "pem", type: "spki" }).toString();
try {
  const manifest = JSON.parse(
    await readFile("examples/plugins/notes/plugin.json", "utf8"),
  );
  const grants = [
    ...manifest.permissions,
    ...manifest.sharedServices.map((s: { id: string }) => s.id),
    ...manifest.consumes.commands,
    ...manifest.consumes.events,
  ];
  await installPackage(
    await packPlugin("examples/plugins/notes", privateKey),
    { example: publicKey },
    grants,
    database(),
  );
  const client = await new TestClient().setup();
  await client.enable("example.notes");
  const note = await client.put("example.notes", "example_notes_entries", {
    title: "Independently installed",
    body: "Verified package",
  });
  const result = await client.request("rpc", {
    context: { workspaceId: client.workspaceId, pluginId: "example.notes" },
    request: {
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "example.notes.count",
      params: {},
    },
  });
  assert.equal(result.result.count, 1);
  const job = await client.request("jobs", {
    pluginId: "example.notes",
    command: "example.notes.count",
    input: {},
    operationId: crypto.randomUUID(),
  });
  await processBackground(new Repository(database()));
  const jobs = await client.request("jobs");
  assert.equal(
    jobs.find((r: any) => r.id === job.id)?.data.status,
    "completed",
  );
  const receipts = await database().query(
    "SELECT r.delivered_at FROM taskasaur.event_receipts r JOIN taskasaur.plugin_events e ON e.id=r.event_id WHERE e.workspace_id=$1 AND e.event->>'subject'=$2 AND r.plugin_id=$3",
    [client.workspaceId, note.id, "example.notes"],
  );
  assert(receipts.rows.some((r) => r.delivered_at));
  await client.request("plugins", { id: "example.notes", action: "disable" });
  const url = new URL("/api/plugins/source", client.base);
  url.searchParams.set("workspaceId", client.workspaceId);
  url.searchParams.set("id", "example.notes");
  await assert.rejects(() => client.request("plugins/source?id=example.notes"));
  console.log(
    "Signed package, dynamic server command, durable job, event receipt, and disable checks passed",
  );
} finally {
  await closeDatabase();
}
