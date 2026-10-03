import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
import { defineConfig, loadEnv } from "vite";
import { officeAssets } from "./scripts/office-assets";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import electron from "vite-plugin-electron/simple";
export default defineConfig(({ mode }) => {
  const headers = {
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
    "X-Content-Type-Options": "nosniff",
  };
  return {
    base: "./",
    plugins: [
      react(),
      tailwindcss(),
      officeAssets(),
      ...(process.env.TASKASAUR_NATIVE === "desktop"
        ? [
            electron({
              main: {
                entry: "electron/main.ts",
                vite: {
                  build: {
                    rollupOptions: {
                      external: [
                        "ssh2",
                        "node-pty",
                        "ws",
                        "openworkflow",
                        "openworkflow/sqlite",
                        "typescript",
                        /^@electric-sql\//, /^@automerge\//, /^@libp2p\//, /^@chainsafe\//, /^@multiformats\//, "libp2p",
                      ],
                    },
                  },
                },
              },
              preload: { input: "electron/preload.ts" },
            }),
          ]
        : []),
    ],
    resolve: {
      alias: {
        "@": path.resolve("packages"),
        "@automerge/automerge": path.resolve(path.dirname(require.resolve("@automerge/automerge")), "../mjs/entrypoints/fullfat_base64.js"),
        cloudevents: path.resolve(
          "node_modules/cloudevents/bundles/cloudevents.js",
        ),
      },
    },
    server: { host: "127.0.0.1", port: 5173, headers },
    preview: { host: "127.0.0.1", port: 4173, headers },
    build: { outDir: "dist", sourcemap: true, manifest: true },
  };
});
