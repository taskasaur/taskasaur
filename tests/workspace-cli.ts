import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import { DeviceCore } from "../packages/core/device";
import { FileStorage } from "../packages/platform-node/storage";
import { NodeWorkspaceFiles } from "../packages/platform-node/workspace-files";
import { WorkspaceStorage } from "../packages/storage/workspace";
import {
  exportWorkspace,
  workspaceSnapshot,
  openWorkspaceArchive,
} from "../packages/core/workspace-package";
import { snapshotStorage } from "../packages/storage";
const directory = await mkdtemp(join(tmpdir(), "taskasaur-workspace-cli-"));
const command = promisify(execFile),
  entry = resolve("dist-peer/main.js");
const run = (args: string[]) =>
  command(process.execPath, [entry, ...args], { timeout: 60000 });
let processUnderTest: ReturnType<typeof spawn> | undefined;
try {
  const ownerPath = join(directory, "owner"),
    otherPath = join(directory, "other"),
    folder = join(directory, "workspace");
  const owner = await DeviceCore.open(
    snapshotStorage(new FileStorage(join(ownerPath, "replicas"))),
    "Owner",
  );
  const node = await owner.createWorkspace("CLI workspace");
  await node.records.put("variables", {
    name: "Persisted",
    value_type: "text",
    value: "Before CLI",
  });
  const snapshot = await workspaceSnapshot(node),
    files = await NodeWorkspaceFiles.open(folder);
  await WorkspaceStorage.create(files, snapshot.workspace, snapshot.entries);
  await files.close();
  const archive = join(directory, "original.taskasaur");
  const { writeFile } = await import("node:fs/promises");
  await writeFile(archive, await exportWorkspace(node));
  const id = node.replica.workspaceId;
  await owner.close();
  const request = join(directory, "request.json"),
    invitation = join(directory, "invitation.json");
  await run(["--data", otherPath, "--pairing-request", "--output", request]);
  await run([
    "--data",
    ownerPath,
    "--approve",
    request,
    "--workspace-id",
    id,
    "--output",
    invitation,
  ]);
  await run([
    "--data",
    otherPath,
    "--import-workspace",
    archive,
    "--join",
    invitation,
  ]);
  const exported = join(directory, "roundtrip.taskasaur");
  await run([
    "--data",
    otherPath,
    "--workspace-folder",
    folder,
    "--export-workspace",
    exported,
  ]);
  const restored = await openWorkspaceArchive(
    new Uint8Array(await readFile(exported)),
  );
  assert.equal(restored.manifest.workspace.id, id);
  assert.equal(restored.manifest.workspace.policies.length, 2);
  assert(
    Object.keys(restored.manifest.entries).every(
      (k) => !k.includes("/local/") && !k.includes("identity"),
    ),
  );
  processUnderTest = spawn(
    process.execPath,
    [
      entry,
      "--data",
      otherPath,
      "--workspace-folder",
      folder,
      "--no-ui",
      "--port",
      "0",
      "--peer-port",
      "0",
    ],
    {
      env: { ...process.env, TASKASAUR_STORAGE_ONLY: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  await new Promise<void>((resolve, reject) => {
    let output = "",
      error = "";
    const timeout = setTimeout(
      () => reject(Error("Headless folder startup timed out: " + error)),
      45000,
    );
    processUnderTest!.stderr!.on("data", (chunk) => {
      error += chunk;
    });
    processUnderTest!.stdout!.on("data", (chunk) => {
      output += chunk;
      if (output.includes('"workspaces"')) {
        clearTimeout(timeout);
        resolve();
      }
    });
    processUnderTest!.once("exit", (code) => {
      clearTimeout(timeout);
      reject(Error("Headless folder exited " + code + ": " + error));
    });
  });
  const exited = new Promise<void>((resolve) =>
    processUnderTest!.once("exit", () => resolve()),
  );
  processUnderTest.kill("SIGTERM");
  await exited;
  processUnderTest = undefined;
  const reopened = await NodeWorkspaceFiles.open(folder);
  await reopened.close();
  console.log(
    "Compiled CLI approval, import, live-folder export, headless startup and graceful writer-lock release passed.",
  );
} finally {
  processUnderTest?.kill("SIGTERM");
  await rm(directory, { recursive: true, force: true });
}
