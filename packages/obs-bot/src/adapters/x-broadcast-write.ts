// X broadcast chat write tools: send, mute, delete. Every call defaults to
// dry_run. A live call needs both X_BOT_TOKEN (the bot's bearer token, read
// only from env) and X_CHAT_WRITE=1. The token never appears in any output or
// error. Mute and delete need the bot to be the broadcast host or a moderator
// (POST /2/broadcasts/chat/moderators, done by the owner).

export const X_WRITE_ENV = { botToken: "X_BOT_TOKEN", chatWrite: "X_CHAT_WRITE" } as const;
const ORIGIN = "https://api.x.com";
const BROADCAST_ID = /^[a-zA-Z0-9]{1,13}$/;
const NUMERIC_ID = /^[1-9][0-9]{0,18}$/;
const REDACTED = "[REDACTED]";

export type XChatWriteRequest = { method: "POST" | "DELETE"; url: string; headers: { authorization: string; "content-type"?: string }; body?: Record<string, string> };
export type XChatWriteResult =
  | { dry_run: true; enabled: boolean; disabled_reason?: string; request: XChatWriteRequest }
  | { dry_run: false; status: number; data: unknown };

export type XChatWriteOptions = { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch; dryRun?: boolean };

export function xChatWriteGate(env: NodeJS.ProcessEnv): { enabled: boolean; reason?: string } {
  const token = env[X_WRITE_ENV.botToken];
  if (!token) return { enabled: false, reason: `${X_WRITE_ENV.botToken} is not set` };
  if (env[X_WRITE_ENV.chatWrite] !== "1") return { enabled: false, reason: `${X_WRITE_ENV.chatWrite} is not 1` };
  return { enabled: true };
}

export function xBroadcastChatSend(broadcastId: string, text: string, options: XChatWriteOptions & { replyTo?: string } = {}): Promise<XChatWriteResult> {
  checkBroadcast(broadcastId);
  if (typeof text !== "string" || text.length < 1 || text.length > 140) throw new Error("X chat text must be 1 to 140 characters");
  if (options.replyTo !== undefined && !/^[0-9]{1,19}$/.test(options.replyTo)) throw new Error("reply_to must be a numeric message id");
  return run("POST", `/2/broadcasts/${broadcastId}/chat`, { text, ...(options.replyTo ? { reply_to: options.replyTo } : {}) }, options);
}

export function xBroadcastChatMute(broadcastId: string, userId: string, options: XChatWriteOptions & { endAtMs?: string; messageId?: string } = {}): Promise<XChatWriteResult> {
  checkBroadcast(broadcastId);
  if (!NUMERIC_ID.test(userId)) throw new Error("user_id must be a numeric user id");
  for (const [name, value] of [["end_at_ms", options.endAtMs], ["message_id", options.messageId]] as const) {
    if (value !== undefined && !NUMERIC_ID.test(value)) throw new Error(`${name} must be numeric`);
  }
  return run("POST", `/2/broadcasts/${broadcastId}/chat/mutes`, {
    user_id: userId,
    ...(options.endAtMs ? { end_at_ms: options.endAtMs } : {}),
    ...(options.messageId ? { message_id: options.messageId } : {}),
  }, options);
}

export function xBroadcastChatDelete(broadcastId: string, messageId: string, options: XChatWriteOptions = {}): Promise<XChatWriteResult> {
  checkBroadcast(broadcastId);
  if (!/^[0-9]{1,19}$/.test(messageId)) throw new Error("message_id must be a numeric message id");
  return run("DELETE", `/2/broadcasts/${broadcastId}/chat/${messageId}`, undefined, options);
}

async function run(method: "POST" | "DELETE", pathname: string, body: Record<string, string> | undefined, options: XChatWriteOptions): Promise<XChatWriteResult> {
  const env = options.env ?? process.env;
  const gate = xChatWriteGate(env);
  const preview: XChatWriteRequest = {
    method,
    url: new URL(pathname, ORIGIN).toString(),
    headers: { authorization: `Bearer ${REDACTED}`, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body } : {}),
  };
  if (options.dryRun !== false) return { dry_run: true, enabled: gate.enabled, ...(gate.reason ? { disabled_reason: gate.reason } : {}), request: preview };
  if (!gate.enabled) throw new Error(`X chat write is disabled: ${gate.reason}. Set ${X_WRITE_ENV.botToken} and ${X_WRITE_ENV.chatWrite}=1.`);
  const token = env[X_WRITE_ENV.botToken] as string;
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(preview.url, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch (error) {
    throw new Error(`X chat ${method} failed: ${scrub(error instanceof Error ? error.message : String(error), token)}`);
  }
  const raw = await response.text();
  if (!response.ok) throw new Error(`X chat ${method} ${pathname} failed (${response.status}): ${scrub(raw.slice(0, 300), token)}`);
  let data: unknown = null;
  try {
    data = raw ? JSON.parse(scrub(raw, token)) : null;
  } catch {
    data = scrub(raw, token);
  }
  return { dry_run: false, status: response.status, data };
}

function checkBroadcast(id: string): void {
  if (!BROADCAST_ID.test(id)) throw new Error("broadcast id must be 1 to 13 letters or digits");
}

function scrub(text: string, token: string): string {
  return token ? text.split(token).join(REDACTED) : text;
}
