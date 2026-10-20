// Zero-dependency receiver for X Activity API webhook deliveries (broadcast.chat).
// Per docs.x.com (x-api/webhooks/quickstart, checked 2026-10-18):
// - CRC: GET <url>?crc_token=... -> 200 {"response_token": "sha256=" + base64(HMAC-SHA256(secret, crc_token))}.
// - POST signature: "x-twitter-webhooks-signature-oauth2" (OAuth 2.0 client secret, recommended) or the
//   legacy "x-twitter-webhooks-signature" (OAuth 1.0 consumer secret). Both are "sha256=" + base64 HMAC-SHA256
//   over the raw body bytes.
// Secrets come only from env and are never logged or echoed.
import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { ChatEvent } from "../events.ts";

export const X_WEBHOOK_ENV = {
  clientSecret: "X_CLIENT_SECRET",
  consumerSecret: "X_CONSUMER_SECRET",
  host: "X_WEBHOOK_HOST",
  port: "X_WEBHOOK_PORT",
  path: "X_WEBHOOK_PATH",
} as const;
export const X_WEBHOOK_DEFAULTS = { host: "127.0.0.1", port: 8787, path: "/x/webhook" } as const;
export const X_SIGNATURE_HEADERS = { oauth2: "x-twitter-webhooks-signature-oauth2", legacy: "x-twitter-webhooks-signature" } as const;
const MAX_BODY_BYTES = 1024 * 1024;

export type XWebhookSecrets = { clientSecret?: string; consumerSecret?: string };
export type XWebhookConfig = XWebhookSecrets & { host: string; port: number; path: string };

export function xWebhookConfigFromEnv(env: NodeJS.ProcessEnv): XWebhookConfig {
  const clientSecret = env[X_WEBHOOK_ENV.clientSecret] || undefined;
  const consumerSecret = env[X_WEBHOOK_ENV.consumerSecret] || undefined;
  if (!clientSecret && !consumerSecret) {
    throw new Error(`Set ${X_WEBHOOK_ENV.clientSecret} (OAuth 2.0 client secret, recommended) or ${X_WEBHOOK_ENV.consumerSecret} (OAuth 1.0 consumer secret). The receiver cannot answer CRC or verify signatures without one.`);
  }
  const rawPort = env[X_WEBHOOK_ENV.port];
  const port = rawPort ? Number(rawPort) : X_WEBHOOK_DEFAULTS.port;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${X_WEBHOOK_ENV.port} must be a port number`);
  const path = env[X_WEBHOOK_ENV.path] || X_WEBHOOK_DEFAULTS.path;
  if (!path.startsWith("/")) throw new Error(`${X_WEBHOOK_ENV.path} must start with /`);
  return { clientSecret, consumerSecret, host: env[X_WEBHOOK_ENV.host] || X_WEBHOOK_DEFAULTS.host, port, path };
}

export function xWebhookSign(secret: string, message: string | Buffer): string {
  return `sha256=${createHmac("sha256", secret).update(message).digest("base64")}`;
}

/** CRC response token. Uses the OAuth 2.0 client secret when set, else the OAuth 1.0 consumer secret (docs order). */
export function xCrcResponse(crcToken: string, secrets: XWebhookSecrets): { response_token: string } {
  const secret = secrets.clientSecret ?? secrets.consumerSecret;
  if (!secret) throw new Error("no webhook secret configured");
  return { response_token: xWebhookSign(secret, crcToken) };
}

/** True when the raw body carries a valid X signature. Prefers the OAuth2 header, falls back to the legacy one. */
export function verifyXWebhookSignature(rawBody: Buffer, headers: IncomingMessage["headers"], secrets: XWebhookSecrets): boolean {
  const oauth2 = headerValue(headers[X_SIGNATURE_HEADERS.oauth2]);
  if (oauth2 !== undefined && secrets.clientSecret) return safeEqual(xWebhookSign(secrets.clientSecret, rawBody), oauth2);
  const legacy = headerValue(headers[X_SIGNATURE_HEADERS.legacy]);
  if (legacy !== undefined && secrets.consumerSecret) return safeEqual(xWebhookSign(secrets.consumerSecret, rawBody), legacy);
  return false;
}

export type XWebhookSink = { ingest: (delivery: unknown) => Promise<ChatEvent[]>; stopped?: boolean };

export type XWebhookServerOptions = {
  config: XWebhookConfig;
  sink: XWebhookSink;
  /** Called with every pipeline event (JSON feed line writer). */
  onEvent: (event: ChatEvent) => void;
  /** Diagnostics; never receives secrets or bodies. */
  log?: (line: string) => void;
};

export type XWebhookServer = { server: Server; listen: () => Promise<{ host: string; port: number }>; close: () => Promise<void>; idle: () => Promise<void> };

export function createXWebhookServer(options: XWebhookServerOptions): XWebhookServer {
  const { config, sink, onEvent } = options;
  const log = options.log ?? (() => {});
  let queue: Promise<void> = Promise.resolve();
  const enqueue = (deliveries: unknown[]) => {
    queue = queue.then(async () => {
      for (const delivery of deliveries) {
        try {
          for (const event of await sink.ingest(delivery)) onEvent(event);
        } catch (error) {
          log(`x-webhook: event dropped: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    });
  };
  const server = createServer((req, res) => {
    handle(req, res).catch(() => reply(res, 500, "error"));
  });
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== config.path) return reply(res, 404, "not found");
    if (req.method === "GET") {
      const crc = url.searchParams.get("crc_token");
      if (!crc) return reply(res, 400, "missing crc_token");
      log("x-webhook: answered CRC");
      return reply(res, 200, JSON.stringify(xCrcResponse(crc, config)), "application/json");
    }
    if (req.method !== "POST") return reply(res, 405, "method not allowed");
    const body = await readBody(req);
    if (body === undefined) return reply(res, 413, "too large");
    if (!verifyXWebhookSignature(body, req.headers, config)) {
      log("x-webhook: rejected POST with a missing or bad signature");
      return reply(res, 401, "invalid signature");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString("utf8"));
    } catch {
      return reply(res, 400, "invalid json");
    }
    // Answer fast; X retries slow endpoints. Events are processed in order afterwards.
    reply(res, 200, "");
    if (!sink.stopped) enqueue(Array.isArray(parsed) ? parsed : [parsed]);
  }
  return {
    server,
    listen: () => new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.port, config.host, () => {
        const address = server.address();
        resolve({ host: config.host, port: typeof address === "object" && address ? address.port : config.port });
      });
    }),
    close: () => new Promise((resolve) => server.close(() => resolve())),
    idle: () => queue,
  };
}

function readBody(req: IncomingMessage): Promise<Buffer | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) tooLarge = true;
      else chunks.push(chunk);
    });
    req.on("end", () => resolve(tooLarge ? undefined : Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function reply(res: ServerResponse, status: number, body: string, type = "text/plain"): void {
  if (res.headersSent) return;
  res.writeHead(status, { "content-type": type });
  res.end(body);
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
