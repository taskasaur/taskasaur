import { parseArgs } from "node:util";
import path from "node:path";
import os from "node:os";
import { readFile, writeFile, stat, realpath } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createServer } from "node:http";
import { FileStorage } from "../../packages/platform-node/storage";
import { lockDirectory } from "../../packages/platform-node/lock";
import { DeviceCore } from "../../packages/core/device";
import { startNativeRuntime } from "../../packages/platform-node/runtime";
import { snapshotStorage } from "../../packages/storage";
import { exportBackup, restoreBackup } from "../../packages/core/backup";
import { isRequiredCore } from "@taskasaur/platform/core/catalog";
const { values } = parseArgs({
  options: {
    data: { type: "string" },
    name: { type: "string" },
    workspace: { type: "string" },
    port: { type: "string" },
    "peer-port": { type: "string" },
    host: { type: "string" },
    "no-ui": { type: "boolean" },
    server: { type: "boolean" },
    relay: { type: "boolean" },
    plugins: { type: "boolean" },
    terminal: { type: "boolean" },
    automation: { type: "boolean" },
    "trusted-code": { type: "boolean" },
    background: { type: "boolean" },
    "pairing-request": { type: "boolean" },
    approve: { type: "string" },
    join: { type: "string" },
    output: { type: "string" },
    "workspace-id": { type: "string" },
    plugin: { type: "string" },
    backup: { type: "string" },
    restore: { type: "string" },
    "passphrase-file": { type: "string" },
    help: { type: "boolean" },
  },
});
if (values.help) {
  console.log(
    "Taskasaur peer\n  --data <directory> --name <device name> --workspace <name>\n  --port 8080 --peer-port 8787 --host 127.0.0.1 --no-ui --server --relay\n  --plugins --terminal --automation --trusted-code --background (explicit opt-ins)\n  --pairing-request --output request.json\n  --approve request.json --workspace-id <id> --output invitation.json\n  --join invitation.json\n  --plugin <id> --workspace-id <id>",
  );
  process.exit(0);
}
const directory = path.resolve(
  values.data ?? process.env.TASKASAUR_DATA ?? ".taskasaur/peer",
);
if (values.backup || values.restore) {
  if (
    !values["passphrase-file"] ||
    Boolean(values.backup) === Boolean(values.restore)
  )
    throw Error("Choose --backup or --restore and provide --passphrase-file");
  const unlock = await lockDirectory(directory),
    storage = snapshotStorage(
      new FileStorage(path.join(directory, "replicas")),
    );
  try {
    const password = (
      await readFile(values["passphrase-file"], "utf8")
    ).replace(/\r?\n$/, "");
    if (values.restore)
      await restoreBackup(
        storage,
        await readFile(values.restore, "utf8"),
        password,
      );
    else
      await writeFile(values.backup!, await exportBackup(storage, password), {
        mode: 0o600,
        flag: "wx",
      });
  } finally {
    await unlock();
  }
  process.exit(0);
}
if (values["pairing-request"] || values.approve || values.join) {
  const unlock = await lockDirectory(directory);
  const core = await DeviceCore.open(
    new FileStorage(path.join(directory, "replicas")),
    values.name ?? os.hostname(),
  );
  let output = "";
  if (values["pairing-request"]) output = core.pairingRequest();
  else if (values.join) {
    const node = await core.join(await readFile(values.join, "utf8"));
    output = JSON.stringify({
      workspaceId: node.replica.workspaceId,
      name: node.link.name,
    });
  } else
    output = await core.approve(
      values["workspace-id"] ?? core.profiles()[0]?.id,
      await readFile(values.approve!, "utf8"),
    );
  if (values.output)
    await writeFile(values.output, output + "\n", { mode: 0o600 });
  else console.log(output);
  await core.close();
  await unlock();
  process.exit(0);
}
const serverMode = values.server || process.env.TASKASAUR_MODE === "server";
const syncIntervalMs = Number(
  process.env.TASKASAUR_SYNC_INTERVAL_MS ?? (serverMode ? 15000 : 5000),
);
const documentCache = Number(
  process.env.TASKASAUR_DOCUMENT_CACHE ?? (serverMode ? 128 : 512),
);
const host = values.host ?? process.env.TASKASAUR_HOST ?? "127.0.0.1",
  port = Number(values.port ?? process.env.PORT ?? 8080),
  peerPort = Number(
    values["peer-port"] ?? process.env.TASKASAUR_PEER_PORT ?? 8787,
  );
