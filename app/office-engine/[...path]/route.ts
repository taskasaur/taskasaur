import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
export const runtime = "nodejs";
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
export async function GET(
  _request: Request,
  context: { params: Promise<{ path: string[] }> },
) {
  const parts = (await context.params).path;
  if (parts.some((p) => p === ".." || p.includes("\\") || p.includes("\0")))
    return new Response("Invalid asset path", { status: 400 });
  const root = path.resolve(
    process.env.OFFICE_ASSET_PATH ?? ".taskasaur/office-engine/wasm",
  );
  const filename = path.resolve(root, ...parts);
  if (!filename.startsWith(root + path.sep))
    return new Response("Invalid asset path", { status: 400 });
  try {
    const info = await stat(filename);
    if (!info.isFile()) return new Response("Not found", { status: 404 });
    let data: Buffer | string = await readFile(filename);
    if (parts.join("/") === "cool.html")
      data = data
        .toString("utf8")
        .replace(
          '<script src="src/main.js" defer></script>',
          '<script src="/office-bridge.js" defer></script><script src="src/main.js" defer></script>',
        );
    return new Response(
      typeof data === "string" ? data : new Uint8Array(data),
      {
        headers: {
          "Content-Type":
            types[path.extname(filename)] ?? "application/octet-stream",
          "Cache-Control": "public, max-age=3600",
          "Cross-Origin-Resource-Policy": "same-origin",
          "Cross-Origin-Embedder-Policy": "require-corp",
          "Cross-Origin-Opener-Policy": "same-origin",
        },
      },
    );
  } catch {
    return NextResponse.json(
      {
        error:
          "Office engine assets are not installed. Run npm run office:prepare.",
      },
      { status: 404 },
    );
  }
}
