import assert from "node:assert/strict";
import { database, closeDatabase } from "../../server/database";
import { Repository } from "../../server/repository";
import { CredentialBroker } from "../../server/credentials";
import { MailService } from "../../server/mail";
import { FileService } from "../../server/files";
import { migrate } from "../../server/schema";
import { TestClient } from "./client";
process.loadEnvFile(".env");
process.env.DATABASE_URL = `postgres://postgres:${encodeURIComponent(process.env.POSTGRES_PASSWORD!)}@127.0.0.1:58532/postgres`;
process.env.SUPABASE_URL = "http://127.0.0.1:58521";
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SERVICE_ROLE_KEY;
try {
  await migrate(database());
  const client = await new TestClient().setup();
  await client.enable("email-client");
  await client.request("plugins/features", {
    id: "email-client",
    features: ["attachments"],
  });
  const repo = new Repository(database()),
    principal = {
      userId: client.userId,
      workspaceId: client.workspaceId,
      pluginId: "email-client",
      permissions: ["email-client.read", "email-client.write"],
    };
  const broker = new CredentialBroker(
    repo,
    process.env.CREDENTIAL_ENCRYPTION_KEY!,
  );
  const credential = await client.put("credentials", "credentials", {
    name: "Mail fixture",
    provider: "imap",
    auth_kind: "password",
    allowed_plugins: ["email-client"],
    allowed_destinations: [
      "imaps://localhost:58993",
      "smtps://localhost:58325",
    ],
  });
  await broker.set(principal, credential.id, {
    username: "fixture",
    password: "fixture-only",
  });
  const account = await client.put("email-client", "mail_accounts", {
    name: "Fixture",
    address: "fixture@example.test",
    credential_id: credential.id,
    imap_host: "localhost",
    imap_port: 58993,
    smtp_host: "localhost",
    smtp_port: 58325,
  });
  const files = new FileService(repo),
    file = await client.put("files", "files", {
      name: "note.txt",
      media_type: "text/plain",
      size: "21",
    });
  await files.upload(
    principal,
    file.id,
    Buffer.from("Verified attachment.\n"),
    "text/plain",
    null,
    crypto.randomUUID(),
  );
  const marker = "Mail fixture " + crypto.randomUUID();
  const draft = await client.put("email-client", "mail", {
    account_id: account.id,
    subject: marker,
    to: ["fixture@example.test"],
    body: "Send/read/reply fixture",
    attachments: [{ file_id: file.id }],
  });
  const mail = new MailService(repo, broker),
    sent = await mail.send(principal, draft.id);
  assert.equal(sent.data.status, "sent");
  assert.equal(
    (await mail.send(principal, draft.id)).revision,
    sent.revision,
    "Retry must not send twice",
  );
  const folders = await mail.folders(principal, account.id);
  assert(folders.some((r) => r.data.path === "INBOX"));
  await mail.sync(principal, account.id);
  const received = (await repo.list(principal, "mail")).find(
    (r) => r.data.subject === marker && r.data.status === "received",
  );
  assert(received, "SMTP submission must arrive via IMAP");
  const read = await mail.read(principal, received.id);
  assert.match(String(read.data.body), /Send\/read\/reply fixture/);
  const attachment = (read.data.attachments as Array<{ file_id: string }>)[0];
  assert.equal(
    await (await files.download(principal, attachment.file_id)).text(),
    "Verified attachment.\n",
  );
  const operation = await client.put("email-client", "mail_operations", {
    message_id: received.id,
    operation: "unread",
  });
  await mail.applyOperation(principal, operation.id);
  assert.equal((await repo.get(principal, received.id)).data.read, false);
  const reply = await client.put("email-client", "mail", {
    account_id: account.id,
    subject: "Re: " + marker,
    to: ["fixture@example.test"],
    body: "Reply fixture",
    in_reply_to: sent.data.message_id,
    references: [sent.data.message_id],
  });
  await mail.send(principal, reply.id);
  await mail.sync(principal, account.id);
  const delivered = (await repo.list(principal, "mail")).find(
    (r) => r.data.subject === "Re: " + marker && r.data.status === "received",
  );
  assert(delivered);
  assert.equal(
    (await mail.read(principal, delivered.id)).data.in_reply_to,
    sent.data.message_id,
  );
  await broker.revoke(principal, credential.id);
  await assert.rejects(() => mail.sync(principal, account.id), {
    kind: "CREDENTIAL_UNAVAILABLE",
  });
  console.log(
    "TLS SMTP/IMAP, folders, MIME attachments through Files, reply threading, unread operation, send deduplication and credential revocation passed",
  );
} finally {
  await closeDatabase();
}
