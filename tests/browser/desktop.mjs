import { _electron as electron, expect } from "@playwright/test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import {
  createWorkspace,
  leaveWorkspace,
  navigate,
} from "./navigation-helpers.mjs";
import JSZip from "jszip";
import os from "node:os";
import path from "node:path";

const directory = await mkdtemp(
  path.join(os.tmpdir(), "taskasaur-desktop-check-"),
);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
let app;
try {
  app = await electron.launch({
    ...(process.env.TASKASAUR_DESKTOP_EXECUTABLE
      ? { executablePath: process.env.TASKASAUR_DESKTOP_EXECUTABLE }
      : {}),
    args: [
      ...(process.env.TASKASAUR_DESKTOP_EXECUTABLE ? [] : [process.cwd()]),
      `--user-data-dir=${directory}`,
    ],
    env,
  });
  const window = await app.firstWindow({ timeout: 45000 });
  await createWorkspace(window);
  await window
    .getByRole("navigation", { name: "Current page" })
    .waitFor({ timeout: 45000 });
  await navigate(window, "Files");
  await window.locator('input[type="file"]').setInputFiles({
    name: "desktop-internal.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Internal bytes"),
  });
  await expect(
    window.getByRole("button", { name: "desktop-internal.txt", exact: true }),
  ).toBeVisible();
  const liveFile = path.join(directory, "live.taskasaur");
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
  }, liveFile);
  await navigate(window, "Settings");
  await window
    .getByRole("switch", { name: "Include credentials", exact: true })
    .click();
  await window
    .getByRole("button", { name: "Save and work from file", exact: true })
    .click();
  await expect(window.getByRole("status")).toContainText("live.taskasaur");
  const fileManifest = async () => {
    const zip = await JSZip.loadAsync(await readFile(liveFile));
    return JSON.parse(await zip.file("workspace.json").async("string"));
  };
  const before = await fileManifest();
  await navigate(window, "Files");
  await window.locator('input[type="file"]').setInputFiles({
    name: "single-file.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Native single-file bytes"),
  });
  await expect
    .poll(
      async () =>
        Object.keys((await fileManifest()).entries).filter((k) =>
          k.includes("/blobs/"),
        ).length,
    )
    .toBeGreaterThan(
      Object.keys(before.entries).filter((k) => k.includes("/blobs/")).length,
    );
  await window.reload();
  await navigate(window, "Files");
  await expect(
    window.getByRole("button", { name: "single-file.txt", exact: true }),
  ).toBeVisible();
  await expect(
    window.getByRole("button", { name: "desktop-internal.txt", exact: true }),
  ).toBeVisible();
  await app.evaluate(async ({ app }) => {
    const require = process
      .getBuiltinModule("node:module")
      .createRequire(app.getAppPath() + "/package.json");
    const pty = require("node-pty");
    await new Promise((resolve, reject) => {
      const windows = process.platform === "win32";
      const terminal = pty.spawn(windows ? "powershell.exe" : "/bin/sh", [], {
        name: "xterm-color",
        cols: 80,
        rows: 24,
        env: process.env,
      });
      let output = "";
      const timeout = setTimeout(() => {
        terminal.kill();
        reject(new Error("Electron PTY did not return output"));
      }, 15000);
      terminal.onData((data) => {
        output += data;
        if (output.includes("electron-pty-ok")) {
          clearTimeout(timeout);
          terminal.kill();
          resolve(null);
        }
      });
      terminal.write(
        windows
          ? "Write-Output ('electron-' + 'pty-ok')\r"
          : "printf '%s%s\\n' 'electron-' 'pty-ok'\r",
      );
    });
  });
  const originalId = await window.evaluate(() =>
    localStorage.getItem("taskasaur.active-workspace"),
  );
  await leaveWorkspace(window);
  expect(
    await window.evaluate(async (workspaceId) => {
      try {
        await window.taskasaurNative.peer.request("local:desktop", {
          workspaceId,
        });
        return "still open";
      } catch (error) {
        return String(error);
      }
    }, originalId),
  ).toContain("This workspace is closed");
  await createWorkspace(window, "Second desktop workspace");
  await navigate(window, "Files");
  await expect(
    window.getByRole("button", { name: "single-file.txt", exact: true }),
  ).toHaveCount(0);
  await leaveWorkspace(window);
  await app.close();
  app = await electron.launch({
    ...(process.env.TASKASAUR_DESKTOP_EXECUTABLE
      ? { executablePath: process.env.TASKASAUR_DESKTOP_EXECUTABLE }
      : {}),
    args: [
      ...(process.env.TASKASAUR_DESKTOP_EXECUTABLE ? [] : [process.cwd()]),
      `--user-data-dir=${path.join(directory, "second-installation")}`,
    ],
    env,
  });
  const restored = await app.firstWindow({ timeout: 45000 });
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [file],
    });
  }, liveFile);
  await restored.getByRole("button", { name: "Open", exact: true }).click();
  await restored
    .getByRole("button", { name: "Open file workspace", exact: true })
    .click();
  await navigate(restored, "Files");
  await expect(
    restored.getByRole("button", { name: "single-file.txt", exact: true }),
  ).toBeVisible();
  expect(
    (await restored.evaluate(() => window.taskasaurNative.peer.info()))
      .workspaces,
  ).toContain(originalId);
  const encrypted = path.join(directory, "encrypted.taskasaur");
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
  }, encrypted);
  await navigate(restored, "Settings");
  await restored
    .getByRole("switch", { name: "Encrypt workspace file", exact: true })
    .click();
  await restored
    .getByLabel("New workspace password", { exact: true })
    .fill("desktop workspace password");
  await restored
    .getByRole("switch", { name: "Include credentials", exact: true })
    .click();
  await restored
    .getByRole("button", { name: "Save and work from file", exact: true })
    .click();
  await expect(restored.getByRole("status")).toContainText(
    "encrypted.taskasaur",
    { timeout: 30000 },
  );
  expect(
    (await readFile(encrypted))
      .subarray(0, "TASKASAUR-ENCRYPTED-1\n".length)
      .toString(),
  ).toBe("TASKASAUR-ENCRYPTED-1\n");
  await leaveWorkspace(restored);
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [file],
    });
  }, encrypted);
  await restored.getByRole("button", { name: "Open", exact: true }).click();
  await restored
    .getByRole("button", { name: "Open file workspace", exact: true })
    .click();
  await restored
    .getByLabel("Workspace password", { exact: true })
    .fill("desktop workspace password");
  await restored.getByRole("button", { name: "Unlock", exact: true }).click();
  await navigate(restored, "Files");
  await expect(
    restored.getByRole("button", { name: "single-file.txt", exact: true }),
  ).toBeVisible();
  console.log(
    "Electron workspace, internal storage and single-file writes/reopen, separate workspaces, new-installation credentials, encrypted reopen, native peer and PTY addon passed.",
  );
} finally {
  await app?.close();
  await rm(directory, { recursive: true, force: true });
}
