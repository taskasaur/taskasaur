import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
const manifest = JSON.parse(await readFile("dist/.vite/manifest.json", "utf8"));
const files = new Set(),
  visited = new Set();
function include(key) {
  if (visited.has(key)) return;
  visited.add(key);
  const entry = manifest[key];
  if (!entry) throw Error(`Missing Vite entry ${key}`);
  for (const file of [
    entry.file,
    ...(entry.css ?? []),
    ...(entry.assets ?? []),
  ])
    files.add("/" + file);
  for (const dependency of entry.imports ?? []) include(dependency);
}
for (const [key, entry] of Object.entries(manifest))
  if (entry.isEntry) include(key);
const version = createHash("sha256")
  .update(await readFile("dist/index.html"))
  .digest("hex")
  .slice(0, 16);
await writeFile(
  "dist/offline-assets.json",
  JSON.stringify({ version, files: [...files].sort() }),
);
await writeFile(
  "dist/sw.js",
  (await readFile("deploy/pwa/service-worker.js", "utf8")).replace(
    "__TASKASAUR_BUILD__",
    version,
  ),
);
console.log(`Offline shell prepared with ${files.size} initial assets.`);
