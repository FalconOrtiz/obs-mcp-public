import type { ChatEvent } from "../events.ts";
import { BOT_DISCLOSURE } from "../bot.ts";
import { RateLimiter, type PlatformLimit } from "../ratelimit.ts";

export const TWITCH_ENV = {
  clientId: "TWITCH_CLIENT_ID",
  accessToken: "TWITCH_ACCESS_TOKEN",
  botUserId: "TWITCH_BOT_USER_ID",
  broadcasterId: "TWITCH_BROADCASTER_ID",
} as const;

export const TWITCH_EVENTSUB_URL = "wss://eventsub.wss.twitch.tv/ws";
export const TWITCH_SUBSCRIBE_URL = "https://api.twitch.tv/helix/eventsub/subscriptions";
export const TWITCH_CHAT_URL = "https://api.twitch.tv/helix/chat/messages";

/** Send Chat Message limit for a normal chatter. */
export const TWITCH_SEND_LIMIT: PlatformLimit = { capacity: 20, perMs: 30_000 };

export const TWITCH_MESSAGE_MAX = 500;

const PRIVILEGED_BADGES = new Set(["broadcaster", "moderator"]);

export type TwitchReady = {
  sessionId: string;
  subscriptionId: string;
};

export type TwitchSendResult = {
  messageId: string;
  isSent: boolean;
  dropReason: string | null;
};

export type TwitchSocket = {
  addEventListener(type: string, listener: (event: { data?: unknown; code?: number }) => void): void;
  removeEventListener(type: string, listener: (event: { data?: unknown; code?: number }) => void): void;
  close(code?: number, reason?: string): void;
};

export type TwitchEventSubOptions = {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  socketFactory?: (url: string) => TwitchSocket;
  url?: string;
  onEvent: (event: ChatEvent) => void;
  onRevocation?: (status: string) => void;
  handshakeTimeoutMs?: number;
  subscribeTimeoutMs?: number;
  sendLimit?: PlatformLimit;
};

type Handshake = {
  resolve: (value: TwitchReady) => void;
  reject: (error: Error) => void;
};

export function twitchSubscriptionBody(sessionId: string, broadcasterUserId: string, botUserId: string): Record<string, unknown> {
  return {
    type: "channel.chat.message",
    version: "1",
    condition: {
      broadcaster_user_id: broadcasterUserId,
      user_id: botUserId,
    },
    transport: {
      method: "websocket",
      session_id: sessionId,
    },
  };
}

export function twitchChatEvent(frame: unknown, botUserId: string): ChatEvent | undefined {
  if (!frame || typeof frame !== "object") return undefined;
  const record = frame as Record<string, unknown>;
  const metadata = asRecord(record.metadata);
  const payload = asRecord(record.payload);
  if (!metadata || !payload) return undefined;
  if (metadata.message_type !== "notification") return undefined;
  if (metadata.subscription_type !== "channel.chat.message") return undefined;
  const event = asRecord(payload.event);
  if (!event) return undefined;
  const message = asRecord(event.message);
  const text = message && typeof message.text === "string" ? message.text : undefined;
  const user = typeof event.chatter_user_login === "string" ? event.chatter_user_login : undefined;
  const chatterId = typeof event.chatter_user_id === "string" ? event.chatter_user_id : undefined;
  const ts = typeof metadata.message_timestamp === "string" ? metadata.message_timestamp : undefined;
  if (!text || !user || !chatterId || !ts || Number.isNaN(Date.parse(ts))) return undefined;
  if (chatterId === botUserId) return undefined;
  const privileged = isPrivileged(event);
  const kind = event.reply && typeof event.reply === "object" ? "reply" : "message";
  return { platform: "twitch", user, text, kind, ts, privileged };
}

export async function sendTwitchChat(
  message: string,
  options: {
    env?: NodeJS.ProcessEnv;
    fetchImpl?: typeof fetch;
    limiter?: RateLimiter;
    now?: number;
  } = {},
): Promise<TwitchSendResult> {
  if (!message.includes(BOT_DISCLOSURE)) throw new Error("Twitch chat must identify as a bot");
  if ([...message].length > TWITCH_MESSAGE_MAX) throw new Error(`Twitch chat is limited to ${TWITCH_MESSAGE_MAX} characters`);
  const env = options.env ?? process.env;
  const clientId = readEnv(env, TWITCH_ENV.clientId);
  const accessToken = readEnv(env, TWITCH_ENV.accessToken);
  const botUserId = readEnv(env, TWITCH_ENV.botUserId);
  const broadcasterId = readEnv(env, TWITCH_ENV.broadcasterId);
  const limiter = options.limiter ?? sharedSendLimiter;
  if (!limiter.tryTake("twitch", options.now ?? Date.now())) {
    return { messageId: "", isSent: false, dropReason: "local_rate_limit" };
  }
  const response = await (options.fetchImpl ?? fetch)(TWITCH_CHAT_URL, {
    method: "POST",
    headers: twitchHeaders(clientId, accessToken),
    body: JSON.stringify({
      broadcaster_id: broadcasterId,
      sender_id: botUserId,
      message,
    }),
  });
  if (!response.ok) throw new Error(`Twitch chat send failed (${response.status})`);
  const body = await response.json() as { data?: Array<{ message_id?: string; is_sent?: boolean; drop_reason?: { code?: string } | null }> };
  const row = body.data?.[0];
  if (!row || typeof row.message_id !== "string" || typeof row.is_sent !== "boolean") {
    throw new Error("Twitch chat send returned an unexpected body");
  }
  return {
    messageId: row.message_id,
    isSent: row.is_sent,
    dropReason: row.drop_reason?.code ?? null,
  };
}

