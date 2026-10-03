import release from "../../plugins/core/release.json";
import { coreServices, manifestById, requiredCoreIds } from "./catalog";
import { invariant } from "./errors";
export function verifyCoreRelease() {
  invariant(
    release.platformApi === "1.0.0" && release.fieldSchemaApi === "1.0.0",
    "CORE_RELEASE_INCOMPATIBLE",
    "Core release API versions are incompatible",
  );
  invariant(
    release.providers.length === requiredCoreIds.length,
    "CORE_DEPENDENCY_UNAVAILABLE",
    "The core release is incomplete",
  );
  for (const id of requiredCoreIds) {
    const descriptor = release.providers.find((p) => p.manifest.id === id),
      manifest = manifestById.get(id);
    invariant(
      descriptor &&
        manifest &&
        descriptor.manifest.version === manifest.version &&
        JSON.stringify(descriptor.services) ===
          JSON.stringify(coreServices[id]),
      "CORE_DEPENDENCY_UNAVAILABLE",
      `Required provider ${id} is missing or incompatible; restore the matching platform release`,
    );
  }
  return release;
}
