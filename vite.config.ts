import path from "node:path";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import electron from "vite-plugin-electron/simple";

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    electron({
      main: {
        entry: "electron/main.ts"
      },
      preload: {
        input: path.join(__dirname, "electron/preload.ts")
      },
      renderer: process.env.NODE_ENV === "test" ? undefined : {}
    })
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      "node:util": path.resolve(__dirname, "src/lib/csdb-browser.ts")
    }
  },
  server: {
    watch: {
      ignored: ["**/*.csdb"]
    }
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: "./src/test/setup.ts"
  }
});
