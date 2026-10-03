import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { AppRuntime } from "./runtime";
import { Button } from "../ui/primitives/button";
/** Compatibility surface for v1 terminal packages, whose UI assumes a central WebSocket gateway. */
export function PeerTerminal({ runtime }: { runtime: AppRuntime }) {
  const [target, setTarget] = useState(""),
    [session, setSession] = useState(""),
    [error, setError] = useState("");
  const peers = [...runtime.node.peerDevices.values()].filter((p) =>
    p.capabilities.includes("terminal.host"),
  );
  return (
    <div className="space-y-4">
      <p className="page-description">
        Open an authorized shell on an online computer. Input is sent directly
        through the encrypted peer connection and is never replayed after a
        disconnect.
      </p>
      <div className="flex gap-2">
        <select
          aria-label="Terminal target"
          className="core-select"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          disabled={!!session}
        >
          <option value="">Choose a computer</option>
          {peers.map((p) => (
            <option key={p.deviceId} value={p.deviceId}>
              {p.name}
              {Date.now() - p.lastSeen > 45000 ? " (offline)" : ""}
            </option>
          ))}
        </select>
        <Button
          disabled={!target || !!session}
          onClick={async () => {
            try {
              const result = (await runtime.node.call(
                "terminal.open",
                {},
                target,
              )) as { sessionId: string };
              setSession(result.sessionId);
              setError("");
            } catch (e) {
              setError(String(e));
            }
          }}
        >
          Connect
        </Button>
        {session && (
          <Button variant="outline" onClick={() => setSession("")}>
            Disconnect
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="error-banner">
          {error}
        </p>
      )}
      {session ? (
        <PeerSession
          runtime={runtime}
          target={target}
          session={session}
          onError={setError}
        />
      ) : (
        <div className="empty-state">
          <h3>No active terminal</h3>
          <p>
            Enable terminal hosting in the desktop app or start a headless peer
            with terminal hosting enabled.
          </p>
        </div>
      )}
    </div>
  );
}
function PeerSession({
  runtime,
  target,
  session,
  onError,
}: {
  runtime: AppRuntime;
  target: string;
  session: string;
  onError: (message: string) => void;
}) {
  const container = useRef<HTMLDivElement>(null),
    send = useRef<(data: string) => void>(() => {});
  useEffect(() => {
    const term = new Terminal({
        cursorBlink: true,
        convertEol: false,
        fontSize: 13,
        theme: { background: "#102331", foreground: "#e7f0f7" },
      }),
      fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container.current!);
    fit.fit();
    let closed = false,
      cursor = 0,
      timer: ReturnType<typeof setTimeout> | undefined,
      queue: Promise<unknown> = Promise.resolve();
    const command = (name: string, input: unknown) =>
      runtime.node.call(
        "terminal." + name,
        { sessionId: session, ...(input as object) },
        target,
      );
    send.current = (data) => {
      if (closed) return;
      queue = queue
        .then(() => command("input", { data }))
        .catch((e) => {
          closed = true;
          onError(String(e));
          term.writeln("\r\n[Disconnected; input will not be replayed]");
        });
    };
    const input = term.onData((data) => send.current(data));
    const resize = new ResizeObserver(() => {
      fit.fit();
      void command("resize", { cols: term.cols, rows: term.rows }).catch((e) =>
        onError(String(e)),
      );
    });
    resize.observe(container.current!);
    async function poll() {
      if (closed) return;
      try {
        const result = (await command("poll", { cursor })) as {
          chunks: Array<{ sequence: number; data: string }>;
          exited: boolean;
        };
        for (const chunk of result.chunks) {
          term.write(chunk.data);
          cursor = chunk.sequence;
        }
        if (result.exited) {
          term.writeln("\r\n[Session ended]");
          closed = true;
          return;
        }
        timer = setTimeout(() => void poll(), 200);
      } catch (e) {
        closed = true;
        onError(String(e));
        term.writeln("\r\n[Disconnected; input will not be replayed]");
      }
    }
    void poll();
    return () => {
      closed = true;
      clearTimeout(timer);
      resize.disconnect();
      input.dispose();
      term.dispose();
      send.current = () => {};
      void command("close", {}).catch(() => {});
    };
  }, [runtime, target, session, onError]);
  return (
    <div className="space-y-2">
      <div className="flex gap-1 flex-wrap">
        {[
          ["Ctrl+C", "\u0003"],
          ["Ctrl+D", "\u0004"],
          ["Tab", "\t"],
          ["Esc", "\u001b"],
          ["↑", "\u001b[A"],
          ["↓", "\u001b[B"],
          ["Enter", "\r"],
        ].map(([label, data]) => (
          <Button
            key={label}
            variant="outline"
            size="sm"
            onClick={() => send.current(data)}
          >
            {label}
          </Button>
        ))}
      </div>
      <div
        ref={container}
        className="rounded-xl border p-3 bg-[#102331] h-[65dvh]"
      />
    </div>
  );
}
