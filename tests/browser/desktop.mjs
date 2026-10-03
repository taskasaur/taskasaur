import { _electron as electron } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
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
  await window.getByRole("navigation", { name: "Workspace" }).waitFor({ timeout: 45000 });
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
  console.log("Electron workspace, native peer and PTY addon passed.");
} finally {
  await app?.close();
  await rm(directory, { recursive: true, force: true });
}