export class TwitchEventSubClient {
  private socket: TwitchSocket | null = null;
  private handshake: Handshake | null = null;
  private handshakeTimer: ReturnType<typeof setTimeout> | undefined;
  private subscribeTimer: ReturnType<typeof setTimeout> | undefined;
  private subscribeAbort: AbortController | null = null;
  private stopped = false;
  private subscribed = false;
  private sessionId = "";
  private botUserId = "";
  private readonly seen = new Set<string>();
  private readonly options: TwitchEventSubOptions;
  private readonly env: NodeJS.ProcessEnv;
  private readonly fetchImpl: typeof fetch;
  private readonly socketFactory: (url: string) => TwitchSocket;
  private readonly limiter: RateLimiter;

  constructor(options: TwitchEventSubOptions) {
    this.options = options;
    this.env = options.env ?? process.env;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.socketFactory = options.socketFactory ?? ((url) => new WebSocket(url));
    this.limiter = new RateLimiter({
      twitch: options.sendLimit ?? TWITCH_SEND_LIMIT,
      youtube: { capacity: 1, perMs: 60_000 },
      kick: { capacity: 1, perMs: 60_000 },
      x: { capacity: 1, perMs: 60_000 },
    });
  }

  start(): Promise<TwitchReady> {
    if (this.handshake || this.subscribed) throw new Error("Twitch EventSub is already started");
    return new Promise((resolve, reject) => {
      this.handshake = { resolve, reject };
      this.handshakeTimer = setTimeout(() => {
        this.fail(new Error("Twitch EventSub welcome was not received"));
      }, this.options.handshakeTimeoutMs ?? 15_000);
      this.open(this.options.url ?? TWITCH_EVENTSUB_URL, true);
    });
  }

  async send(message: string, now = Date.now()): Promise<TwitchSendResult> {
    return sendTwitchChat(message, { env: this.env, fetchImpl: this.fetchImpl, limiter: this.limiter, now });
  }

  close(): void {
    this.stopped = true;
    this.clearSubscribeTimer();
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    this.subscribeAbort?.abort();
    this.socket?.close();
    this.socket = null;
    this.fail(new Error("Twitch EventSub stopped"));
  }

  private open(url: string, needsSubscription: boolean): void {
    const socket = this.socketFactory(url);
    const previous = needsSubscription ? null : this.socket;
    this.socket = socket;
    const onMessage = (event: { data?: unknown }) => {
      this.onFrame(socket, frameText(event.data), needsSubscription, previous);
    };
    const onClose = () => {
      if (this.socket === socket && !this.stopped && this.handshake) {
        this.fail(new Error("Twitch EventSub connection closed"));
      }
    };
    socket.addEventListener("message", onMessage);
    socket.addEventListener("close", onClose);
  }

  private onFrame(socket: TwitchSocket, text: string, needsSubscription: boolean, previous: TwitchSocket | null): void {
    if (this.stopped || this.socket !== socket) return;
    let frame: Record<string, unknown>;
    try {
      const parsed = JSON.parse(text) as unknown;
      if (!parsed || typeof parsed !== "object") return;
      frame = parsed as Record<string, unknown>;
    } catch {
      return;
    }
    const metadata = asRecord(frame.metadata);
    const messageType = metadata?.message_type;
    if (messageType === "session_welcome") {
      const session = asRecord(asRecord(frame.payload)?.session);
      const sessionId = typeof session?.id === "string" ? session.id : "";
      if (!sessionId) {
        this.fail(new Error("Twitch EventSub welcome did not include a session id"));
        return;
      }
      this.sessionId = sessionId;
      if (previous) previous.close();
      if (needsSubscription && !this.subscribed) {
        const seconds = typeof session?.keepalive_timeout_seconds === "number" ? session.keepalive_timeout_seconds : 10;
        this.armSubscribe(sessionId, seconds);
      }
      return;
    }
    if (messageType === "session_reconnect") {
      const reconnectUrl = asRecord(asRecord(frame.payload)?.session)?.reconnect_url;
      if (typeof reconnectUrl !== "string" || reconnectUrl.length === 0) {
        this.fail(new Error("Twitch EventSub reconnect did not include a URL"));
        return;
      }
      this.open(reconnectUrl, false);
      return;
    }
    if (messageType === "revocation") {
      const status = asRecord(asRecord(frame.payload)?.subscription)?.status;
      this.options.onRevocation?.(typeof status === "string" ? status : "revoked");
      return;
    }
    if (messageType !== "notification") return;
    const messageId = typeof metadata?.message_id === "string" ? metadata.message_id : "";
    if (messageId && this.seen.has(messageId)) return;
    if (messageId) this.seen.add(messageId);
    if (!this.botUserId) return;
    const event = twitchChatEvent(frame, this.botUserId);
    if (event) this.options.onEvent(event);
  }

