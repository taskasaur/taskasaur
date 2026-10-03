import { Duplex } from "node:stream";
import type WebSocket from "ws";
export class SocketTunnel extends Duplex {
  readonly remoteAddress = "core";
  readonly remoteFamily = "core";
  readonly remotePort = 0;
  constructor(
    private socket: WebSocket,
    readonly sessionId: string,
  ) {
    super({ highWaterMark: 128 * 1024 });
  }
  _read() {}
  _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    done: (error?: Error | null) => void,
  ) {
    if (
      this.socket.readyState !== 1 ||
      this.socket.bufferedAmount > 2 * 1024 * 1024
    ) {
      done(new Error("Stream disconnected or exceeded its buffer"));
      return;
    }
    this.socket.send(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "core.streams.chunk",
        params: { sessionId: this.sessionId, data: chunk.toString("base64") },
      }),
      done,
    );
  }
  ingest(data: string) {
    if (data.length > 256 * 1024) {
      this.destroy(new Error("Frame too large"));
      return;
    }
    this.push(Buffer.from(data, "base64"));
  }
  _destroy(error: Error | null, done: (error?: Error | null) => void) {
    this.push(null);
    done(error);
  }
}
