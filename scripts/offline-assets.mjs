import { readFile, writeFile, readdir, cp } from "node:fs/promises";
import { createHash } from "node:crypto";
const manifest = JSON.parse(await readFile("dist/.vite/manifest.json", "utf8"));
const files = new Set(),
  visited = new Set();
files.add("/THIRD_PARTY_NOTICES.txt");
for (const name of [
  "office-editor.html",
  "office-bridge.js",
  "office-thread.js",
  "office-release.json",
])
  files.add("/" + name);
for (const name of await readdir("public/office-templates"))
  files.add("/office-templates/" + name);
await cp(
  process.env.OFFICE_ASSET_PATH ?? ".taskasaur/office-engine/zeta",
  "dist/office-engine",
  { recursive: true },
);
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
// Lazy editors, peer transports and TypeScript workers must cold-start offline too.
for (const file of await readdir("dist/assets"))
  if (!file.endsWith(".map")) files.add("/assets/" + file);
const hash = createHash("sha256").update(await readFile("dist/index.html"));
for (const filename of [...files].sort())
  hash.update(filename).update(await readFile("dist" + filename));
const version = hash.digest("hex").slice(0, 16);
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
