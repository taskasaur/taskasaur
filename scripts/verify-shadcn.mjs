import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
const registry = JSON.parse(
  await readFile("packages/ui/shadcn-registry.json", "utf8"),
);
for (const [file, expected] of Object.entries(registry.files)) {
  const actual = createHash("sha256")
    .update(await readFile(`packages/ui/primitives/${file}`))
    .digest("hex");
  if (actual !== expected)
    throw Error(
      `${file} differs from the official shadcn download. Keep custom compositions outside primitives, or refresh the provenance after downloading a new registry release.`,
    );
}
console.log(
  `Verified ${Object.keys(registry.files).length} unmodified shadcn components (CLI ${registry.cli}).`,
);
