import { createHash } from "node:crypto";
import http from "node:http";
import type { Duplex } from "node:stream";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

type SocketState = {
  buffer: Buffer;
  fragments: Buffer[];
};

/**
 * Local EventSub stand-in. Sends a welcome frame after the upgrade and records any client text.
 */
export class FakeEventSub {
  url = "";
  textFrames: string[] = [];
  requests: string[] = [];
  autoWelcome = true;
  welcome: unknown = {
    metadata: {
      message_id: "96a3f3b5-5dec-4eed-908e-e11ee657416c",
      message_type: "session_welcome",
      message_timestamp: "2023-07-19T14:56:51.634234626Z",
    },
    payload: {
      session: {
        id: "AQoQILE98gtqShGmLD7AM6yJThAB",
        status: "connected",
        connected_at: "2023-07-19T14:56:51.616329898Z",
        keepalive_timeout_seconds: 10,
        reconnect_url: null,
      },
    },
  };

  private server: http.Server | null = null;
  private sockets: Duplex[] = [];

  async start(): Promise<void> {
    const server = http.createServer((_req, res) => {
      res.writeHead(426).end();
    });
    server.on("upgrade", (request, socket, head) => this.onUpgrade(request, socket, head));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fake EventSub did not bind a TCP port");
    this.url = `ws://127.0.0.1:${address.port}`;
    this.server = server;
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    this.sockets = [];
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  send(message: unknown): void {
    const socket = this.sockets[this.sockets.length - 1];
    if (!socket || socket.destroyed) throw new Error("fake EventSub has no client");
    this.sendJson(socket, message);
  }

  private onUpgrade(request: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    this.requests.push(request.url ?? "");
    const key = request.headers["sec-websocket-key"];
    if (typeof key !== "string") {
      socket.destroy();
      return;
    }
    const accept = createHash("sha1").update(key + WS_GUID).digest("base64");
    socket.write([
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "",
      "",
    ].join("\r\n"));
    this.sockets.push(socket);
    const state: SocketState = { buffer: Buffer.alloc(0), fragments: [] };
    if (head.length > 0) this.consume(socket, state, head);
    socket.on("data", (chunk: Buffer) => this.consume(socket, state, chunk));
    socket.on("close", () => {
      this.sockets = this.sockets.filter((item) => item !== socket);
    });
    socket.on("error", () => {
      this.sockets = this.sockets.filter((item) => item !== socket);
    });
    if (this.autoWelcome) this.sendJson(socket, this.welcome);
  }

  private consume(socket: Duplex, state: SocketState, chunk: Buffer): void {
    state.buffer = Buffer.concat([state.buffer, chunk]);
    while (state.buffer.length >= 2) {
      const first = state.buffer[0];
      const second = state.buffer[1];
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (state.buffer.length < 4) return;
        length = state.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (state.buffer.length < 10) return;
        length = Number(state.buffer.readBigUInt64BE(2));
        offset = 10;
      }
      const maskLength = masked ? 4 : 0;
      if (state.buffer.length < offset + maskLength + length) return;
      let payload = state.buffer.subarray(offset + maskLength, offset + maskLength + length);
      if (masked) {
        const mask = state.buffer.subarray(offset, offset + 4);
        const unmasked = Buffer.alloc(payload.length);
        for (let index = 0; index < payload.length; index++) unmasked[index] = payload[index] ^ mask[index % 4];
        payload = unmasked;
      }
      state.buffer = state.buffer.subarray(offset + maskLength + length);
      if (opcode === 0x8) return;
      if (opcode === 0x9) {
        if (!socket.destroyed) socket.write(encodeFrame(0xA, payload));
        continue;
      }
      if (opcode === 0x1 || opcode === 0x0) {
        if (opcode === 0x1) state.fragments = [Buffer.from(payload)];
        else state.fragments.push(Buffer.from(payload));
        if (!fin) continue;
        this.textFrames.push(Buffer.concat(state.fragments).toString("utf8"));
        state.fragments = [];
      }
    }
  }

  private sendJson(socket: Duplex, message: unknown): void {
    if (socket.destroyed) return;
    socket.write(encodeFrame(0x1, Buffer.from(JSON.stringify(message))));
  }
}

function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(payload.length < 126 ? 2 : 4);
  header[0] = 0x80 | opcode;
  if (payload.length < 126) header[1] = payload.length;
  else {
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  }
  return Buffer.concat([header, payload]);
}