const runtime = await startNativeRuntime({
  directory,
  name: values.name ?? process.env.TASKASAUR_NAME,
  createWorkspace:
    values.workspace ??
    process.env.TASKASAUR_WORKSPACE ??
    (serverMode ? undefined : "My workspace"),
  storageOnly: process.env.TASKASAUR_STORAGE_ONLY === "1",
  syncIntervalMs,
  documentCache,
  terminal: values.terminal ?? process.env.TASKASAUR_TERMINAL === "1",
  automation: values.automation ?? process.env.TASKASAUR_AUTOMATION === "1",
  trustedCode:
    values["trusted-code"] ?? process.env.TASKASAUR_TRUSTED_CODE === "1",
  background: values.background ?? process.env.TASKASAUR_BACKGROUND === "1",
  plugins: values.plugins ?? process.env.TASKASAUR_PLUGINS === "1",
  network: {
    listen: [`/ip4/${host}/tcp/${peerPort}/ws`],
    announce: process.env.TASKASAUR_ANNOUNCE?.split(",").filter(Boolean),
    relay: values.relay ?? process.env.TASKASAUR_RELAY === "1",
  },
});
if (values.plugin) {
  const { availablePlugins } =
    await import("../../packages/platform-node/compat/plugin-inventory");
  const inventory = await availablePlugins();
  const workspaceId = values["workspace-id"] ?? runtime.core.profiles()[0].id;
  const seen = new Set<string>();
  async function install(id: string) {
    if (seen.has(id)) return;
    seen.add(id);
    const entry = inventory.plugins.find((p) => p.id === id);
    if (!entry) {
      if (isRequiredCore(id)) return;
      throw Error("Plugin is not in the selected inventory: " + id);
    }
    for (const dep of entry.dependencies) await install(dep);
    await runtime.services.install(workspaceId, {
      id: entry.id,
      version: entry.version,
      sha256: entry.sha256,
      grants: entry.grants,
    });
    console.log("Installed", id);
  }
  await install(values.plugin);
  await runtime.close();
  process.exit(0);
}
const webRoot = path.resolve(process.env.TASKASAUR_UI_PATH ?? "dist"),
  serveUi =
    !serverMode && !values["no-ui"] && process.env.TASKASAUR_SERVE_UI !== "0";
const mime: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};
const http = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
    if (url.pathname === "/api/health") {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          status: "ready",
          mode: serverMode ? "server" : "peer",
          ui: serveUi,
          workspaces: runtime.core.profiles().length,
        }),
      );
      return;
    }
    if (
      req.method === "POST" &&
      /^\/api\/automation\/hooks\/[0-9a-f-]{36}$/.test(url.pathname)
    ) {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 1024 * 1024) {
          res.writeHead(413);
          res.end("Webhook body exceeds 1 MB");
          return;
        }
        chunks.push(chunk);
      }
      try {
        const result = await runtime.services.webhook(
          url.pathname.split("/").at(-1)!,
          String(req.headers.authorization ?? "").replace(/^Bearer /, ""),
          String(req.headers["idempotency-key"] ?? ""),
          JSON.parse(Buffer.concat(chunks).toString()),
        );
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(result));
      } catch (error) {
        res.writeHead(
          (error as { kind?: string }).kind === "PERMISSION_DENIED" ? 401 : 400,
        );
        res.end(
          JSON.stringify({
            error: error instanceof Error ? error.message : "Webhook failed",
          }),
        );
      }
      return;
    }
    if (!serveUi || !["GET", "HEAD"].includes(req.method ?? "")) {
      res.writeHead(404);
      res.end();
      return;
    }
    if (url.pathname === "/office-engine/cool.html") {
      res.setHeader("Content-Type", "text/html");
      res.end(await readFile(path.join(webRoot, "office-editor.html")));
      return;
    }
    if (url.pathname.startsWith("/office-engine/")) {
      const root = await realpath(
          process.env.OFFICE_ASSET_PATH ?? path.join(webRoot, "office-engine"),
        ),
        file = await realpath(
          path.resolve(root, decodeURIComponent(url.pathname.slice(15))),
        );
      if (!file.startsWith(root + path.sep) || !(await stat(file)).isFile()) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.setHeader(
        "Content-Type",
        mime[path.extname(file)] ?? "application/octet-stream",
      );
      res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
      res.setHeader("Content-Length", (await stat(file)).size);
      if (req.method === "HEAD") {
        res.end();
        return;
      }
      createReadStream(file)
        .on("error", () => res.destroy())
        .pipe(res);
      return;
    }
    const requested = path.resolve(
      webRoot,
      "." + decodeURIComponent(url.pathname),
    );
    if (!requested.startsWith(webRoot + path.sep) && requested !== webRoot) {
      res.writeHead(403);
      res.end();
      return;
    }
    let file = requested;
    try {
      if (!(await stat(file)).isFile()) file = path.join(webRoot, "index.html");
    } catch {
      file = path.extname(file) ? requested : path.join(webRoot, "index.html");
    }
    res.setHeader(
      "Content-Type",
      mime[path.extname(file)] ?? "application/octet-stream",
    );
    res.end(req.method === "HEAD" ? undefined : await readFile(file));
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
});
http.listen(port, host, () =>
  console.log(
    JSON.stringify({
      ui: serveUi ? `http://${host}:${port}` : null,
      health: `http://${host}:${port}/api/health`,
      peers: runtime.addresses(),
      workspaces: runtime.core
        .profiles()
        .map((p) => ({ id: p.id, name: p.name })),
      capabilities: runtime.services.capabilities(),
    }),
  ),
);
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  http.close();
  await runtime.close();
  process.exit(0);
}
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
