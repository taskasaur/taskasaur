import { spawn, spawnSync } from "node:child_process";
delete process.env.ELECTRON_RUN_AS_NODE;
if (!process.argv.includes("--dev")) {
  const notices = spawnSync(
    process.execPath,
    ["scripts/third-party-notices.mjs"],
    {
      stdio: "inherit",
    },
  );
  if (notices.status !== 0) process.exit(notices.status ?? 1);
  const office = spawnSync(process.execPath, ["scripts/office-prepare.mjs"], {
    stdio: "inherit",
  });
  if (office.status !== 0) process.exit(office.status ?? 1);
}
const args = process.argv.includes("--dev") ? [] : ["build"];
const child = spawn(
  process.execPath,
  ["node_modules/vite/bin/vite.js", ...args, "--config", "vite.config.ts"],
  { stdio: "inherit", env: { ...process.env, TASKASAUR_NATIVE: "desktop" } },
);
child.on("exit", (code) => {
  if (code === 0 && args.length)
    code = spawnSync(process.execPath, ["scripts/offline-assets.mjs"], {
      stdio: "inherit",
    }).status;
  process.exit(code ?? 1);
});
