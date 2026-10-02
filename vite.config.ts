import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import electron from "vite-plugin-electron/simple";
export default defineConfig({
  base: "./",
  plugins: [
    react(),
    tailwindcss(),
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
                      "openworkflow/postgres",
                      "typescript",
                      "pg",
                      "postgres",
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
  build: { outDir: "dist", sourcemap: true },
});
