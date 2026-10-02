import { chmod, access } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
try {
  const root = path.dirname(require.resolve("node-pty/package.json"));
  if (process.platform !== "win32")
    for (const helper of [
      path.join(
        root,
        "prebuilds",
        `${process.platform}-${process.arch}`,
        "spawn-helper",
      ),
      path.join(root, "build", "Release", "spawn-helper"),
    ]) {
      try {
        await access(helper);
        await chmod(helper, 0o755);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
} catch (error) {
  if (error.code !== "MODULE_NOT_FOUND") throw error;
}
