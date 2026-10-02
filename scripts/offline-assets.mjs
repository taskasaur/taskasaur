import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
const manifest = JSON.parse(
    await readFile(".next/build-manifest.json", "utf8"),
  ),
  dynamic = JSON.parse(
    await readFile(".next/react-loadable-manifest.json", "utf8"),
  ),
  html = await readFile(".next/server/app/index.html", "utf8");
const files = new Set(
  [
    ...manifest.rootMainFiles,
    ...manifest.polyfillFiles,
    ...manifest.lowPriorityFiles,
  ].map((file) => "/_next/" + file),
);
for (const [name, entry] of Object.entries(dynamic))
  if (name.split(" -> ")[1] === "../packages/app-ui/app")
    for (const file of entry.files) files.add("/_next/" + file);
for (const match of html.matchAll(
  /(?:src|href)="(\/_next\/[^"?]+)(?:\?[^" ]*)?"/g,
))
  files.add(match[1]);
const version = (await readFile(".next/BUILD_ID", "utf8")).trim(),
  payload = JSON.stringify({ version, files: [...files].sort() });
await writeFile("public/offline-assets.json", payload);
await writeFile(
  "public/sw.js",
  (await readFile("deploy/pwa/service-worker.js", "utf8")).replace(
    "__TASKASAUR_BUILD__",
    createHash("sha256").update(payload).digest("hex").slice(0, 16),
  ),
);
console.log(
  `Offline shell prepared with ${files.size} initial assets. Feature chunks cache when opened.`,
);
