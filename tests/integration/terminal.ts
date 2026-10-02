import assert from "node:assert/strict";
import WebSocket from "ws";
import { TestClient, eventually } from "./client";
import { pairNativeHost, connectNativeHost } from "../../server/native-host";
const client = await new TestClient().setup();
await client.enable("remote-terminal");
const enrollment = await client.request("devices/enroll", {});
const config = await pairNativeHost(client.base, enrollment.code, null, {
  terminal: true,
  automation: false,
});
const gateway = new URL(
  "/device-stream",
  process.env.TEST_GATEWAY_URL ?? "http://localhost:3000",
);
gateway.protocol = gateway.protocol === "https:" ? "wss:" : "ws:";
config.gatewayUrl = gateway.href;
const host = connectNativeHost(config);
let socket: WebSocket | undefined;
try {
  await eventually<any[]>(
    () => client.request("devices"),
    (rows) =>
      rows.some(
        (d) => d.id === config.deviceId && Number(d.data.lease_epoch) > 0,
      ),
  );
  const ticket = await client.request("terminal/open", {
    deviceId: config.deviceId,
  });
  socket = new WebSocket(gateway, {
    origin: new URL(client.base).origin,
  });
  const marker = "TASKASAUR_PTY_" + crypto.randomUUID().replaceAll("-", "");
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Terminal round trip timed out")),
      15000,
    );
    let output = "",
      sent = false;
    socket!.on("open", () =>
      socket!.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "attach",
          method: "terminal.attach",
          params: { ticket: ticket.ticket, cols: 100, rows: 30 },
        }),
      ),
    );
    socket!.on("error", reject);
    socket!.on("message", (raw) => {
      const frame = JSON.parse(raw.toString());
      if (frame.error) {
        clearTimeout(timeout);
        reject(new Error(frame.error.message));
        return;
      }
      if (frame.result?.sessionId && !sent) {
        sent = true;
        socket!.send(
          JSON.stringify({
            jsonrpc: "2.0",
            method: "terminal.input",
            params: { data: `printf '\\n%s\\n' '${marker}'\r` },
          }),
        );
      }
      if (frame.method === "terminal.data") {
        output += frame.params.data;
        if (
          output.includes("\r\n" + marker + "\r\n") ||
          output.includes("\n" + marker + "\n")
        ) {
          clearTimeout(timeout);
          resolve();
        }
      }
    });
  });
  console.log("Native SSH/PTY through core gateway passed");
} finally {
  socket?.close();
  host.close();
  await client.request("devices/revoke", { id: config.deviceId });
}
