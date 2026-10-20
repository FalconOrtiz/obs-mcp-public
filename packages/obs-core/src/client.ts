import { randomUUID } from "node:crypto";
import {
  BatchExecution,
  EVENT_SUBSCRIPTION_NONE,
  FATAL_CLOSE_CODES,
  OpCode,
  RPC_VERSION,
  createAuthenticationString,
  formatCloseError,
  redactObsPayload,
  type ObsRequest,
  type ObsResult,
  ObsConnectionError,
  ObsRequestError,
} from "./protocol.ts";

export type ObsClientOptions = {
  url: string;
  password?: string;
  maxAttempts?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  handshakeTimeoutMs?: number;
  requestTimeoutMs?: number;
};

type HelloMessage = {
  obsStudioVersion?: string;
  obsWebSocketVersion?: string;
  rpcVersion?: number;
  authentication?: { challenge?: string; salt?: string };
};

type Pending = {
  expectedOp: number;
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

const WS_OPEN = 1;

export class ObsClient {
  readonly url: string;
  readonly password?: string;
  readonly maxAttempts: number;
  readonly retryBaseMs: number;
  readonly retryMaxMs: number;
  readonly handshakeTimeoutMs: number;
  readonly requestTimeoutMs: number;

  connectAttempts = 0;

  private socket: WebSocket | null = null;
  private generation = 0;
  private ready = false;
  private stopped = false;
  private sessionInvalidated = false;
  private connecting: Promise<void> | null = null;
  private pending = new Map<string, Pending>();

  constructor(options: ObsClientOptions) {
    this.url = options.url;
    this.password = options.password;
    this.maxAttempts = options.maxAttempts ?? 4;
    this.retryBaseMs = options.retryBaseMs ?? 200;
    this.retryMaxMs = options.retryMaxMs ?? 2000;
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? 4000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10000;
  }

  async request(requestType: string, requestData?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const requestId = randomUUID();
    const data: Record<string, unknown> = { requestType, requestId };
    if (requestData && Object.keys(requestData).length > 0) data.requestData = requestData;
    const response = await this.roundTrip(OpCode.RequestResponse, { op: OpCode.Request, d: data }, requestId);
    const status = readStatus(response);
    if (!status.result) throw new ObsRequestError(requestType, status.code, status.comment);
    return redactObsPayload((response.responseData as Record<string, unknown> | undefined) ?? {});
  }

  async batch(
    requests: ObsRequest[],
    options?: { haltOnFailure?: boolean; executionType?: number },
  ): Promise<ObsResult[]> {
    const requestId = randomUUID();
    const data = {
      requestId,
      haltOnFailure: options?.haltOnFailure ?? false,
      executionType: options?.executionType ?? BatchExecution.SerialRealtime,
      requests: requests.map((request) => {
        const item: Record<string, unknown> = { requestType: request.requestType };
        if (request.requestId) item.requestId = request.requestId;
        if (request.requestData && Object.keys(request.requestData).length > 0) item.requestData = request.requestData;
        return item;
      }),
    };
    const response = await this.roundTrip(OpCode.RequestBatchResponse, { op: OpCode.RequestBatch, d: data }, requestId);
    const results = Array.isArray(response.results) ? response.results : [];
    return redactObsPayload(results as ObsResult[]);
  }

  close(): void {
    this.stopped = true;
    this.ready = false;
    this.generation += 1;
    this.socket?.close();
    this.socket = null;
    this.rejectPending(new ObsConnectionError("OBS client closed"));
  }

  private async roundTrip(expectOp: number, payload: unknown, requestId: string): Promise<Record<string, unknown>> {
    await this.ensureConnected();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new ObsConnectionError(`Timed out waiting for OBS opcode ${expectOp} (${requestId})`));
      }, this.requestTimeoutMs);
      this.pending.set(requestId, {
        expectedOp: expectOp,
        resolve,
        reject,
        timer,
      });
      try {
        this.send(payload);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(error instanceof Error ? error : new ObsConnectionError(String(error)));
      }
    });
  }

  private ensureConnected(): Promise<void> {
    if (this.stopped) return Promise.reject(new ObsConnectionError("OBS client is closed"));
    if (this.sessionInvalidated) {
      return Promise.reject(
        new ObsConnectionError(formatCloseError(4011), { closeCode: 4011, fatal: true }),
      );
    }
    if (this.ready && this.socket?.readyState === WS_OPEN) return Promise.resolve();
    if (!this.connecting) {
      this.connecting = this.connectWithRetry().finally(() => {
        this.connecting = null;
      });
    }
    return this.connecting;
  }

  private async connectWithRetry(): Promise<void> {
    let delay = this.retryBaseMs;
    let last: unknown;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        await this.connectOnce();
        return;
      } catch (error) {
        last = error;
        this.ready = false;
        this.abandonSocket();
        const fatal = error instanceof ObsConnectionError && error.fatal;
        if (fatal || attempt === this.maxAttempts) break;
        await sleep(delay);
        delay = Math.min(delay * 2, this.retryMaxMs);
      }
    }
    const detail = last instanceof Error ? last.message : String(last);
    throw new ObsConnectionError(
      `Could not connect to OBS at ${this.url} after ${this.maxAttempts} attempt(s): ${detail}`,
      { fatal: last instanceof ObsConnectionError ? last.fatal : false, closeCode: last instanceof ObsConnectionError ? last.closeCode : undefined },
    );
  }

  private connectOnce(): Promise<void> {
    this.connectAttempts += 1;
    const generation = ++this.generation;
    return new Promise((resolve, reject) => {
      if (typeof WebSocket !== "function") {
        reject(new ObsConnectionError("This Node runtime has no global WebSocket. Node 22 or newer is required."));
        return;
      }
      let settled = false;
      const fail = (error: Error) => {
        if (settled || generation !== this.generation) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      };
      const succeed = () => {
        if (settled || generation !== this.generation) return;
        settled = true;
        clearTimeout(timer);
        this.ready = true;
        console.error(`obs-mcp: connected to ${safeUrl(this.url)}`);
        resolve();
      };
      const timer = setTimeout(() => {
        fail(new ObsConnectionError(`Timed out opening OBS WebSocket ${this.url}`));
      }, this.handshakeTimeoutMs);

      let socket: WebSocket;
      try {
        socket = new WebSocket(this.url, ["obswebsocket.json"]);
      } catch (error) {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new ObsConnectionError(String(error)));
        return;
      }
      this.socket = socket;

      socket.addEventListener("error", () => {
        // Close usually follows and carries the obs-websocket code. Falling back
        // immediately would hide 4009/4011 and retry an authentication failure.
        setTimeout(() => {
          fail(new ObsConnectionError(`WebSocket error connecting to ${this.url}`));
        }, 25);
      });
      socket.addEventListener("close", (event) => {
        if (generation !== this.generation) return;
        const code = typeof event.code === "number" ? event.code : 1006;
        const reason = typeof event.reason === "string" ? event.reason : "";
        if (!this.ready || !settled) {
          const fatal = FATAL_CLOSE_CODES.has(code);
          if (code === 4011) this.sessionInvalidated = true;
          fail(new ObsConnectionError(formatCloseError(code, reason), { closeCode: code, fatal }));
          return;
        }
        this.handleDisconnect(generation, code, reason);
      });
      socket.addEventListener("message", (event) => {
        if (generation !== this.generation) return;
        void websocketDataToString(event.data)
          .then((text) => {
            if (generation !== this.generation) return;
            let message: { op?: number; d?: Record<string, unknown> };
            try {
              message = JSON.parse(text) as { op?: number; d?: Record<string, unknown> };
            } catch {
              fail(new ObsConnectionError("OBS sent a message that is not JSON"));
              return;
            }
            this.onMessage(message, succeed, fail);
          })
          .catch((error: unknown) => {
            fail(error instanceof Error ? error : new ObsConnectionError(String(error)));
          });
      });
    });
  }

  private onMessage(
    message: { op?: number; d?: Record<string, unknown> },
    succeed: () => void,
    fail: (error: Error) => void,
  ): void {
    const op = message.op;
    const data = message.d ?? {};
    if (!this.ready && op === OpCode.Hello) {
      this.sendIdentify(data as HelloMessage, fail);
      return;
    }
    if (!this.ready && op === OpCode.Identified) {
      const negotiated = data.negotiatedRpcVersion;
      if (negotiated !== RPC_VERSION) {
        fail(new ObsConnectionError(`OBS negotiated rpcVersion ${String(negotiated)}. This server supports rpcVersion ${RPC_VERSION}.`, { fatal: true, closeCode: 4010 }));
        return;
      }
      succeed();
      return;
    }
    if (op === OpCode.Event) return;
    if (op === OpCode.RequestResponse || op === OpCode.RequestBatchResponse) {
      const requestId = typeof data.requestId === "string" ? data.requestId : "";
      const pending = this.pending.get(requestId);
      if (!pending || pending.expectedOp !== op) return;
      clearTimeout(pending.timer);
      this.pending.delete(requestId);
      pending.resolve(data);
    }
  }

  private sendIdentify(hello: HelloMessage, fail: (error: Error) => void): void {
    if (hello.rpcVersion == null || hello.rpcVersion < RPC_VERSION) {
      fail(new ObsConnectionError(`OBS rpcVersion ${String(hello.rpcVersion)} is older than supported rpcVersion ${RPC_VERSION}.`, { fatal: true, closeCode: 4010 }));
      return;
    }
    const identify: Record<string, unknown> = {
      rpcVersion: RPC_VERSION,
      eventSubscriptions: EVENT_SUBSCRIPTION_NONE,
    };
    const auth = hello.authentication;
    if (auth) {
      if (!this.password) {
        fail(new ObsConnectionError("OBS requires a password. Set OBS_WS_PASSWORD.", { fatal: true, closeCode: 4009 }));
        return;
      }
      if (typeof auth.challenge !== "string" || typeof auth.salt !== "string") {
        fail(new ObsConnectionError("OBS Hello authentication object is missing challenge or salt.", { fatal: true, closeCode: 4003 }));
        return;
      }
      identify.authentication = createAuthenticationString(this.password, auth.salt, auth.challenge);
    }
    try {
      this.send({ op: OpCode.Identify, d: identify });
    } catch (error) {
      fail(error instanceof Error ? error : new ObsConnectionError(String(error)));
    }
  }

  private handleDisconnect(generation: number, code: number, reason: string): void {
    if (generation !== this.generation) return;
    this.ready = false;
    if (code === 4011) this.sessionInvalidated = true;
    const fatal = FATAL_CLOSE_CODES.has(code);
    this.rejectPending(new ObsConnectionError(formatCloseError(code, reason), { closeCode: code, fatal }));
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private abandonSocket(): void {
    const socket = this.socket;
    this.socket = null;
    this.ready = false;
    if (!socket) return;
    try {
      socket.close();
    } catch {
      // The socket is already closing.
    }
  }

  private send(payload: unknown): void {
    if (!this.socket || this.socket.readyState !== WS_OPEN) {
      throw new ObsConnectionError("OBS connection is not open");
    }
    this.socket.send(JSON.stringify(payload));
  }
}

function readStatus(response: Record<string, unknown>): { result: boolean; code: number; comment?: string } {
  const status = response.requestStatus;
  if (!status || typeof status !== "object") {
    return { result: false, code: 0, comment: "missing requestStatus" };
  }
  const record = status as Record<string, unknown>;
  return {
    result: record.result === true,
    code: typeof record.code === "number" ? record.code : 0,
    comment: typeof record.comment === "string" ? record.comment : undefined,
  };
}

async function websocketDataToString(data: unknown): Promise<string> {
  if (typeof data === "string") return data;
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(data)) return data.toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  }
  if (data && typeof (data as { text?: () => Promise<string> }).text === "function") {
    return (data as { text: () => Promise<string> }).text();
  }
  return String(data);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return "ws://redacted";
  }
}
