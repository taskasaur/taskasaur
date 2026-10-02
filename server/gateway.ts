import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { WebSocketServer, type WebSocket } from "ws";
import ssh2, { type ClientChannel, type Client } from "ssh2";
const { utils } = ssh2;
import { database } from "./database";
import { Repository } from "./repository";
import { DeviceService, hashToken } from "./devices";
import { SocketTunnel } from "./stream-transport";
import { invariant, CoreError } from "../packages/core/errors";

export function startGateway(port = Number(process.env.GATEWAY_PORT ?? 8787)) {
  const repo = new Repository(database()),
    devices = new DeviceService(repo),
    hosts = new Map<
      string,
      { socket: WebSocket; token: string; tunnels: Map<string, SocketTunnel> }
    >();
  const server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"status":"ready"}');
  });
  const wss = new WebSocketServer({ server, maxPayload: 256 * 1024 });
  wss.on("connection", (socket, request) => {
    const origin = request.headers.origin,
      allowed = (
        process.env.ALLOWED_ORIGINS ??
        process.env.PUBLIC_APP_URL ??
        "http://localhost:3000"
      )
        .split(",")
        .concat([
          "taskasaur://app",
          "capacitor://localhost",
          "https://localhost",
        ]);
    if (origin && !allowed.includes(origin)) {
      socket.close(1008, "Origin not allowed");
      return;
    }
    let deviceId: string | undefined,
      client: Client | undefined,
      channel: ClientChannel | undefined,
      remoteHost: typeof hosts extends Map<string, infer T> ? T : never,
      sessionId: string | undefined;
    let authenticated = false;
    let guard: (() => Promise<void>) | undefined,
      checking = false,
      cleaned = false;
    const authorization = setInterval(async () => {
      if (checking || !guard) return;
      checking = true;
      try {
        await guard();
      } catch {
        socket.close(1008, "Access ended");
      } finally {
        checking = false;
      }
    }, 5000);
    const deadline = setTimeout(() => {
      if (!authenticated) socket.close(1008, "Authentication required");
    }, 10000);
    const send = (message: unknown) => {
      if (socket.readyState === 1 && socket.bufferedAmount < 2 * 1024 * 1024)
        socket.send(JSON.stringify(message));
      else socket.close(1009, "Buffer limit exceeded");
    };
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      clearInterval(authorization);
      clearTimeout(deadline);
      channel?.close();
      client?.end();
      if (sessionId && remoteHost) {
        remoteHost.tunnels.get(sessionId)?.destroy();
        remoteHost.tunnels.delete(sessionId);
        if (remoteHost.socket.readyState === 1)
          remoteHost.socket.send(
            JSON.stringify({
              jsonrpc: "2.0",
              method: "terminal.close",
              params: { sessionId },
            }),
          );
      }
      if (deviceId) {
        const host = hosts.get(deviceId);
        if (host?.socket === socket) {
          for (const tunnel of host.tunnels.values()) tunnel.destroy();
          hosts.delete(deviceId);
        }
      }
    };
    socket.on("close", cleanup);
    socket.on("error", cleanup);
    socket.on("message", async (raw) => {
      try {
        const message = JSON.parse(raw.toString());
        invariant(
          message.jsonrpc === "2.0" && typeof message.method === "string",
          "VALIDATION_FAILED",
          "Invalid core frame",
        );
        if (!authenticated && message.method === "device.connect") {
          const identity = await devices.connect(
            String(message.params.deviceId),
            String(message.params.token),
          );
          deviceId = String(message.params.deviceId);
          hosts.get(deviceId)?.socket.close(1000, "New connection lease");
          hosts.set(deviceId, {
            socket,
            token: String(message.params.token),
            tunnels: new Map(),
          });
          authenticated = true;
          guard = async () => {
            await devices.authenticate(deviceId!, String(message.params.token));
          };
          clearTimeout(deadline);
          await devices.heartbeat(deviceId, String(message.params.token));
          send({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              deviceId,
              workspaceId: identity.workspace_id,
              leaseEpoch: identity.lease_epoch,
            },
          });
          return;
        }
        if (!authenticated && message.method === "terminal.attach") {
          const ticket = await repo.db.transaction(async (tx) => {
            const result = await tx.query<{
              id: string;
              device_id: string;
              workspace_id: string;
              user_id: string;
            }>(
              "DELETE FROM taskasaur.stream_tickets WHERE token_hash=$1 AND expires_at>now() RETURNING *",
              [hashToken(String(message.params.ticket))],
            );
            invariant(
              result.rows[0],
              "UNAUTHENTICATED",
              "Session ticket is invalid or expired",
            );
            return result.rows[0];
          });
          const principal = {
            userId: ticket.user_id,
            workspaceId: ticket.workspace_id,
            pluginId: "remote-terminal",
            permissions: [],
          };
          const device = await repo.get(principal, ticket.device_id);
          await repo.requirePlugin(principal, "remote-terminal");
          invariant(
            device.ownerId === principal.userId && !device.data.revoked,
            "PERMISSION_DENIED",
            "Device access revoked",
          );
          remoteHost = hosts.get(ticket.device_id)!;
          invariant(
            remoteHost,
            "DEVICE_OFFLINE",
            "The selected computer is offline",
          );
          sessionId = ticket.id;
          guard = async () => {
            await repo.requirePlugin(principal, "remote-terminal");
            const fresh = await repo.get(principal, ticket.device_id);
            invariant(
              !fresh.data.revoked &&
                Array.isArray(fresh.data.capabilities) &&
                fresh.data.capabilities.includes("terminal.host"),
              "PERMISSION_DENIED",
              "Terminal access ended",
            );
            await devices.authenticate(ticket.device_id, remoteHost.token);
          };
          const hostKey = (
            await repo.db.query<{ public_key: string }>(
              "SELECT public_key FROM taskasaur.device_keys WHERE device_id=$1 AND revoked_at IS NULL",
              [ticket.device_id],
            )
          ).rows[0];
          invariant(hostKey, "PERMISSION_DENIED", "Device identity revoked");
          const pair = utils.generateKeyPairSync("ed25519"),
            parsedHostKey = utils.parseKey(hostKey.public_key);
          invariant(
            !(parsedHostKey instanceof Error),
            "HOST_KEY_CHANGED",
            "Invalid host key",
          );
          const tunnel = new SocketTunnel(remoteHost.socket, sessionId);
          remoteHost.tunnels.set(sessionId, tunnel);
          remoteHost.socket.send(
            JSON.stringify({
              jsonrpc: "2.0",
              id: sessionId,
              method: "terminal.prepare",
              params: {
                sessionId,
                publicKey: pair.public,
                actorId: principal.userId,
              },
            }),
          );
          client = new ssh2.Client();
          client.on("error", () => {
            send({
              jsonrpc: "2.0",
              id: message.id,
              error: { code: -32000, message: "SSH session failed" },
            });
            socket.close();
          });
          client.on("ready", () =>
            client!.shell(
              {
                term: "xterm-256color",
                cols: Math.max(
                  20,
                  Math.min(400, Number(message.params.cols) || 80),
                ),
                rows: Math.max(
                  5,
                  Math.min(200, Number(message.params.rows) || 24),
                ),
              },
              (error, stream) => {
                if (error) {
                  socket.close(1011, "Shell unavailable");
                  return;
                }
                channel = stream;
                const decoder = new StringDecoder("utf8");
                stream.on("data", (data: Buffer) =>
                  send({
                    jsonrpc: "2.0",
                    method: "terminal.data",
                    params: { data: decoder.write(data) },
                  }),
                );
                stream.on("close", () => {
                  const tail = decoder.end();
                  if (tail)
                    send({
                      jsonrpc: "2.0",
                      method: "terminal.data",
                      params: { data: tail },
                    });
                  send({ jsonrpc: "2.0", method: "terminal.exit", params: {} });
                  socket.close();
                });
                send({ jsonrpc: "2.0", id: message.id, result: { sessionId } });
              },
            ),
          );
          authenticated = true;
          clearTimeout(deadline);
          client.connect({
            sock: tunnel,
            username: "taskasaur",
            privateKey: pair.private,
            hostVerifier: (key: Buffer) =>
              Buffer.from(key).equals(parsedHostKey.getPublicSSH()),
            readyTimeout: 15000,
          });
          return;
        }
        invariant(authenticated, "UNAUTHENTICATED", "Authenticate first");
        if (deviceId) {
          const host = hosts.get(deviceId)!;
          invariant(
            host?.socket === socket,
            "LEASE_EXPIRED",
            "This device connection has been replaced",
          );
          if (message.method === "device.heartbeat") {
            await devices.heartbeat(deviceId, host.token);
            return;
          }
          if (message.method === "core.streams.chunk") {
            const tunnel = host.tunnels.get(String(message.params.sessionId));
            invariant(tunnel, "SESSION_EXPIRED", "Unknown stream");
            tunnel.ingest(String(message.params.data));
            return;
          }
          throw new CoreError(
            "UNDECLARED_COMMAND",
            "Device command is not declared",
          );
        }
        if (message.method === "terminal.input") {
          invariant(
            typeof message.params.data === "string" &&
              message.params.data.length <= 16384,
            "PAYLOAD_TOO_LARGE",
            "Terminal input too large",
          );
          channel?.write(message.params.data);
        } else if (message.method === "terminal.resize")
          channel?.setWindow(
            Math.max(5, Math.min(200, Number(message.params.rows))),
            Math.max(20, Math.min(400, Number(message.params.cols))),
            0,
            0,
          );
        else if (message.method === "terminal.close") socket.close();
        else
          throw new CoreError(
            "UNDECLARED_COMMAND",
            "Terminal command is not declared",
          );
      } catch (error) {
        send({
          jsonrpc: "2.0",
          id: null,
          error: {
            code: -32000,
            message:
              error instanceof CoreError
                ? error.message
                : "Stream operation failed",
            data: {
              kind: error instanceof CoreError ? error.kind : "INTERNAL_ERROR",
            },
          },
        });
        socket.close(1008, "Session rejected");
      }
    });
  });
  server.listen(port, "0.0.0.0");
  return {
    server,
    wss,
    stop: () => {
      for (const socket of wss.clients) socket.close();
      wss.close();
      server.close();
    },
  };
}
