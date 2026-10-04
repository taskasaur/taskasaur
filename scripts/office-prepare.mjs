/** Install the upstream full Writer/Calc/Impress WASM build, pinned by digest. */
import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  rm,
  copyFile,
} from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import path from "node:path";
const release = JSON.parse(
  await readFile("public/office-release.json", "utf8"),
);
const root = path.resolve(
  process.env.OFFICE_ASSET_PATH ?? ".taskasaur/office-engine/zeta",
);
await mkdir(root, { recursive: true });
async function hash(file) {
  const value = createHash("sha256");
  for await (const chunk of createReadStream(file)) value.update(chunk);
  return value.digest("hex");
}
for (const asset of release.assets) {
  const target = path.join(root, asset.path);
  try {
    if ((await hash(target)) === asset.sha256) {
      console.log("Verified", asset.path);
      continue;
    }
  } catch {}
  const temp = target + ".download";
  try {
    const response = await fetch(release.baseUrl + asset.path);
    if (!response.ok || !response.body)
      throw Error("Office asset download failed: " + asset.path);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(temp));
    if ((await hash(temp)) !== asset.sha256)
      throw Error(
        "Upstream office asset changed: " +
          asset.path +
          ". Review and pin the new release before installing it.",
      );
    await rename(temp, target);
    console.log("Installed", asset.path);
  } finally {
    await rm(temp, { force: true });
  }
}
await copyFile(
  "node_modules/zetajs/source/zeta.js",
  path.join(root, "zeta.js"),
);
await copyFile(
  "node_modules/zetajs/LICENSE",
  path.join(root, "ZetaJS-LICENSE"),
);
await writeFile(
  path.join(root, "release.json"),
  JSON.stringify(release, null, 2),
);
// Retain the actual runtime's bundled license notices and source provenance beside it.
const metadata = JSON.parse(
  await readFile(path.join(root, "soffice.data.js.metadata"), "utf8"),
);
const data = await readFile(path.join(root, "soffice.data"));
const notices = metadata.files
  .filter((f) => /\/(license|notice|copying|readme)(\.|\/|$)/i.test(f.filename))
  .map(
    (f) => f.filename + "\n" + data.subarray(f.start, f.end).toString("utf8"),
  )
  .join("\n\n");
await writeFile(
  path.join(root, "ENGINE-NOTICES.txt"),
  "Source: " +
    release.source +
    "\nMPL-2.0 / LGPL-3.0+ and bundled component licenses\n\n" +
    notices,
);
console.log(
  "Full LibreOffice engine installed; npm run build:web includes it in platform bundles.",
);
