import { app, ipcMain, safeStorage, type BrowserWindow } from "electron";
import { readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

type Cookie = { value: string; expires: number };
type Jar = Record<string, Record<string, Cookie>>;
// Authentication stays in the host's encrypted vault, outside renderer storage.
export async function installHttpBridge(window: BrowserWindow) {
  const filename = path.join(app.getPath("userData"), "sessions.enc");
  let jars: Jar = {},
    writing: Promise<unknown> = Promise.resolve();
  if (safeStorage.isEncryptionAvailable()) {
    try {
      jars = JSON.parse(safeStorage.decryptString(await readFile(filename)));
    } catch {
      /* A missing or unreadable vault requires signing in again. */
    }
  }
  const persist = async () => {
    if (!safeStorage.isEncryptionAvailable())
      throw new Error("Secure session storage is unavailable");
    const value = safeStorage.encryptString(JSON.stringify(jars));
    writing = writing
      .catch(() => undefined)
      .then(async () => {
        const temporary = filename + "." + randomUUID();
        await writeFile(temporary, value, { mode: 0o600 });
        await rename(temporary, filename);
      });
    await writing;
  };
  ipcMain.handle(
    "server:http",
    async (
      event,
      input: {
        url: string;
        method: string;
        contentType?: string;
        body?: Uint8Array;
      },
    ) => {
      if (
        event.sender !== window.webContents ||
        event.senderFrame !== window.webContents.mainFrame
      )
        throw new Error("Untrusted client frame");
      const url = new URL(input.url),
        loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
      if (
        (url.protocol !== "https:" &&
          !(loopback && url.protocol === "http:")) ||
        url.username ||
        url.password ||
        !url.pathname.startsWith("/api/")
      )
        throw new Error("Use an HTTPS Taskasaur server");
      if (
        !["GET", "POST", "PUT", "DELETE"].includes(input.method) ||
        (input.body?.byteLength ?? 0) > 50 * 1024 * 1024
      )
        throw new Error("Invalid server request");
      const jar = jars[url.origin] ?? {},
        cookies = Object.entries(jar)
          .filter(([, cookie]) => cookie.expires > Date.now())
          .map(([name, cookie]) => name + "=" + cookie.value)
          .join("; ");
      const response = await fetch(url, {
        method: input.method,
        redirect: "error",
        signal: AbortSignal.timeout(90000),
        headers: {
          ...(cookies ? { Cookie: cookies } : {}),
          ...(input.contentType ? { "Content-Type": input.contentType } : {}),
        },
        ...(input.body ? { body: new Uint8Array(input.body) } : {}),
      });
      let changed = false;
      for (const header of response.headers.getSetCookie()) {
        const parts = header.split(";"),
          at = parts[0].indexOf("="),
          name = parts[0].slice(0, at);
        if (!["taskasaur-access", "taskasaur-refresh"].includes(name)) continue;
        const maxAge = parts
          .find((p) => p.trim().toLowerCase().startsWith("max-age="))
          ?.split("=")[1];
        if (Number(maxAge) === 0) delete jar[name];
        else
          jar[name] = {
            value: parts[0].slice(at + 1),
            expires:
              Date.now() + Math.min(30 * 86400, Number(maxAge) || 86400) * 1000,
          };
        changed = true;
      }
      if (changed) {
        jars[url.origin] = jar;
        await persist();
      }
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (response.body) {
        const reader = response.body.getReader();
        try {
          for (;;) {
            const { done, value: chunk } = await reader.read();
            if (done) break;
            size += chunk.byteLength;
            if (size > 55 * 1024 * 1024)
              throw new Error("Server response exceeds 55 MB");
            chunks.push(chunk);
          }
        } finally {
          await reader.cancel().catch(() => undefined);
          reader.releaseLock();
        }
      }
      const headers = Object.fromEntries(
        [...response.headers].filter(
          ([name]) =>
            !["set-cookie", "content-encoding", "content-length"].includes(
              name.toLowerCase(),
            ),
        ),
      );
      return { status: response.status, headers, body: Buffer.concat(chunks) };
    },
  );
}
