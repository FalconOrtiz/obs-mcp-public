import { createVerify } from "node:crypto";
import type { ChatEvent } from "../events.ts";

export const KICK_PUBLIC_KEY_URL = "https://api.kick.com/public/v1/public-key";
export const KICK_CHAT_EVENT = "chat.message.sent";
export const KICK_MAX_SKEW_MS = 5 * 60 * 1000;

const PEM_HEADER = ["-----BEGIN", "PUBLIC KEY-----"].join(" ");

const PRIVILEGED_BADGES = new Set(["broadcaster", "moderator"]);

export type KickReceive = {
  event?: ChatEvent;
  duplicate: boolean;
  ignored: boolean;
};

export type KickWebhookOptions = {
  fetchImpl?: typeof fetch;
  publicKeyPem?: string;
  now?: () => number;
  maxSkewMs?: number;
};

export async function fetchKickPublicKey(fetchImpl: typeof fetch = fetch): Promise<string> {
  const response = await fetchImpl(KICK_PUBLIC_KEY_URL);
  if (!response.ok) throw new Error(`Kick public key fetch failed (${response.status})`);
  const text = (await response.text()).trim();
  if (text.startsWith("{")) {
    let body: { publicKey?: unknown };
    try {
      body = JSON.parse(text) as { publicKey?: unknown };
    } catch {
      throw new Error("Kick public key response did not include a PEM");
    }
    if (typeof body.publicKey !== "string" || !body.publicKey.includes(PEM_HEADER)) {
      throw new Error("Kick public key response did not include a PEM");
    }
    return body.publicKey;
  }
  if (text.startsWith(PEM_HEADER)) return text;
  throw new Error("Kick public key response did not include a PEM");
}

export function verifyKickSignature(input: {
  publicKeyPem: string;
  messageId: string;
  timestamp: string;
  rawBody: string;
  signature: string;
}): boolean {
  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${input.messageId}.${input.timestamp}.${input.rawBody}`);
  verifier.end();
  try {
    return verifier.verify(input.publicKeyPem, input.signature, "base64");
  } catch {
    return false;
  }
}

export class KickWebhooks {
  private publicKeyPem: string | undefined;
  private readonly seen = new Set<string>();
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly maxSkewMs: number;

  constructor(options: KickWebhookOptions = {}) {
    this.publicKeyPem = options.publicKeyPem;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.maxSkewMs = options.maxSkewMs ?? KICK_MAX_SKEW_MS;
  }

  async receive(headers: Record<string, string | undefined>, rawBody: string): Promise<KickReceive> {
    const messageId = header(headers, "Kick-Event-Message-Id");
    const timestamp = header(headers, "Kick-Event-Message-Timestamp");
    const signature = header(headers, "Kick-Event-Signature");
    const eventType = header(headers, "Kick-Event-Type");
    if (!messageId || !timestamp || !signature || !eventType) {
      throw new Error("Kick webhook is missing a required header");
    }
    const sentAt = Date.parse(timestamp);
    if (Number.isNaN(sentAt) || Math.abs(this.now() - sentAt) > this.maxSkewMs) {
      throw new Error("Kick webhook timestamp is outside the allowed window");
    }
    const publicKeyPem = await this.key();
    const valid = verifyKickSignature({ publicKeyPem, messageId, timestamp, rawBody, signature });
    if (!valid) throw new Error("Kick webhook signature was rejected");
    if (this.seen.has(messageId)) return { duplicate: true, ignored: false };
    this.seen.add(messageId);
    if (eventType !== KICK_CHAT_EVENT) return { duplicate: false, ignored: true };
    let body: unknown;
    try {
      body = JSON.parse(rawBody) as unknown;
    } catch {
      throw new Error("Kick webhook body is not JSON");
    }
    const event = kickChatEvent(body, timestamp);
    if (!event) return { duplicate: false, ignored: true };
    return { event, duplicate: false, ignored: false };
  }

  private async key(): Promise<string> {
    if (this.publicKeyPem) return this.publicKeyPem;
    this.publicKeyPem = await fetchKickPublicKey(this.fetchImpl);
    return this.publicKeyPem;
  }
}

export function kickChatEvent(body: unknown, fallbackTs: string): ChatEvent | undefined {
  const record = asRecord(body);
  const sender = asRecord(record?.sender);
  const broadcaster = asRecord(record?.broadcaster);
  if (!record || !sender) return undefined;
  if (sender.is_anonymous === true) return undefined;
  const user = typeof sender.username === "string" ? sender.username : undefined;
  const text = typeof record.content === "string" ? record.content : undefined;
  const created = typeof record.created_at === "string" ? record.created_at : fallbackTs;
  if (!user || !text || Number.isNaN(Date.parse(created))) return undefined;
  return {
    platform: "kick",
    user,
    text,
    kind: asRecord(record.replies_to) ? "reply" : "message",
    ts: created,
    privileged: isPrivileged(sender, broadcaster),
  };
}

function isPrivileged(sender: Record<string, unknown>, broadcaster: Record<string, unknown> | undefined): boolean {
  if (broadcaster && sender.user_id != null && broadcaster.user_id != null && String(sender.user_id) === String(broadcaster.user_id)) {
    return true;
  }
  const identity = asRecord(sender.identity);
  if (!identity || !Array.isArray(identity.badges)) return false;
  return identity.badges.some((badge) => {
    if (!badge || typeof badge !== "object") return false;
    const type = (badge as Record<string, unknown>).type;
    return typeof type === "string" && PRIVILEGED_BADGES.has(type);
  });
}

function header(headers: Record<string, string | undefined>, name: string): string {
  const direct = headers[name];
  if (typeof direct === "string" && direct.length > 0) return direct;
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower && typeof value === "string" && value.length > 0) return value;
  }
  return "";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}
