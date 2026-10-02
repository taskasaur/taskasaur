import assert from "node:assert/strict";
import { createServer } from "node:https";
import { readFile } from "node:fs/promises";
import { once } from "node:events";
import { database, closeDatabase } from "../../server/database";
import { Repository } from "../../server/repository";
import { CredentialBroker } from "../../server/credentials";
import { TestClient } from "./client";
process.loadEnvFile(".env");
process.env.DATABASE_URL = `postgres://postgres:${encodeURIComponent(process.env.POSTGRES_PASSWORD!)}@127.0.0.1:58532/postgres`;
let refreshes = 0;
const fixture = process.env.TEST_TLS_FIXTURE ?? "/tmp/taskasaur-mail-fixture";
const server = createServer(
  {
    key: await readFile(fixture + "/key.pem"),
    cert: await readFile(fixture + "/cert.pem"),
  },
  (request, response) => {
    if (request.url !== "/token" || request.method !== "POST") {
      response.writeHead(404).end();
      return;
    }
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const input = new URLSearchParams(body);
      assert.equal(input.get("grant_type"), "refresh_token");
      assert.equal(input.get("refresh_token"), "refresh-original");
      refreshes++;
      response.writeHead(200, { "Content-Type": "application/json" }).end(
        JSON.stringify({
          access_token: "refreshed-secret",
          refresh_token: "rotated-refresh",
          expires_in: 3600,
        }),
      );
    });
  },
);
server.listen(0, "127.0.0.1");
await once(server, "listening");
try {
  const address = server.address();
  assert(address && typeof address !== "string");
  const base = `https://localhost:${address.port}`;
  const client = await new TestClient().setup();
  for (const id of ["email-client", "connector-github", "tasks"])
    await client.enable(id);
  const repo = new Repository(database()),
    broker = new CredentialBroker(repo, process.env.CREDENTIAL_ENCRYPTION_KEY!),
    actor = {
      userId: client.userId,
      workspaceId: client.workspaceId,
      pluginId: "credentials",
      permissions: [],
    };
  const credential = await client.put("credentials", "credentials", {
    name: "Shared OAuth fixture",
    provider: "fixture",
    auth_kind: "oauth2",
    allowed_plugins: ["email-client", "connector-github"],
    allowed_destinations: [base + "/token", base + "/resource"],
  });
  await broker.set(actor, credential.id, {
    accessToken: "expired-secret",
    refreshToken: "refresh-original",
    expiresAt: new Date(0).toISOString(),
    clientId: "test-client",
    tokenEndpoint: base + "/token",
  });
  const values = await Promise.all(
    ["email-client", "connector-github"].map((id) =>
      broker.use(
        actor,
        credential.id,
        id,
        base + "/resource",
        "read",
        async (secret) => secret.accessToken,
      ),
    ),
  );
  assert.deepEqual(values, ["refreshed-secret", "refreshed-secret"]);
  assert.equal(refreshes, 1, "Concurrent consumers must refresh exactly once");
  await assert.rejects(
    () =>
      broker.use(
        actor,
        credential.id,
        "tasks",
        base + "/resource",
        "read",
        async () => null,
      ),
    { kind: "PERMISSION_DENIED" },
  );
  await assert.rejects(
    () =>
      broker.use(
        actor,
        credential.id,
        "email-client",
        base + "/elsewhere",
        "read",
        async () => null,
      ),
    { kind: "PERMISSION_DENIED" },
  );
  await broker.set(actor, credential.id, { apiKey: "replacement-secret" });
  assert.equal(
    await broker.use(
      actor,
      credential.id,
      "connector-github",
      base + "/resource",
      "read",
      async (secret) => secret.apiKey,
    ),
    "replacement-secret",
  );
  const stored = await database().query(
    "SELECT ciphertext FROM taskasaur.secrets WHERE resource_id=$1",
    [credential.id],
  );
  assert(!String(stored.rows[0].ciphertext).includes("replacement-secret"));
  assert(
    !JSON.stringify(await repo.pull(actor, "0")).includes("replacement-secret"),
  );
  await client.request("plugins", { id: "email-client", action: "disable" });
  assert.equal(
    await broker.use(
      actor,
      credential.id,
      "connector-github",
      base + "/resource",
      "read",
      async (secret) => secret.apiKey,
    ),
    "replacement-secret",
  );
  await broker.revoke(actor, credential.id);
  await assert.rejects(
    () =>
      broker.use(
        actor,
        credential.id,
        "connector-github",
        base + "/resource",
        "read",
        async () => null,
      ),
    { kind: "CREDENTIAL_UNAVAILABLE" },
  );
  console.log(
    "Shared credential reuse, serialized HTTPS refresh, denied consumer/destination, rotation, consumer removal, secret isolation and revocation passed",
  );
} finally {
  server.close();
  await closeDatabase();
}
