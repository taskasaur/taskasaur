import { _electron as electron, expect } from "@playwright/test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { navigate } from "./navigation-helpers.mjs";
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
  await window
    .getByRole("button", { name: "Create workspace", exact: true })
    .click();
  await window
    .getByRole("navigation", { name: "Current page" })
    .waitFor({ timeout: 45000 });
  const folder = path.join(directory, "portable-workspace");
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [folder],
    });
  }, folder);
  await navigate(window, "Settings");
  await window
    .getByRole("button", { name: "Save and work from folder", exact: true })
    .click();
  await expect(window.getByRole("status")).toContainText(
    "Workspace writes now go directly",
  );
  await navigate(window, "Files");
  await window.locator('input[type="file"]').setInputFiles({
    name: "desktop-folder.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Native folder bytes"),
  });
  await expect(
    window.getByRole("button", { name: "desktop-folder.txt", exact: true }),
  ).toBeVisible();
  await expect
    .poll(async () =>
      Object.keys(
        JSON.parse(await readFile(path.join(folder, "workspace.json"), "utf8"))
          .entries,
      ).some((k) => k.includes("/blobs/")),
    )
    .toBe(true);
  await window.reload();
  await navigate(window, "Files");
  await expect(
    window.getByRole("button", { name: "desktop-folder.txt", exact: true }),
  ).toBeVisible();
  const liveFile = path.join(directory, "live.taskasaur");
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
  }, liveFile);
  await navigate(window, "Settings");
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
    window.getByRole("button", { name: "desktop-folder.txt", exact: true }),
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
  console.log(
    "Electron workspace, native folder and single-file writes/reopen, native peer and PTY addon passed.",
  );
} finally {
  await app?.close();
  await rm(directory, { recursive: true, force: true });
}
