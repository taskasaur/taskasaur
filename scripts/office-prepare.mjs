import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { execFileSync } from "node:child_process";
import path from "node:path";
const url =
  "https://www.collaboraoffice.com/downloads/COOL-Wasm-Nightly/cool-wasm-2026-06-30_18-26.tar";
const expected =
  "44d34343109c7771a7b295da4f76bee629422fa5977ad63d286029fdfae48e61";
const root = path.resolve(
    process.env.OFFICE_ASSET_PATH ?? ".taskasaur/office-engine/wasm",
  ),
  directory = path.dirname(root);
await mkdir(directory, { recursive: true });
const archive = process.argv[2] ?? path.join(directory, "engine.tar");
if (!process.argv[2]) {
  console.log(
    "Downloading the pinned Collabora engine (2.4 GB archive; debug files will be excluded).",
  );
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error("Engine download failed");
  await pipeline(Readable.fromWeb(response.body), createWriteStream(archive));
}
const hash = createHash("sha256");
for await (const chunk of createReadStream(archive)) hash.update(chunk);
if (hash.digest("hex") !== expected)
  throw new Error("Office engine checksum mismatch");
const entries = execFileSync("tar", ["-tf", archive], {
  encoding: "utf8",
  maxBuffer: 16 * 1024 * 1024,
}).split("\n");
if (entries.some((p) => p.startsWith("/") || p.split("/").includes("..")))
  throw new Error("Unsafe archive path");
execFileSync("tar", [
  "-xf",
  archive,
  "-C",
  directory,
  "--exclude=*.debug.wasm",
  "--exclude=*.dwp",
  "--exclude=*.map",
]);
await writeFile(
  path.join(directory, "release.json"),
  JSON.stringify(
    {
      source: url,
      sha256: expected,
      version: "2026-06-30",
      engine: "Collabora/LibreOffice",
      license: "MPL-2.0 and bundled component licenses",
    },
    null,
    2,
  ),
);
console.log(
  "Offline engine assets installed. Browser/native platform acceptance is still required.",
);
