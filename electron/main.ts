import { registerWorkspaceFolders } from "./workspace-folders";
import {
  app,
  BrowserWindow,
  protocol,
  ipcMain,
  safeStorage,
  dialog,
  Menu,
  Tray,
  nativeImage,
  type IpcMainInvokeEvent,
} from "electron";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { startNativeRuntime } from "../packages/platform-node/runtime";
import { DesktopStorage } from "./storage";
import type { Identity } from "../packages/core/crypto";
import type { NativeSettings } from "../packages/app-ui/network";
import type { PeerPacket } from "../packages/sync/protocol";
const here = path.dirname(fileURLToPath(import.meta.url));
protocol.registerSchemesAsPrivileged([
  {
    scheme: "taskasaur",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      allowServiceWorkers: true,
      corsEnabled: true,
    },
  },
]);
let window: BrowserWindow | null = null,
  runtime: Awaited<ReturnType<typeof startNativeRuntime>> | undefined,
  tray: Tray | undefined,
  quitting = false;
if (!app.requestSingleInstanceLock()) app.quit();
app.on("second-instance", () => {
  window?.show();
  window?.focus();
});
app
  .whenReady()
  .then(async () => {
    const directory = path.join(app.getPath("userData"), "peer"),
      settingsPath = path.join(app.getPath("userData"), "peer-settings.json");
    let settings: NativeSettings = {
      terminal: false,
      automation: false,
      trustedCode: false,
      background: false,
      plugins: false,
    };
    try {
      settings = {
        ...settings,
        ...JSON.parse(await readFile(settingsPath, "utf8")),
      };
    } catch {}
    runtime = await startNativeRuntime({
      directory,
      name: os.hostname() + " services",
      storage: new DesktopStorage(path.join(directory, "replicas")),
      ...settings,
      activeWorkspaces: [],
      network: { listen: ["/ip4/0.0.0.0/tcp/0/ws"], relay: true },
    });
    const rendererStorage = new DesktopStorage(
      path.join(app.getPath("userData"), "local-replica"),
    );
    const trusted = (event: IpcMainInvokeEvent) => {
      if (
        event.sender !== window?.webContents ||
        event.senderFrame !== window.webContents.mainFrame
      )
        throw Error(
          "Only the main Taskasaur window can access native services",
        );
      const url = new URL(event.senderFrame.url),
        dev = process.env.VITE_DEV_SERVER_URL;
      if (
        !(url.protocol === "taskasaur:" && url.host === "app") &&
        (!dev || url.origin !== new URL(dev).origin)
      )
        throw Error("Untrusted native caller");
    };
    await registerWorkspaceFolders(() => window!, trusted);
    const info = () => ({
      id: runtime!.core.identity.id,
      request: runtime!.core.pairingRequest(),
      addresses: runtime!.addresses(),
      workspaces: runtime!.core.profiles().map((p) => p.id),
      options: settings,
    });
    for (const operation of ["get", "set", "delete", "keys"] as const)
      ipcMain.handle(
        "replica:" + operation,
        async (event, key: string, value?: Uint8Array) => {
          trusted(event);
          if (typeof key !== "string" || key.length > 1000)
            throw Error("Invalid storage key");
          if (operation === "set") {
            if (
              !(value instanceof Uint8Array) ||
              value.length > 40 * 1024 * 1024
            )
              throw Error("Invalid storage value");
            return rendererStorage.set(key, value);
          }
          return rendererStorage[operation](key);
        },
      );
    ipcMain.handle("peer:info", (event) => {
      trusted(event);
      return info();
    });
    ipcMain.handle("peer:select", async (event, workspaceId?: string) => {
      trusted(event);
      if (
        workspaceId !== undefined &&
        (typeof workspaceId !== "string" ||
          !runtime!.core.profiles().some((p) => p.id === workspaceId))
      )
        throw Error("Unknown workspace");
      await runtime!.selectWorkspace(workspaceId);
    });
    ipcMain.handle(
      "peer:join",
      async (event, invitation: string, credential?: Identity) => {
        trusted(event);
        const node = await runtime!.core.join(invitation, credential);
        await runtime!.selectWorkspace(node.replica.workspaceId);
      },
    );
    ipcMain.handle(
      "peer:request",
      async (event, address: string, packet: PeerPacket) => {
        trusted(event);
        if (address === "local:desktop") {
          const node = runtime!.core.workspaces.get(packet.workspaceId);
          if (!node) throw Error("This workspace is closed");
          return node.protocol.receive(packet);
        }
        return runtime!.core.transport!.request(address, packet);
      },
    );
    ipcMain.handle("peer:configure", async (event, input: NativeSettings) => {
      trusted(event);
      const next = {
        terminal: input.terminal === true,
        automation: input.automation === true,
        trustedCode: input.trustedCode === true,
        background: input.background === true,
        plugins: input.plugins === true,
      };
      if (
        Object.entries(next).some(
          ([key, value]) => value && !settings[key as keyof NativeSettings],
        )
      ) {
        const answer = await dialog.showMessageBox(window!, {
          type: "question",
          buttons: ["Cancel", "Enable capabilities"],
          defaultId: 0,
          cancelId: 0,
          message: "Allow these capabilities on this computer?",
          detail:
            Object.entries(next)
              .filter(([, enabled]) => enabled)
              .map(([name]) => name)
              .join(", ") +
            "\nApproved workspace editors can invoke the capabilities you enable.",
        });
        if (answer.response !== 1) return info();
      }
      await writeFile(settingsPath, JSON.stringify(next), { mode: 0o600 });
      settings = next;
      Object.assign(runtime!.services.options, next);
      await runtime!.services.tick();
      return info();
    });
    protocol.handle("taskasaur", async (request) => {
      const url = new URL(request.url);
      if (url.host !== "app") return new Response("Not found", { status: 404 });
      const root = path.resolve(here, "../dist");
      const assetPath = decodeURIComponent(url.pathname);
      const filename = path.resolve(
        root,
        assetPath === "/"
          ? "index.html"
          : assetPath === "/office-engine/cool.html"
            ? "office-editor.html"
            : assetPath.slice(1),
      );
      if (!filename.startsWith(root + path.sep))
        return new Response("Invalid path", { status: 400 });
      try {
        let bytes: Buffer | string = await readFile(filename);
        const types: Record<string, string> = {
          ".html": "text/html",
          ".js": "text/javascript",
          ".css": "text/css",
          ".wasm": "application/wasm",
          ".svg": "image/svg+xml",
          ".json": "application/json",
          ".png": "image/png",
          ".woff2": "font/woff2",
        };
        return new Response(
          typeof bytes === "string" ? bytes : new Uint8Array(bytes),
          {
            headers: {
              "Content-Type":
                types[path.extname(filename)] ?? "application/octet-stream",
              "Cross-Origin-Opener-Policy": "same-origin",
              "Cross-Origin-Embedder-Policy": "require-corp",
            },
          },
        );
      } catch {
        return new Response("Asset not installed", { status: 404 });
      }
    });
    window = new BrowserWindow({
      width: 1280,
      height: 860,
      minWidth: 760,
      minHeight: 600,
      webPreferences: {
        preload: path.join(here, "preload.mjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event, url) => {
      const target = new URL(url);
      if (
        !(target.protocol === "taskasaur:" && target.host === "app") &&
        (!process.env.VITE_DEV_SERVER_URL ||
          target.origin !== new URL(process.env.VITE_DEV_SERVER_URL).origin)
      )
        event.preventDefault();
    });
    window.on("close", (event) => {
      if (!quitting) {
        event.preventDefault();
        window?.hide();
      }
    });
    await window.loadURL(process.env.VITE_DEV_SERVER_URL ?? "taskasaur://app/");
    tray = new Tray(
      nativeImage
        .createFromPath(path.join(here, "../dist/taskasaur_icon.png"))
        .resize({ width: 18, height: 18 }),
    );
    tray.setToolTip("Taskasaur");
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: "Open Taskasaur", click: () => window?.show() },
        { label: "Quit", click: () => app.quit() },
      ]),
    );
  })
  .catch((error) => {
    dialog.showErrorBox(
      "Taskasaur could not start",
      error instanceof Error ? error.message : String(error),
    );
    app.exit(1);
  });
app.on("activate", () => window?.show());
app.on("before-quit", (event) => {
  if (runtime && !quitting) {
    event.preventDefault();
    quitting = true;
    void runtime.close().finally(() => app.quit());
  }
});
