import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
const provenance = JSON.parse(
  await readFile("vendor/platform-source.json", "utf8"),
);
const pkg = JSON.parse(await readFile("package.json", "utf8"));
const artifact = pkg.dependencies["@taskasaur/platform"].replace(/^file:/, "");
if (artifact !== `vendor/${provenance.filename}`)
  throw Error("SDK dependency differs from provenance");
if (
  createHash("sha256")
    .update(await readFile(artifact))
    .digest("hex") !== provenance.sha256
)
  throw Error("SDK artifact checksum differs from provenance");
console.log("Pinned platform SDK checksum verified.");
