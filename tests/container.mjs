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
async function start(serveUi, workspaces = 1) {
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
    "TASKASAUR_SERVE_UI=1",
    "-e",
    `TASKASAUR_MODE=${serveUi ? "peer" : "server"}`,
    "-e",
    `TASKASAUR_STORAGE_ONLY=${serveUi ? 0 : 1}`,
    image,
  );
  const port = docker("port", name, "8080/tcp").split(":").at(-1);
  const url = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      const response = await fetch(url + "/api/health");
      if (response.ok) {
        const health = await response.json();
        assert.equal(health.workspaces, workspaces);
        assert.equal(health.mode, serveUi ? "peer" : "server");
        assert.equal(health.ui, serveUi);
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
  const empty = await start(false, 0);
  assert.equal((await fetch(empty)).status, 404);
  assert.equal(
    docker(
      "exec",
      name,
      "node",
      "-e",
      "console.log(require('node:fs').existsSync('/data/plugin-projection'))",
    ),
    "false",
  );
  docker("stop", "-t", "40", name);
  docker("rm", name);
  const first = await start(true);
  assert.equal((await fetch(first)).status, 200);
  assert.match(
    docker(
      "exec",
      name,
      "node",
      "-e",
      `
    const pty = require('node-pty');
    const terminal = pty.spawn('/bin/sh', ['-c', 'printf taskasaur-container-pty'], {name:'xterm', cols:80, rows:24, env:process.env});
    let output = '';
    const timer = setTimeout(() => {terminal.kill(); process.exit(1)}, 10000);
    terminal.onData(data => output += data);
    terminal.onExit(({exitCode}) => {clearTimeout(timer); console.log(output); process.exit(exitCode)});
  `,
    ),
    /taskasaur-container-pty/,
  );
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
    "Container replacement preserves its identity/workspace volume; native Linux PTY, GUI-disabled mode and health checks passed.",
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
