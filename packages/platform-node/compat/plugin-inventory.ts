import {
  boundedDownload,
  defaultInventoryUrl,
  readInventory,
  type PluginInventory,
} from "@taskasaur/platform/plugin-sdk/inventory";
import { verifyArtifact } from "@taskasaur/platform/plugin-sdk/artifact";
import { invariant } from "@taskasaur/platform/core/errors";
import {
  installedPackages,
  installPackage,
  pluginRoot,
} from "./plugin-packages";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Database } from "./database";
let cached:
  { url: string; expires: number; value: PluginInventory } | undefined;
export async function availablePlugins(force = false) {
  const url = process.env.PLUGIN_INVENTORY_URL || defaultInventoryUrl;
  if (!force && cached?.url === url && cached.expires > Date.now())
    return cached.value;
  const value = await readInventory(url, {
    allowHttp: process.env.PLUGIN_ALLOW_HTTP === "1",
  });
  cached = { url, value, expires: Date.now() + 60000 };
  return value;
}
export async function installInventoryPlugin(
  input: { id: string; version: string; sha256: string; grants: string[] },
  db?: Database,
) {
  const inventory = await availablePlugins(true),
    entry = inventory.plugins.find((p) => p.id === input.id);
  invariant(
    entry,
    "PLUGIN_NOT_FOUND",
    "Plugin is not in the configured inventory",
  );
  invariant(
    entry.version === input.version && entry.sha256 === input.sha256,
    "INVENTORY_CHANGED",
    "The plugin release changed; review it again",
  );
  invariant(
    entry.grants.every((g) => input.grants.includes(g)),
    "PERMISSION_DENIED",
    "Review and grant the required plugin capabilities",
  );
  const installed = (await installedPackages())[entry.id];
  const alreadyDownloaded = installed?.digest === entry.sha256;
  const bytes = alreadyDownloaded
    ? await readFile(
        path.join(
          pluginRoot(),
          entry.id,
          entry.version + "-" + entry.sha256.slice(0, 16),
          "artifact.zip",
        ),
      )
    : await boundedDownload(entry.downloadUrl, 50 * 1024 * 1024, {
        allowHttp: process.env.PLUGIN_ALLOW_HTTP === "1",
      });
  await verifyArtifact(bytes, inventory.publishers, entry);
  if (
    alreadyDownloaded &&
    input.grants.every((grant) => installed.grants.includes(grant))
  )
    return { id: entry.id, version: entry.version, digest: entry.sha256 };
  return installPackage(
    Buffer.from(bytes),
    inventory.publishers,
    input.grants,
    db,
  );
}
