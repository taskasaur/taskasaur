import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import WebSocket from "ws";
import ssh2 from "ssh2";
const { Server, utils } = ssh2;
import { SocketTunnel } from "./stream-transport";
import { invariant } from "../core/errors";
import { startNativeRunner } from "./native-runner";
export interface HostConfig {
  serverUrl: string;
  gatewayUrl: string;
  deviceId: string;
  token: string;
  workspaceId: string;
  userId: string;
  privateKey: string;
  terminal: boolean;
  automation: boolean;
}
export async function pairNativeHost(
  serverUrl: string,
  code: string,
  directory: string | null,
  capabilities: { terminal: boolean; automation: boolean },
) {
  const server = new URL(serverUrl);
  invariant(
    server.protocol === "https:" ||
      (server.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(server.hostname)),
    "TLS_REQUIRED",
    "Pairing requires HTTPS outside this computer",
  );
  if (capabilities.terminal) await import("node-pty");
  if (capabilities.automation)
    invariant(
      Number(process.versions.node.split(".")[0]) >= 24,
      "CAPABILITY_UNSUPPORTED",
      "Automation hosting requires Node.js 24 or newer",
    );
  const keys = utils.generateKeyPairSync("ed25519");
  const response = await fetch(new URL("/api/devices/pair", serverUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code,
      name: os.hostname(),
      platform: "desktop",
      capabilities: [
        ...(capabilities.terminal ? ["terminal.host"] : []),
        ...(capabilities.automation ? ["automation.execute"] : []),
      ],
      publicKey: keys.public,
    }),
  });
  const result = await response.json();
  invariant(
    response.ok,
    "PAIRING_FAILED",
    result.error?.message ?? "Pairing failed",
  );
  const config: HostConfig = {
    ...result,
    serverUrl,
    gatewayUrl: result.gatewayUrl ?? "/device-stream",
    privateKey: keys.private,
    ...capabilities,
  };
  if (directory) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(
      path.join(directory, "device.json"),
      JSON.stringify(config),
      { mode: 0o600 },
    );
  }
  return config;
}
export function connectNativeHost(config: HostConfig) {
  const url = new URL(config.gatewayUrl, config.serverUrl);
  url.protocol = ["https:", "wss:"].includes(url.protocol) ? "wss:" : "ws:";
  invariant(
    url.protocol === "wss:" ||
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname),
    "TLS_REQUIRED",
    "Remote device connections require TLS",
  );
  let socket: WebSocket,
    closed = false,
    heartbeat: ReturnType<typeof setInterval> | undefined,
    reconnect: ReturnType<typeof setTimeout> | undefined;
  let leaseEpoch: number | undefined,
    runner: Awaited<ReturnType<typeof startNativeRunner>> | undefined;
  if (config.automation)
    void startNativeRunner(
      config,
      path.join(os.homedir(), ".taskasaur", "runners", config.deviceId),
      () => leaseEpoch,
    )
      .then((value) => {
        runner = value;
        if (closed) void value.close();
      })
      .catch(() => {
        closed = true;
        socket?.close();
      });
  const sessions = new Map<
    string,
    { tunnel: SocketTunnel; close: () => void }
  >();
  const connect = () => {
    socket = new WebSocket(url, { maxPayload: 256 * 1024 });
    socket.on("open", () => {
      socket.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: crypto.randomUUID(),
          method: "device.connect",
          params: { deviceId: config.deviceId, token: config.token },
        }),
      );
      heartbeat = setInterval(
        () =>
          socket.send(
            JSON.stringify({
              jsonrpc: "2.0",
              method: "device.heartbeat",
              params: {},
            }),
          ),
        15000,
      );
    });
    socket.on("message", async (raw) => {
      try {
        const message = JSON.parse(raw.toString());
        if (message.result?.deviceId === config.deviceId) {
          leaseEpoch = Number(message.result.leaseEpoch);
          return;
        }
        if (message.method === "terminal.prepare") {
          invariant(
            config.terminal,
            "PERMISSION_DENIED",
            "Terminal hosting is disabled on this device",
          );
          const { sessionId, publicKey } = message.params;
          invariant(
            !sessions.has(sessionId),
            "SESSION_EXISTS",
            "Duplicate terminal session",
          );
          const authorizedKey = utils.parseKey(publicKey);
          invariant(
            !(authorizedKey instanceof Error),
            "INVALID_KEY",
            "Invalid session key",
          );
          const tunnel = new SocketTunnel(socket, sessionId);
          let cleanup = () => {};
          const ssh = new Server(
            { hostKeys: [config.privateKey] },
            (client) => {
              client.on("authentication", (context) => {
                if (
                  context.method !== "publickey" ||
                  context.username !== "taskasaur" ||
                  !context.key.data.equals(authorizedKey.getPublicSSH())
                )
                  return context.reject();
                if (
                  context.signature &&
                  authorizedKey.verify(
                    context.blob!,
                    context.signature,
                    context.hashAlgo,
                  ) !== true
                )
                  return context.reject();
                context.accept();
              });
              client.on("ready", () =>
                client.on("session", (accept) => {
                  const session = accept();
                  let cols = 80,
                    rows = 24;
                  session.on("pty", (accept, _reject, info) => {
                    cols = Math.max(20, Math.min(400, info.cols));
                    rows = Math.max(5, Math.min(200, info.rows));
                    accept?.();
                  });
                  session.on("shell", async (accept, reject) => {
                    try {
                      const channel = accept();
                      const pty = await import("node-pty");
                      const shell =
                        process.platform === "win32"
                          ? "powershell.exe"
                          : process.env.SHELL || "/bin/sh";
                      const processPty = pty.spawn(shell, [], {
                        name: "xterm-256color",
                        cols,
                        rows,
                        cwd: os.homedir(),
                        env: {
                          PATH: process.env.PATH ?? "",
                          HOME: os.homedir(),
                          USER: os.userInfo().username,
                          LANG: process.env.LANG ?? "en_US.UTF-8",
                          TERM: "xterm-256color",
                        },
                      });
                      const output = processPty.onData((data) =>
                        channel.write(data),
                      );
                      processPty.onExit(({ exitCode }) => {
                        channel.exit(exitCode);
                        channel.end();
                      });
                      channel.on("data", (data: Buffer) =>
                        processPty.write(data.toString("utf8")),
                      );
                      session.on("window-change", (_accept, _reject, info) =>
                        processPty.resize(
                          Math.max(20, Math.min(400, info.cols)),
                          Math.max(5, Math.min(200, info.rows)),
                        ),
                      );
                      cleanup = () => {
                        output.dispose();
                        processPty.kill();
                        channel.close();
                        client.end();
                      };
                      channel.on("close", () => {
                        output.dispose();
                        try {
                          processPty.kill();
                        } catch {}
                      });
                    } catch {
                      client.end();
                      tunnel.destroy();
                    }
                  });
                  session.on("exec", (_accept, reject) => reject());
                  session.on("subsystem", (_accept, reject) => reject());
                }),
              );
              client.on("error", () => tunnel.destroy());
            },
          );
          sessions.set(sessionId, {
            tunnel,
            close: () => {
              cleanup();
              tunnel.destroy();
              ssh.close();
            },
          });
          ssh.injectSocket(tunnel as never);
        } else if (message.method === "core.streams.chunk")
          sessions
            .get(message.params.sessionId)
            ?.tunnel.ingest(message.params.data);
        else if (message.method === "terminal.close") {
          sessions.get(message.params.sessionId)?.close();
          sessions.delete(message.params.sessionId);
        }
      } catch {
        socket.close(1008, "Invalid core operation");
      }
    });
    socket.on("close", () => {
      leaseEpoch = undefined;
      if (heartbeat) clearInterval(heartbeat);
      for (const session of sessions.values()) session.close();
      sessions.clear();
      if (!closed) reconnect = setTimeout(connect, 5000);
    });
    socket.on("error", () => socket.close());
  };
  connect();
  return {
    close: () => {
      closed = true;
      void runner?.close();
      if (reconnect) clearTimeout(reconnect);
      if (heartbeat) clearInterval(heartbeat);
      for (const session of sessions.values()) session.close();
      socket.close();
    },
  };
}
