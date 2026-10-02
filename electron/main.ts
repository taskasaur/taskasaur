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
} from "electron";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installHttpBridge } from "./http";
import {
  connectNativeHost,
  pairNativeHost,
  type HostConfig,
} from "@taskasaur/platform/device-host/native-host";
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
  host: ReturnType<typeof connectNativeHost> | undefined;
app.whenReady().then(async () => {
  protocol.handle("taskasaur", async (request) => {
    const url = new URL(request.url);
    if (url.host !== "app") return new Response("Not found", { status: 404 });
    const assetPath = decodeURIComponent(url.pathname),
      office = assetPath.startsWith("/office-engine/");
    const root = office
      ? path.join(process.resourcesPath, "office-engine", "wasm")
      : path.join(here, "../dist");
    const filename = path.resolve(
      root,
      office
        ? assetPath.slice("/office-engine/".length)
        : assetPath === "/"
          ? "index.html"
          : assetPath.slice(1),
    );
    if (!filename.startsWith(root + path.sep))
      return new Response("Invalid path", { status: 400 });
    try {
      let bytes: Buffer | string = await readFile(filename);
      if (office && assetPath.endsWith("/cool.html"))
        bytes = bytes
          .toString()
          .replace(
            '<script src="src/main.js" defer></script>',
            '<script src="/office-bridge.js" defer></script><script src="src/main.js" defer></script>',
          );
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
    if (
      !url.startsWith("taskasaur://app/") &&
      !url.startsWith("http://localhost:5173/")
    )
      event.preventDefault();
  });
  await installHttpBridge(window);
  const statePath = path.join(app.getPath("userData"), "device.enc");
  try {
    if (safeStorage.isEncryptionAvailable()) {
      const config = JSON.parse(
        safeStorage.decryptString(await readFile(statePath)),
      ) as HostConfig;
      host = connectNativeHost(config);
    }
  } catch {}
  ipcMain.handle("platform:capabilities", () => ({
    platform: process.platform,
    terminalHost: true,
    automationExecute: true,
    secureCredentials: safeStorage.isEncryptionAvailable(),
  }));
  ipcMain.handle(
    "device:pair",
    async (
      event,
      input: {
        serverUrl: string;
        code: string;
        terminal: boolean;
        automation: boolean;
      },
    ) => {
      if (
        event.sender !== window?.webContents ||
        !safeStorage.isEncryptionAvailable()
      )
        throw new Error("Secure native host is unavailable");
      const result = await dialog.showMessageBox(window, {
        type: "question",
        buttons: ["Cancel", "Link computer"],
        defaultId: 0,
        cancelId: 0,
        message: "Link this computer to your Taskasaur server?",
        detail: `Server: ${input.serverUrl}\nAllow terminal access: ${input.terminal ? "yes" : "no"}\nAllow automation: ${input.automation ? "yes" : "no"}`,
      });
      if (result.response !== 1) return { cancelled: true };
      const config = await pairNativeHost(input.serverUrl, input.code, null, {
        terminal: input.terminal,
        automation: input.automation,
      });
      await writeFile(
        statePath,
        safeStorage.encryptString(JSON.stringify(config)),
        { mode: 0o600 },
      );
      host?.close();
      host = connectNativeHost(config);
      return { deviceId: config.deviceId };
    },
  );
  await window.loadURL(process.env.VITE_DEV_SERVER_URL ?? "taskasaur://app/");
  const tray = new Tray(
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
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("before-quit", () => host?.close());
