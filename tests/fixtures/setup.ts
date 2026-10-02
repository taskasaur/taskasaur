import fixtures from "./contracts.json";
import { registerExtension } from "@taskasaur/platform/core/catalog";
for (const fixture of fixtures)
  registerExtension(fixture.manifest, fixture.schemas);
