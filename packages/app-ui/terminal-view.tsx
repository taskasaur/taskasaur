"use client";
import { useEffect, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { AppRuntime } from "./runtime";
import { Button } from "../ui/primitives/button";
export default function TerminalView({ runtime }: { runtime: AppRuntime }) {
  const devices =
    useLiveQuery(() => runtime.collection("devices").list(), [runtime]) ?? [];
  const [deviceId, setDeviceId] = useState(""),
    [connection, setConnection] = useState<{
      sessionId: string;
      ticket: string;
      gatewayUrl: string;
    } | null>(null),
    [error, setError] = useState("");
  return (
    <div className="space-y-4">
      <p className="page-description">
        Connect to a linked computer that offers terminal access. Browser and
        mobile devices can control supported computers through this same
        interface.
      </p>
      <div className="flex flex-wrap gap-2">
        <select
          aria-label="Terminal target"
          className="core-select max-w-80"
          value={deviceId}
          onChange={(e) => setDeviceId(e.target.value)}
        >
          <option value="">Choose a computer</option>
          {devices.map((d) => (
            <option
              key={d.id}
              value={d.id}
              disabled={
                !Array.isArray(d.data.capabilities) ||
                !d.data.capabilities.includes("terminal.host")
              }
            >
              {String(d.data.name)}
              {Date.now() - Date.parse(String(d.data.last_seen)) > 45000
                ? " (offline)"
                : ""}
            </option>
          ))}
        </select>
        <Button
          disabled={
            !deviceId || !runtime.profile.connected || Boolean(connection)
          }
          onClick={async () => {
            try {
              await runtime.synchronize();
              const result = await runtime.api<{
                sessionId: string;
                ticket: string;
                gatewayUrl: string;
              }>("terminal/open", { deviceId });
              setConnection(result);
              setError("");
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
            }
          }}
        >
          Connect
        </Button>
        {connection && (
          <Button variant="outline" onClick={() => setConnection(null)}>
            Disconnect
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="error-banner">
          {error}
        </p>
      )}
      {connection ? (
        <TerminalSession
          connection={connection}
          baseUrl={runtime.profile.serverUrl}
          onError={setError}
        />
      ) : (
        <div className="empty-state">
          <h3>No active terminal</h3>
          <p>
            Terminal access requires a paired native host, an online connection,
            and a separate terminal permission.
          </p>
        </div>
      )}
    </div>
  );
}
function TerminalSession({
  connection,
  baseUrl,
  onError,
}: {
  connection: { sessionId: string; ticket: string; gatewayUrl: string };
  baseUrl: string;
  onError: (message: string) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const sendInput = useRef<(data: string) => void>(() => undefined),
    terminalRef = useRef<Terminal | null>(null);
  useEffect(() => {
    const terminal = new Terminal({
        cursorBlink: true,
        convertEol: false,
        fontFamily: "ui-monospace, monospace",
        fontSize: 13,
        theme: { background: "#102331", foreground: "#e7f0f7" },
      }),
      fit = new FitAddon();
    terminal.loadAddon(fit);
    terminalRef.current = terminal;
    terminal.open(container.current!);
    fit.fit();
    const url = new URL(connection.gatewayUrl, baseUrl || location.origin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url);
    socket.onopen = () =>
      socket.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: connection.sessionId,
          method: "terminal.attach",
          params: {
            ticket: connection.ticket,
            cols: terminal.cols,
            rows: terminal.rows,
          },
        }),
      );
    socket.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        if (message.method === "terminal.data")
          terminal.write(message.params.data);
        else if (message.error) onError(message.error.message);
        else if (message.method === "terminal.exit")
          terminal.writeln("\r\n[Session ended]");
      } catch {
        onError("Invalid terminal stream frame");
      }
    };
    socket.onerror = () => onError("Terminal connection failed");
    socket.onclose = () =>
      terminal.writeln("\r\n[Disconnected; input will not be replayed]");
    sendInput.current = (data) => {
      if (socket.readyState === WebSocket.OPEN)
        socket.send(
          JSON.stringify({
            jsonrpc: "2.0",
            method: "terminal.input",
            params: { data },
          }),
        );
    };
    const input = terminal.onData((data) => sendInput.current(data));
    const resize = new ResizeObserver(() => {
      fit.fit();
      if (socket.readyState === WebSocket.OPEN)
        socket.send(
          JSON.stringify({
            jsonrpc: "2.0",
            method: "terminal.resize",
            params: { cols: terminal.cols, rows: terminal.rows },
          }),
        );
    });
    resize.observe(container.current!);
    return () => {
      resize.disconnect();
      input.dispose();
      if (socket.readyState === WebSocket.OPEN)
        socket.send(
          JSON.stringify({
            jsonrpc: "2.0",
            method: "terminal.close",
            params: {},
          }),
        );
      socket.close();
      terminal.dispose();
      terminalRef.current = null;
      sendInput.current = () => undefined;
    };
  }, [connection, baseUrl, onError]);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1" aria-label="Terminal control keys">
        {[
          ["Ctrl+C", "\u0003"],
          ["Ctrl+D", "\u0004"],
          ["Tab", "\t"],
          ["Esc", "\u001b"],
          ["↑", "\u001b[A"],
          ["↓", "\u001b[B"],
          ["←", "\u001b[D"],
          ["→", "\u001b[C"],
          ["Enter", "\r"],
        ].map(([label, data]) => (
          <Button
            key={label}
            size="sm"
            variant="outline"
            onClick={() => {
              sendInput.current(data);
              terminalRef.current?.focus();
            }}
          >
            {label}
          </Button>
        ))}
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            void navigator.clipboard
              .writeText(terminalRef.current?.getSelection() ?? "")
              .catch(() => onError("Clipboard access is unavailable"))
          }
        >
          Copy selection
        </Button>
      </div>
      <div
        ref={container}
        className="rounded-xl border p-3 bg-[#102331] h-[65dvh]"
      />
    </div>
  );
}
