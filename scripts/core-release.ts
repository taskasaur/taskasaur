import { writeFile, mkdir, readFile } from "node:fs/promises";
import {
  catalog,
  coreServices,
  requiredCoreIds,
} from "../packages/core/catalog";
const expected = {
  platformApi: "1.0.0",
  fieldSchemaApi: "1.0.0",
  providers: requiredCoreIds.map((id) => ({
    manifest: catalog.find((p) => p.id === id)!,
    services: coreServices[id],
  })),
};
const filename = "plugins/core/release.json";
if (process.argv.includes("--write")) {
  await mkdir("plugins/core", { recursive: true });
  await writeFile(filename, JSON.stringify(expected, null, 2) + "\n");
} else if (
  JSON.stringify(JSON.parse(await readFile(filename, "utf8"))) !==
  JSON.stringify(expected)
)
  throw new Error(
    "Core release inventory differs from implemented contracts; review and regenerate it with --write",
  );
console.log("Required core release inventory verified");
