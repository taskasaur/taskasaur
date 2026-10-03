import os from "node:os";
import { invariant } from "@taskasaur/platform/core/errors";
import type { IPty } from "node-pty";
interface Session {
  pty: IPty;
  owner: string;
  workspaceId: string;
  output: Array<{ sequence: number; data: string }>;
  sequence: number;
  bytes: number;
  lastSeen: number;
  exited: boolean;
  inputs: Set<string>;
}
export class NativeTerminal {
  private sessions = new Map<string, Session>();
  async command(
    command: string,
    input: Record<string, any>,
    owner: string,
    workspaceId: string,
    operationId: string,
  ) {
    if (command === "terminal.open") {
      invariant(
        this.sessions.size < 8,
        "TERMINAL_LIMIT",
        "Close an existing terminal first",
      );
      const { spawn } = await import("node-pty"),
        id = crypto.randomUUID();
      const pty = spawn(
        process.platform === "win32"
          ? "powershell.exe"
          : process.env.SHELL || "/bin/sh",
        [],
        {
          name: "xterm-256color",
          cols: 80,
          rows: 24,
          cwd: os.homedir(),
          env: {
            PATH: process.env.PATH ?? "",
            HOME: os.homedir(),
            USER: os.userInfo().username,
            LANG: process.env.LANG ?? "en_US.UTF-8",
            TERM: "xterm-256color",
          },
        },
      );
      const session: Session = {
        pty,
        owner,
        workspaceId,
        output: [],
        sequence: 0,
        bytes: 0,
        lastSeen: Date.now(),
        exited: false,
        inputs: new Set(),
      };
      pty.onData((data) => {
        session.output.push({ sequence: ++session.sequence, data });
        session.bytes += data.length;
        while (session.bytes > 1024 * 1024 && session.output.length)
          session.bytes -= session.output.shift()!.data.length;
      });
      pty.onExit(() => {
        session.exited = true;
      });
      this.sessions.set(id, session);
      return { sessionId: id };
    }
    const session = this.sessions.get(input.sessionId);
    invariant(
      session && session.owner === owner && session.workspaceId === workspaceId,
      "PERMISSION_DENIED",
      "Terminal session is unavailable",
    );
    session.lastSeen = Date.now();
    if (command === "terminal.poll")
      return {
        chunks: session.output
          .filter((v) => v.sequence > Number(input.cursor ?? 0))
          .slice(0, 128),
        exited: session.exited,
      };
    if (command === "terminal.input") {
      invariant(
        typeof input.data === "string" && input.data.length <= 65536,
        "PAYLOAD_TOO_LARGE",
        "Terminal input is too large",
      );
      if (!session.inputs.has(operationId)) {
        session.inputs.add(operationId);
        if (session.inputs.size > 10000)
          session.inputs.delete(session.inputs.values().next().value!);
        session.pty.write(input.data);
      }
      return { ok: true };
    }
    if (command === "terminal.resize") {
      session.pty.resize(
        Math.max(20, Math.min(400, Number(input.cols) || 80)),
        Math.max(5, Math.min(200, Number(input.rows) || 24)),
      );
      return { ok: true };
    }
    invariant(
      command === "terminal.close",
      "INVALID_COMMAND",
      "Unknown terminal operation",
    );
    session.pty.kill();
    this.sessions.delete(input.sessionId);
    return { ok: true };
  }
  sweep(allowed: (workspaceId: string, owner: string) => boolean) {
    for (const [id, session] of this.sessions)
      if (
        Date.now() - session.lastSeen > 5 * 60 * 1000 ||
        !allowed(session.workspaceId, session.owner)
      ) {
        session.pty.kill();
        this.sessions.delete(id);
      }
  }
  close() {
    for (const session of this.sessions.values()) session.pty.kill();
    this.sessions.clear();
  }
}
