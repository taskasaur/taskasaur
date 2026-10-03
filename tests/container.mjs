import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";

const image = process.env.TASKASAUR_IMAGE ?? "taskasaur-peer:verified";
const name = `taskasaur-persistence-${process.pid}`;
const volume = `${name}-data`;
const docker = (...args) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
async function start(serveUi) {
  docker(
    "run",
    "-d",
    "--name",
    name,
    "--hostname",
    "persistence-test",
    "--mount",
    `type=volume,source=${volume},target=/data`,
    "-p",
    "127.0.0.1::8080",
    "-e",
    `TASKASAUR_SERVE_UI=${serveUi ? 1 : 0}`,
    image,
  );
  const port = docker("port", name, "8080/tcp").split(":").at(-1);
  const url = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      const response = await fetch(url + "/api/health");
      if (response.ok) {
        assert.equal((await response.json()).workspaces, 1);
        return url;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw Error("Container health check timed out");
}
function fingerprint() {
  // Return only hashes. Private identity material never leaves the test container.
  return docker(
    "exec",
    name,
    "node",
    "-e",
    `
    const fs = require('node:fs'), crypto = require('node:crypto');
    console.log(JSON.stringify(['device/identity', 'device/workspaces'].map(key =>
      crypto.createHash('sha256').update(fs.readFileSync('/data/replicas/' + Buffer.from(key).toString('base64url'))).digest('hex'))));
  `,
  );
}
try {
  docker("volume", "create", volume);
  const first = await start(true);
  assert.equal((await fetch(first)).status, 200);
  const original = fingerprint();
  docker("stop", "-t", "40", name);
  docker("rm", name);
  const replacement = await start(false);
  assert.equal((await fetch(replacement)).status, 404);
  assert.equal(
    fingerprint(),
    original,
    "Replacement lost the device identity or workspace",
  );
  console.log(
    "Container replacement preserves its identity/workspace volume; GUI-disabled mode and health checks passed.",
  );
} catch (error) {
  try {
    console.error(docker("logs", "--tail", "25", name));
  } catch {}
  throw error;
} finally {
  try {
    docker("rm", "-f", name);
  } catch {}
  try {
    docker("volume", "rm", volume);
  } catch {}
}
