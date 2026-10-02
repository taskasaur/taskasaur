import { readFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  connectNativeHost,
  pairNativeHost,
  type HostConfig,
} from "../server/native-host";
const directory =
  process.env.TASKASAUR_DEVICE_DIR ??
  path.join(os.homedir(), ".taskasaur-device");
await mkdir(directory, { recursive: true, mode: 0o700 });
const args = process.argv.slice(2);
if (args[0] === "pair") {
  const [_, server, code] = args;
  if (!server || !code)
    throw new Error(
      "Usage: npm run device -- pair <server-url> <pairing-code> [--terminal] [--automation]",
    );
  await pairNativeHost(server, code, directory, {
    terminal: args.includes("--terminal"),
    automation: args.includes("--automation"),
  });
  console.log("Device paired. Start it with npm run device -- start.");
} else if (args[0] === "start") {
  const config = JSON.parse(
    await readFile(path.join(directory, "device.json"), "utf8"),
  ) as HostConfig;
  const host = connectNativeHost(config);
  process.on("SIGINT", () => {
    host.close();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    host.close();
    process.exit(0);
  });
  console.log(
    "Device host connected; only explicitly enabled capabilities are offered.",
  );
} else throw new Error("Usage: npm run device -- pair|start");
