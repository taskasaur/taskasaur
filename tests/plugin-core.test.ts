import { it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import path from "node:path";
import os from "node:os";
import { coreModules } from "@taskasaur/platform/core/modules";
it("builds one portable plugin module and runs it through declared core imports", async () => {
  const folder = await mkdtemp(
    path.join(os.tmpdir(), "taskasaur-plugin-core-"),
  );
  try {
    await mkdir(path.join(folder, "src"));
    await writeFile(
      path.join(folder, "plugin.json"),
      JSON.stringify({
        id: "portable-example",
        version: "1.0.0",
        entrypoints: { core: "core.mjs" },
      }),
    );
    await writeFile(path.join(folder, "schemas.json"), "[]");
    await writeFile(path.join(folder, "LICENSE"), "MIT");
    await writeFile(
      path.join(folder, "src/core.ts"),
      `import {field,decodeField} from '@taskasaur/platform/field-types';export default {async activate(context:any){const value=decodeField(field('count','Count','integer'),42);await context.services.require('core.settings').set('answer',value);return ()=>context.services.require('core.settings').set('disposed',true);}};`,
    );
    const builder = pathToFileURL(
      path.resolve("packages/platform/scripts/build-plugin.mjs"),
    ).href;
    await promisify(execFile)(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import {buildPlugin} from ${JSON.stringify(builder)};await buildPlugin();`,
      ],
      { cwd: folder },
    );
    const values = new Map(),
      services = {
        require: (name: string) =>
          name === "core.modules"
            ? coreModules
            : {
                set: async (key: string, value: unknown) =>
                  values.set(key, value),
              },
      };
    const module = await import(
      /* @vite-ignore */ pathToFileURL(path.join(folder, "dist/core.mjs")).href
    );
    const dispose = await module.default.activate({ services });
    expect(values.get("answer")).toBe(42);
    await dispose();
    expect(values.get("disposed")).toBe(true);
    expect(
      await readFile(path.join(folder, "dist/core.mjs"), "utf8"),
    ).not.toContain("node:");
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
