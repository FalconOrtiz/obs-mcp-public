import { createHash } from "node:crypto";
import http from "node:http";
import type { Duplex } from "node:stream";
import { createAuthenticationString } from "../src/protocol.ts";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export type FakeHandlerResult = {
  code?: number;
  comment?: string;
  responseData?: Record<string, unknown>;
};

export type FakeObsOptions = {
  password?: string;
  salt?: string;
  challenge?: string;
  rpcVersion?: number;
};

type SocketState = {
  buffer: Buffer;
  fragments: Buffer[];
};

/**
 * Minimal obs-websocket v5 server on a node:http upgrade.
 * Speaks JSON text frames only. Enough for handshake, request, and batch tests.
 */
export class FakeObs {
  readonly password?: string;
  readonly salt: string;
  readonly challenge: string;
  readonly rpcVersion: number;
  url = "";
  connections: Array<{ at: number; identified: boolean }> = [];
  received: Array<{ op: number; d: Record<string, unknown> }> = [];
  failNextConnections = 0;
  invalidateOnRequest = false;
  eventBeforeResponse = false;
  /** Delay before each request or batch response, in ms. */
  responseDelayMs = 0;

  private server: http.Server | null = null;
  private sockets = new Set<Duplex>();
  private handlers = new Map<string, (requestData: Record<string, unknown> | undefined) => FakeHandlerResult>();

  constructor(options: FakeObsOptions = {}) {
    this.password = options.password;
    this.salt = options.salt ?? "lM1GncleQOaCu9lT1yeUZhFYnqhsLLP1G5lAGo3ixaI=";
    this.challenge = options.challenge ?? "+IxH4CnCiqpX1rM9scsNynZzbOe4KhDeYcTNS3PDaeY=";
    this.rpcVersion = options.rpcVersion ?? 1;
  }

  setHandler(requestType: string, handler: (requestData: Record<string, unknown> | undefined) => FakeHandlerResult): void {
    this.handlers.set(requestType, handler);
  }

