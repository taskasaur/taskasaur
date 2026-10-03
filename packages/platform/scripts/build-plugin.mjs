import { build } from "esbuild";
import {
  readFile,
  writeFile,
  mkdir,
  rm,
  copyFile,
  readdir,
} from "node:fs/promises";
import path from "node:path";
export async function buildPlugin() {
  const notices = new Map();
  const manifest = JSON.parse(await readFile("plugin.json", "utf8"));
  await rm("dist", { recursive: true, force: true });
  await mkdir("dist");
  for (const name of ["plugin.json", "schemas.json", "LICENSE"])
    await copyFile(name, path.join("dist", name));
  for (const [runtime, file] of Object.entries(manifest.entrypoints)) {
    const browser = runtime === "browser";
    const result = await build({
      entryPoints: [`src/${runtime}.tsx`].map((p) =>
        browser ? p : p.replace(/\.tsx$/, ".ts"),
      ),
      outfile: `dist/${file}`,
      bundle: true,
      metafile: true,
      write: false,
      format: "cjs",
      platform: browser ? "browser" : "node",
      target: "es2022",
      jsx: "automatic",
      minify: browser,
      external: [
        "@taskasaur/*",
        ...(browser
          ? [
              "react",
              "react/*",
              "react-dom",
              "react-dom/*",
              "dexie-react-hooks",
            ]
          : []),
      ],
      logLevel: "warning",
    });
    for (const input of Object.keys(result.metafile.inputs)) {
      const match = input.match(/^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//);
      if (!match || notices.has(match[1])) continue;
      const folder = match[1],
        pkg = JSON.parse(
          await readFile(path.join(folder, "package.json"), "utf8"),
        );
      const texts = [];
      for (const file of await readdir(folder))
        if (/^(licen[cs]e|copying|notice)(\.|$)/i.test(file))
          try {
            texts.push(await readFile(path.join(folder, file), "utf8"));
          } catch {}
      notices.set(
        folder,
        `${pkg.name}@${pkg.version} (${pkg.license ?? "see source"})\n${texts.join("\n")}`,
      );
    }
    const code = result.outputFiles.find((f) => f.path.endsWith(".mjs"))?.text;
    if (!code) throw Error("No bundled module");
    const css = result.outputFiles
      .filter((f) => f.path.endsWith(".css"))
      .map((f) => f.text)
      .join("\n");
    const loader = `function instantiate(require){const module={exports:{}};const exports=module.exports;\n${code}\nreturn module.exports;}\n`;
    const wrapper = browser
      ? `export default {async activate(context){const ui=context.services.require("core.ui");const removeStyle=ui.addStyles(${JSON.stringify(css)});const imported=instantiate(id=>{if(!(id in ui.modules))throw Error("Unsupported shared import: "+id);return ui.modules[id];});try{const cleanup=await imported.default.activate(context);return async()=>{try{await cleanup?.();}finally{removeStyle();}};}catch(error){removeStyle();throw error;}}};`
      : `export function createBackend(core){return instantiate(core.require).createBackend(core);}
export function loadForHost(core){return instantiate(core.require);}\nexport default {async activate(context){const core=context.services.require("core.server");const imported=instantiate(core.require);return imported.default?.activate?.(context);}};`;
    await writeFile(path.join("dist", file), loader + wrapper + "\n");
  }
  await writeFile(
    "dist/THIRD_PARTY_NOTICES.txt",
    [...notices.values()].join("\n\n====================\n\n"),
  );
  console.log(`Built ${manifest.id}@${manifest.version}`);
}
