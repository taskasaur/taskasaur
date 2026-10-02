import path from "node:path";
import { defineConfig, loadEnv } from "vite";
import { officeAssets } from "./scripts/office-assets";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import electron from "vite-plugin-electron/simple";
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "TASKASAUR_");
  const target =
    process.env.TASKASAUR_API_PROXY_URL ||
    env.TASKASAUR_API_PROXY_URL ||
    "http://127.0.0.1:3000";
  const headers = {
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
    "X-Content-Type-Options": "nosniff",
  };
  const proxy = Object.fromEntries(
    ["/api", "/auth/v1", "/device-stream"].map((route) => [
      route,
      { target, changeOrigin: false, ws: route === "/device-stream" },
    ]),
  );
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
    resolve: { alias: { "@": path.resolve("packages") } },
    server: { host: "127.0.0.1", port: 5173, headers, proxy },
    preview: { host: "127.0.0.1", port: 4173, headers, proxy },
    build: { outDir: "dist", sourcemap: true, manifest: true },
  };
});
