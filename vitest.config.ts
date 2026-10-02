import { defineConfig } from "vitest/config";
import path from "node:path";
export default defineConfig({
  resolve: { alias: { "@": path.resolve("packages") } },
  test: {
    setupFiles: ["tests/fixtures/setup.ts"],
    environment: "node",
    include: ["tests/**/*.test.{ts,tsx}"],
    testTimeout: 20000,
  },
});
