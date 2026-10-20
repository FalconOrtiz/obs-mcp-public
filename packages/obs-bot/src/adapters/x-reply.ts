// Reply to an X post via POST /2/tweets {text, reply: {in_reply_to_tweet_id, exclude_reply_user_ids}}. Defaults to dry_run.
// X auto-mentions everyone in the thread. Pass targetAuthorId and mentionedUserIds so the reply tags only the
// person it answers: every other auto-mentioned user goes into exclude_reply_user_ids (or pass excludeReplyUserIds).
// X bot (Automated) accounts can only reply to posts that @mention them or that they wrote.
// A live post needs X_REPLY_WRITE=1, a write-capable token, and a per-reply approval: the caller must
// pass back the approval_id from the dry-run preview of exactly this text and post id, after the owner
// approved it. Cost (docs.x.com pricing: $0.015, $0.200 with a URL) is reserved against the stream cap first.
import { createHash } from "node:crypto";
import { X_PRICE_USD } from "./x.ts";

export const X_REPLY_ENV = {
  replyWrite: "X_REPLY_WRITE",
  replyAs: "X_REPLY_AS",
  userAccessToken: "X_USER_ACCESS_TOKEN",
  botUserAccessToken: "X_BOT_USER_ACCESS_TOKEN",
  botToken: "X_BOT_TOKEN",
} as const;
// Spec v2.172: POST /2/tweets needs OAuth2UserToken [tweet.read, tweet.write, users.read] (or OAuth 1.0a user).
// Bots API: an xcbot_ token's scopes are a subset of dm.read, dm.write, tweet.read, users.read, media.write
// (plus broadcast.read/write); asking for anything else is a 400. So X_BOT_TOKEN can never post.
const URL_RE = /https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|io|co|ly|gg|tv|me|app|dev)\b/i;

export type XReplyPreview = {
  dry_run: true;
  enabled: boolean;
  disabled_reason?: string;
  approval_id: string;
  cost_usd: number;
  request: { method: "POST"; url: string; headers: { authorization: string; "content-type": string }; body: XReplyBody };
};
export type XReplyBody = { text: string; reply: { in_reply_to_tweet_id: string; exclude_reply_user_ids?: string[] } };
export type XReplyResult = XReplyPreview | { dry_run: false; status: number; post_id?: string; cost_usd: number };
export type XReplyBudget = { reserveUsd: (amount: number) => boolean; remainingUsd: () => number | undefined };
export type XReplyOptions = { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch; dryRun?: boolean; approvalId?: string; budget?: XReplyBudget; targetAuthorId?: string; mentionedUserIds?: string[]; excludeReplyUserIds?: string[] };

export function xReplyCostUsd(text: string): number {
  return URL_RE.test(text) ? X_PRICE_USD.postCreateWithUrl : X_PRICE_USD.postCreate;
}

export function xReplyApprovalId(inReplyTo: string, text: string, exclude: string[] = []): string {
  const extra = exclude.length ? `\n${exclude.join(",")}` : "";
  return createHash("sha256").update(`${inReplyTo}\n${text}${extra}`).digest("hex").slice(0, 16);
}

// Users to drop from X's auto-mentions: explicit list if given, else every mentioned user except the target author.
export function xReplyExcludeIds(options: Pick<XReplyOptions, "targetAuthorId" | "mentionedUserIds" | "excludeReplyUserIds">): string[] {
  const raw = options.excludeReplyUserIds ?? (options.mentionedUserIds ?? []).filter((id) => id !== options.targetAuthorId);
  const ids = [...new Set(raw.map(String))];
  for (const id of ids) if (!/^[0-9]{1,19}$/.test(id)) throw new Error("exclude_reply_user_ids must be numeric user ids");
  return ids.sort();
}

