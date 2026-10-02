import { createReadStream } from "node:fs";
import { realpath, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { Connect, Plugin } from "vite";

const types: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".wasm": "application/wasm",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};
export function officeAssets(): Plugin {
  const middleware: Connect.NextHandleFunction = async (req, res, next) => {
    if (!req.url?.startsWith("/office-engine/")) return next();
    if (!["GET", "HEAD"].includes(req.method ?? "")) {
      res.writeHead(405);
      res.end();
      return;
    }
    try {
      const root = await realpath(
        process.env.OFFICE_ASSET_PATH ?? ".taskasaur/office-engine/wasm",
      );
      const relative = decodeURIComponent(
        new URL(req.url, "http://localhost").pathname.slice(15),
      );
      const filename = await realpath(path.resolve(root, relative));
      if (!filename.startsWith(root + path.sep))
        throw new Error("Invalid path");
      const info = await stat(filename);
      if (!info.isFile()) throw new Error("Not a file");
      res.setHeader(
        "Content-Type",
        types[path.extname(filename)] ?? "application/octet-stream",
      );
      res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
      res.setHeader("Cache-Control", "public, max-age=3600");
      if (relative === "cool.html") {
        const html = (await readFile(filename, "utf8")).replace(
          '<script src="src/main.js" defer></script>',
          '<script src="/office-bridge.js" defer></script><script src="src/main.js" defer></script>',
        );
        res.end(req.method === "HEAD" ? undefined : html);
        return;
      }
      res.setHeader("Content-Length", info.size);
      if (req.method === "HEAD") {
        res.end();
        return;
      }
      const stream = createReadStream(filename);
      stream.on("error", () => res.destroy());
      stream.pipe(res);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Office assets are unavailable. Run npm run office:prepare.");
    }
  };
  return {
    name: "taskasaur-office-assets",
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}
