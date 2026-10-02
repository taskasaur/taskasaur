import { spawn } from "node:child_process";
const args = process.argv.includes("--dev") ? [] : ["build"];
const child = spawn(
  process.execPath,
  ["node_modules/vite/bin/vite.js", ...args, "--config", "vite.config.ts"],
  { stdio: "inherit", env: { ...process.env, TASKASAUR_NATIVE: "desktop" } },
);
child.on("exit", (code) => process.exit(code ?? 1));
