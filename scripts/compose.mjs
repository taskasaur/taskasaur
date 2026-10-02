import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import YAML from "yaml";

const upstream = "deploy/supabase/upstream/";
const provenance = JSON.parse(
  await readFile("deploy/supabase/UPSTREAM.json", "utf8"),
);
for (const [file, expected] of Object.entries(provenance.files)) {
  const bytes = await readFile(upstream + file);
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    expected,
    `Upstream file changed: ${file}`,
  );
}
const base = YAML.parse(
  await readFile(upstream + "docker-compose.yml", "utf8"),
);
for (const service of Object.values(base.services)) {
  // Compose supplies project-scoped names, permitting isolated test and restore stacks.
  delete service.container_name;
  service.volumes = service.volumes?.map((volume) =>
    typeof volume === "string" && volume.startsWith("./")
      ? "./" + upstream + volume.slice(2)
      : volume,
  );
  if (!service.volumes) delete service.volumes;
}
function merge(base, overlay) {
  if (overlay && typeof overlay === "object" && !Array.isArray(overlay)) {
    const result = { ...base };
    for (const [key, value] of Object.entries(overlay)) {
      if (value === null) delete result[key];
      else result[key] = merge(base?.[key], value);
    }
    return result;
  }
  return overlay;
}
const result = merge(
  base,
  YAML.parse(await readFile("deploy/docker/taskasaur.yaml", "utf8")),
);
result.name = "taskasaur";
const output =
  `# Generated from official Supabase ${provenance.ref} (${provenance.commit}).\n# Edit deploy/docker/taskasaur.yaml, then run npm run compose:generate.\n` +
  YAML.stringify(result, { lineWidth: 110 });
if (process.argv.includes("--check")) {
  assert.equal(
    await readFile("compose.yaml", "utf8"),
    output,
    "Compose differs from the pinned upstream + Taskasaur overlay; regenerate it",
  );
  console.log("Supabase provenance and generated Compose match.");
} else {
  await writeFile("compose.yaml", output);
  console.log(
    "Generated Compose from the verified official Supabase bundle and Taskasaur overlay.",
  );
}
