export const PLATFORMS = ["twitch", "youtube", "kick", "x"] as const;

export type Platform = (typeof PLATFORMS)[number];

export type ChatKind = "message" | "mention" | "reply" | "system";

export type ChatEvent = {
  platform: Platform;
  user: string;
  text: string;
  kind: ChatKind;
  ts: string;
  privileged?: boolean;
  /** Platform message id, when the platform gives one. Used for dedupe. */
  id?: string;
  /** Feed alias of ts. X events set both; ts stays for older code. */
  time?: string;
  /** Feed alias of id. X events set both; id stays for older code. */
  post_id?: string;
  /** Where the event came from, for example mention, reply, search, hashtag. */
  source?: string;
  /** Known author badges, for example verified or follower. Empty when unknown. */
  badges?: string[];
  /** Platform author id, when known. */
  author_id?: string;
};

const KINDS = new Set<ChatKind>(["message", "mention", "reply", "system"]);

export function parseChatEvent(value: unknown): ChatEvent {
  if (!value || typeof value !== "object") throw new Error("Chat event must be an object");
  const record = value as Record<string, unknown>;
  if (!PLATFORMS.includes(record.platform as Platform)) throw new Error("Chat event platform is not supported");
  if (typeof record.user !== "string" || record.user.length === 0) throw new Error("Chat event user is required");
  if (typeof record.text !== "string") throw new Error("Chat event text is required");
  if (!KINDS.has(record.kind as ChatKind)) throw new Error("Chat event kind is not supported");
  if (typeof record.ts !== "string" || Number.isNaN(Date.parse(record.ts))) throw new Error("Chat event ts must be an ISO time");
  return {
    platform: record.platform as Platform,
    user: record.user,
    text: record.text,
    kind: record.kind as ChatKind,
    ts: record.ts,
    privileged: record.privileged === true,
    ...(typeof record.id === "string" && record.id.length > 0 ? { id: record.id } : {}),
    ...(typeof record.time === "string" ? { time: record.time } : {}),
    ...(typeof record.post_id === "string" && record.post_id.length > 0 ? { post_id: record.post_id } : {}),
    ...(typeof record.source === "string" ? { source: record.source } : {}),
    ...(Array.isArray(record.badges) ? { badges: record.badges.filter((b): b is string => typeof b === "string") } : {}),
  };
}