  async start(): Promise<void> {
    const server = http.createServer((_req, res) => {
      res.writeHead(426).end();
    });
    server.on("upgrade", (request, socket, head) => {
      this.onUpgrade(request, socket, head);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fake OBS did not bind a TCP port");
    this.url = `ws://127.0.0.1:${address.port}`;
    this.server = server;
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  private onUpgrade(request: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    const record = { at: Date.now(), identified: false };
    this.connections.push(record);
    if (this.failNextConnections > 0) {
      this.failNextConnections -= 1;
      socket.destroy();
      return;
    }
    const key = request.headers["sec-websocket-key"];
    if (typeof key !== "string") {
      socket.destroy();
      return;
    }
    const accept = createHash("sha1").update(key + WS_GUID).digest("base64");
    const offered = String(request.headers["sec-websocket-protocol"] ?? "");
    const lines = [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
    ];
    if (offered.split(",").some((part) => part.trim() === "obswebsocket.json")) {
      lines.push("Sec-WebSocket-Protocol: obswebsocket.json");
    }
    socket.write(`${lines.join("\r\n")}\r\n\r\n`);
    this.sockets.add(socket);
    const state: SocketState = { buffer: Buffer.alloc(0), fragments: [] };
    if (head.length > 0) this.consume(socket, state, record, head);
    socket.on("data", (chunk: Buffer) => this.consume(socket, state, record, chunk));
    socket.on("close", () => this.sockets.delete(socket));
    socket.on("error", () => this.sockets.delete(socket));
    this.sendJson(socket, {
      op: 0,
      d: {
        obsStudioVersion: "30.2.2",
        obsWebSocketVersion: "5.5.2",
        rpcVersion: this.rpcVersion,
        ...(this.password
          ? { authentication: { challenge: this.challenge, salt: this.salt } }
          : {}),
      },
    });
  }

  private consume(socket: Duplex, state: SocketState, record: { identified: boolean }, chunk: Buffer): void {
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
      if (opcode === 0x9) {
        socket.write(encodeFrame(0xA, payload));
        continue;
      }
      if (opcode === 0x8) {
        socket.end();
        return;
      }
      if (opcode === 0x1 || opcode === 0x0) {
        if (opcode === 0x1) state.fragments = [Buffer.from(payload)];
        else state.fragments.push(Buffer.from(payload));
        if (!fin) continue;
        const text = Buffer.concat(state.fragments).toString("utf8");
        state.fragments = [];
        this.onText(socket, record, text);
      }
    }
  }

  private onText(socket: Duplex, record: { identified: boolean }, text: string): void {
    let message: { op?: number; d?: Record<string, unknown> };
    try {
      message = JSON.parse(text) as { op?: number; d?: Record<string, unknown> };
    } catch {
      this.sendClose(socket, 4002, "Message decode error");
      return;
    }
    const op = message.op ?? -1;
    const data = message.d ?? {};
    this.received.push({ op, d: data });
    if (!record.identified) {
      if (op !== 1) {
        this.sendClose(socket, 4007, "Not identified");
        return;
      }
      if (this.password) {
        const expected = createAuthenticationString(this.password, this.salt, this.challenge);
        if (data.authentication !== expected) {
          this.sendClose(socket, 4009, "Authentication failed");
          return;
        }
      }
      record.identified = true;
      this.sendJson(socket, { op: 2, d: { negotiatedRpcVersion: this.rpcVersion } });
      return;
    }
    if (op === 6) this.onRequest(socket, data);
    else if (op === 8) this.onBatch(socket, data);
  }

  private onRequest(socket: Duplex, data: Record<string, unknown>): void {
    if (this.invalidateOnRequest) {
      this.sendClose(socket, 4011, "Session invalidated");
      return;
    }
    const requestType = String(data.requestType ?? "");
    const requestId = typeof data.requestId === "string" ? data.requestId : "";
    const requestData = data.requestData && typeof data.requestData === "object" ? data.requestData as Record<string, unknown> : undefined;
    const outcome = this.runHandler(requestType, requestData);
    if (this.eventBeforeResponse) {
      this.sendJson(socket, {
        op: 5,
        d: { eventType: "SceneItemEnableStateChanged", eventIntent: 128, eventData: { sceneItemEnabled: true } },
      });
    }
    this.sendLater(socket, {
      op: 7,
      d: {
        requestType,
        requestId,
        requestStatus: {
          result: (outcome.code ?? 100) === 100,
          code: outcome.code ?? 100,
          ...(outcome.comment ? { comment: outcome.comment } : {}),
        },
        ...(outcome.responseData ? { responseData: outcome.responseData } : {}),
      },
    });
  }

  private onBatch(socket: Duplex, data: Record<string, unknown>): void {
    const requestId = typeof data.requestId === "string" ? data.requestId : "";
    const haltOnFailure = data.haltOnFailure === true;
    const requests = Array.isArray(data.requests) ? data.requests : [];
    const results = [];
    for (const item of requests) {
      if (!item || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      const requestType = String(record.requestType ?? "");
      const itemId = typeof record.requestId === "string" ? record.requestId : requestId;
      const requestData = record.requestData && typeof record.requestData === "object" ? record.requestData as Record<string, unknown> : undefined;
      const outcome = this.runHandler(requestType, requestData);
      const code = outcome.code ?? 100;
      results.push({
        requestType,
        requestId: itemId,
        requestStatus: {
          result: code === 100,
          code,
          ...(outcome.comment ? { comment: outcome.comment } : {}),
        },
        ...(outcome.responseData ? { responseData: outcome.responseData } : {}),
      });
      if (haltOnFailure && code !== 100) break;
    }
    this.sendLater(socket, { op: 9, d: { requestId, results } });
  }

  private runHandler(requestType: string, requestData: Record<string, unknown> | undefined): FakeHandlerResult {
    const handler = this.handlers.get(requestType);
    if (!handler) return { responseData: {} };
    return handler(requestData);
  }

  private sendLater(socket: Duplex, message: unknown): void {
    if (this.responseDelayMs > 0) setTimeout(() => this.sendJson(socket, message), this.responseDelayMs);
    else this.sendJson(socket, message);
  }

  private sendJson(socket: Duplex, message: unknown): void {
    if (socket.destroyed) return;
    socket.write(encodeFrame(0x1, Buffer.from(JSON.stringify(message))));
  }

  private sendClose(socket: Duplex, code: number, reason: string): void {
    const reasonBuffer = Buffer.from(reason);
    const payload = Buffer.alloc(2 + reasonBuffer.length);
    payload.writeUInt16BE(code, 0);
    reasonBuffer.copy(payload, 2);
    if (!socket.destroyed) socket.write(encodeFrame(0x8, payload));
    socket.end();
  }
}

function encodeFrame(opcode: number, payload: Buffer): Buffer {
  let header: Buffer;
  if (payload.length < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | opcode;
    header[1] = payload.length;
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  return Buffer.concat([header, payload]);
}
