import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { packPlugin } from "../../server/plugin-packages";
import { TestClient } from "./client";

// The signing key exists only in this process. Only the signed archive and
// public trust key enter the container's temporary directory.
const directory = await mkdtemp(
  path.join(tmpdir(), "taskasaur-container-plugin-"),
);
const inside = "/tmp/taskasaur-fixture-" + crypto.randomUUID();
const compose = (...args: string[]) =>
  execFileSync("docker", ["compose", ...args], { stdio: "pipe" });
try {
  const keys = generateKeyPairSync("ed25519");
  const manifest = JSON.parse(
    await readFile("examples/plugins/notes/plugin.json", "utf8"),
  );
  await writeFile(
    path.join(directory, "plugin.zip"),
    await packPlugin(
      "examples/plugins/notes",
      keys.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    ),
    { mode: 0o644 },
  );
  await writeFile(
    path.join(directory, "trust.json"),
    JSON.stringify({
      example: keys.publicKey
        .export({ format: "pem", type: "spki" })
        .toString(),
    }),
    { mode: 0o644 },
  );
  compose("exec", "-T", "app", "mkdir", inside);
  compose("cp", path.join(directory, "plugin.zip"), `app:${inside}/plugin.zip`);
  compose("cp", path.join(directory, "trust.json"), `app:${inside}/trust.json`);
  compose(
    "exec",
    "-T",
    "app",
    "node",
    "--import",
    "tsx",
    "scripts/plugins.ts",
    "install",
    inside + "/plugin.zip",
    inside + "/trust.json",
    ...new Set<string>([
      ...manifest.permissions,
      ...manifest.sharedServices.map((s: { id: string }) => s.id),
      ...manifest.consumes.commands,
      ...manifest.consumes.events,
    ]),
  );
  const client = await new TestClient().setup();
  await client.enable("example.notes");
  await client.put("example.notes", "example_notes_entries", {
    title: "Installed into the running image",
  });
  const rpc = {
    context: { workspaceId: client.workspaceId, pluginId: "example.notes" },
    request: {
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "example.notes.count",
      params: {},
    },
  };
  assert.equal((await client.request("rpc", rpc)).result.count, 1);
  await client.request("plugins", { id: "example.notes", action: "disable" });
  await assert.rejects(() => client.request("rpc", rpc));
  await client.request("plugins", { id: "example.notes", action: "enable" });
  assert.equal((await client.request("rpc", rpc)).result.count, 1);
  console.log(
    "Signed plugin installed into the running image; core commands, disable and re-enable passed.",
  );
} finally {
  compose("exec", "-T", "app", "rm", "-rf", inside);
  await rm(directory, { recursive: true, force: true });
}