function replyToken(env: NodeJS.ProcessEnv): { name: string; token?: string } {
  const as = env[X_REPLY_ENV.replyAs] || "user";
  if (as === "bot") {
    throw new Error(`${X_REPLY_ENV.replyAs}=bot is not possible: ${X_REPLY_ENV.botToken} (xcbot_) tokens cannot carry tweet.write. Use ${X_REPLY_ENV.replyAs}=bot_account with ${X_REPLY_ENV.botUserAccessToken}, or user.`);
  }
  if (as !== "user" && as !== "bot_account") throw new Error(`${X_REPLY_ENV.replyAs} must be user or bot_account`);
  const name = as === "bot_account" ? X_REPLY_ENV.botUserAccessToken : X_REPLY_ENV.userAccessToken;
  return { name, token: env[name] || undefined };
}

export function xReplyGate(env: NodeJS.ProcessEnv): { enabled: boolean; reason?: string } {
  const { name, token } = replyToken(env);
  if (!token) return { enabled: false, reason: `${name} is not set` };
  if (env[X_REPLY_ENV.replyWrite] !== "1") return { enabled: false, reason: `${X_REPLY_ENV.replyWrite} is not 1` };
  return { enabled: true };
}

export async function xReplyPost(inReplyTo: string, text: string, options: XReplyOptions = {}): Promise<XReplyResult> {
  if (!/^[0-9]{1,19}$/.test(inReplyTo)) throw new Error("in_reply_to must be a numeric post id");
  if (typeof text !== "string" || text.trim() === "" || [...text].length > 280) throw new Error("reply text must be 1 to 280 characters");
  const env = options.env ?? process.env;
  const gate = xReplyGate(env);
  const exclude = xReplyExcludeIds(options);
  const approvalId = xReplyApprovalId(inReplyTo, text, exclude);
  const cost = xReplyCostUsd(text);
  const body: XReplyBody = { text, reply: { in_reply_to_tweet_id: inReplyTo, ...(exclude.length ? { exclude_reply_user_ids: exclude } : {}) } };
  const url = "https://api.x.com/2/tweets";
  if (options.dryRun !== false) {
    return {
      dry_run: true, enabled: gate.enabled, ...(gate.reason ? { disabled_reason: gate.reason } : {}), approval_id: approvalId, cost_usd: cost,
      request: { method: "POST", url, headers: { authorization: "Bearer [REDACTED]", "content-type": "application/json" }, body },
    };
  }
  if (!gate.enabled) throw new Error(`X reply is disabled: ${gate.reason}.`);
  if (options.approvalId !== approvalId) throw new Error("X reply needs the owner's approval for this exact text and post: pass the approval_id from the dry-run preview.");
  if (!options.budget) throw new Error("X reply needs a budget (the stream poller) so its cost counts toward X_STREAM_CREDIT_CAP_USD.");
  if (!options.budget.reserveUsd(cost)) throw new Error(`X reply refused: $${cost.toFixed(3)} would exceed X_STREAM_CREDIT_CAP_USD ($${(options.budget.remainingUsd() ?? 0).toFixed(3)} left).`);
  const token = replyToken(env).token as string;
  const scrub = (value: string) => value.split(token).join("[REDACTED]");
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(url, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  } catch (error) {
    throw new Error(`X reply failed: ${scrub(error instanceof Error ? error.message : String(error))}`);
  }
  const raw = await response.text();
  if (!response.ok) {
    const hint = response.status === 403 ? " The token needs the tweet.write scope, and a bot account can only reply to posts that @mention it or that it wrote." : "";
    throw new Error(`X reply failed (${response.status}): ${scrub(raw.slice(0, 300))}${hint}`);
  }
  let postId: string | undefined;
  try {
    const id = (JSON.parse(raw) as { data?: { id?: unknown } }).data?.id;
    if (typeof id === "string") postId = id;
  } catch {
    // keep postId undefined
  }
  return { dry_run: false, status: response.status, ...(postId ? { post_id: postId } : {}), cost_usd: cost };
}