  private armSubscribe(sessionId: string, keepaliveSeconds: number): void {
    this.clearSubscribeTimer();
    const timeoutMs = this.options.subscribeTimeoutMs ?? keepaliveSeconds * 1000;
    this.subscribeAbort = new AbortController();
    this.subscribeTimer = setTimeout(() => {
      this.subscribeAbort?.abort();
      this.fail(new Error("Twitch EventSub subscribe window expired"));
    }, timeoutMs);
    void this.subscribe(sessionId);
  }

  private async subscribe(sessionId: string): Promise<void> {
    try {
      const clientId = readEnv(this.env, TWITCH_ENV.clientId);
      const accessToken = readEnv(this.env, TWITCH_ENV.accessToken);
      const botUserId = readEnv(this.env, TWITCH_ENV.botUserId);
      const broadcasterId = readEnv(this.env, TWITCH_ENV.broadcasterId);
      this.botUserId = botUserId;
      const response = await this.fetchImpl(TWITCH_SUBSCRIBE_URL, {
        method: "POST",
        signal: this.subscribeAbort?.signal,
        headers: twitchHeaders(clientId, accessToken),
        body: JSON.stringify(twitchSubscriptionBody(sessionId, broadcasterId, botUserId)),
      });
      if (!response.ok) throw new Error(`Twitch EventSub subscribe failed (${response.status})`);
      const body = await response.json() as { data?: Array<{ id?: string }> };
      const subscriptionId = body.data?.[0]?.id;
      if (typeof subscriptionId !== "string" || subscriptionId.length === 0) {
        throw new Error("Twitch EventSub subscribe returned no subscription id");
      }
      this.clearSubscribeTimer();
      this.subscribed = true;
      if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
      const pending = this.handshake;
      this.handshake = null;
      pending?.resolve({ sessionId, subscriptionId });
    } catch (error) {
      if (this.stopped || this.subscribeAbort?.signal.aborted) return;
      const message = error instanceof Error ? error.message : "Twitch EventSub subscribe failed";
      this.fail(new Error(message));
    }
  }

  private fail(error: Error): void {
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    this.clearSubscribeTimer();
    const pending = this.handshake;
    this.handshake = null;
    pending?.reject(error);
  }

  private clearSubscribeTimer(): void {
    if (this.subscribeTimer) clearTimeout(this.subscribeTimer);
    this.subscribeTimer = undefined;
  }
}

function defaultSendLimiter(): RateLimiter {
  return new RateLimiter({
    twitch: TWITCH_SEND_LIMIT,
    youtube: { capacity: 1, perMs: 60_000 },
    kick: { capacity: 1, perMs: 60_000 },
    x: { capacity: 1, perMs: 60_000 },
  });
}

const sharedSendLimiter = defaultSendLimiter();

function twitchHeaders(clientId: string, accessToken: string): Record<string, string> {
  return {
    authorization: `Bearer ${accessToken}`,
    "client-id": clientId,
    "content-type": "application/json",
  };
}

function readEnv(env: NodeJS.ProcessEnv, name: string): string {
  const raw = env[name];
  if (raw == null || raw.length === 0 || raw === `\${${name}}` || raw === `\${env:${name}}`) {
    throw new Error(`${name} is not set`);
  }
  return raw;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function isPrivileged(event: Record<string, unknown>): boolean {
  if (event.chatter_user_id && event.chatter_user_id === event.broadcaster_user_id) return true;
  if (!Array.isArray(event.badges)) return false;
  return event.badges.some((badge) => {
    if (!badge || typeof badge !== "object") return false;
    const setId = (badge as Record<string, unknown>).set_id;
    return typeof setId === "string" && PRIVILEGED_BADGES.has(setId);
  });
}

function frameText(data: unknown): string {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  return "";
}
