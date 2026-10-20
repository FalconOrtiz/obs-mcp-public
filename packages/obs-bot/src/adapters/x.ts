import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { BOT_DISCLOSURE } from "../bot.ts";
import type { ChatEvent } from "../events.ts";
import { DEFAULT_REPLY_LIMITS, RateLimiter, type PlatformLimit } from "../ratelimit.ts";
import { publishXDraft } from "./x-publish.ts";

export const X_ENV = {
  userAccessToken: "X_USER_ACCESS_TOKEN",
  bearerToken: "X_BEARER_TOKEN",
  userId: "X_USER_ID",
  draftDir: "X_DRAFT_DIR",
  maxReadsPerStream: "X_MAX_READS_PER_STREAM",
  streamCreditCapUsd: "X_STREAM_CREDIT_CAP_USD",
  creditCheckIntervalMs: "X_CREDIT_CHECK_INTERVAL_MS",
  livePostId: "X_LIVE_POST_ID",
  liveHashtag: "X_LIVE_HASHTAG",
  pollIntervalMs: "X_POLL_INTERVAL_MS",
  maxTicks: "X_MAX_TICKS",
  maxResults: "X_MAX_RESULTS",
  expandAuthors: "X_EXPAND_AUTHORS",
  audienceFilter: "X_AUDIENCE_FILTER",
  followersTtlMs: "X_FOLLOWERS_TTL_MS",
  followersMode: "X_FOLLOWERS_MODE",
  followStatusTtlMs: "X_FOLLOW_STATUS_TTL_MS",
  broadcastId: "X_BROADCAST_ID",
  liveChat: "X_LIVE_CHAT",
  secondarySources: "X_SECONDARY_SOURCES",
  broadcastCheckIntervalMs: "X_BROADCAST_CHECK_INTERVAL_MS",
  readMode: "X_READ_MODE",
} as const;

export const X_BROADCAST_CHECK_INTERVAL_DEFAULT_MS = 60_000;
const CHAT_MAX_RESULTS = { min: 1, max: 200 } as const;
const BROADCAST_ID = /^[a-zA-Z0-9]{1,13}$/;

export const X_FOLLOW_STATUS_TTL_DEFAULT_MS = 6 * 60 * 60 * 1000;

/** USD per resource, from docs.x.com pricing ("Credit consumption details"). */
// docs.x.com pricing, checked 2026-10-18. postCreateWithUrl applies when the text has a link.
export const X_PRICE_USD = { postRead: 0.005, userRead: 0.01, followerRead: 0.01, postCreate: 0.015, postCreateWithUrl: 0.2 } as const;
export const X_FOLLOWERS_TTL_DEFAULT_MS = 6 * 60 * 60 * 1000;
export const X_AUDIENCE_FILTERS = ["all", "followers", "subscribers", "followers_or_subscribers"] as const;
export type XAudienceFilter = (typeof X_AUDIENCE_FILTERS)[number];
const VERIFIED_TYPES = new Set(["blue", "business", "government"]);
const USER_FIELDS = "username,verified,verified_type";

export const X_CREDIT_CHECK_INTERVAL_DEFAULT_MS = 300_000;
export const X_POLL_INTERVAL_DEFAULT_MS = 25_000;
export const X_AGENT_SEEN_MAX = 2000;

export const X_MENTIONS_ORIGIN = "https://api.x.com";

export type XDraft = {
  id: string;
  kind: "announce" | "reply";
  text: string;
  bot: true;
  disclosure: typeof BOT_DISCLOSURE;
  status: "draft";
  createdAt: string;
  inReplyTo?: string;
};

export type XDraftWrite = { draft: XDraft } | { dropReason: "local_rate_limit" };

/** Last seen post ids. Pass the same object to each poll so since_id carries over. */
export type XCursorState = {
  mentionsSinceId?: string;
  searchSinceId?: string;
  /** Newest live-chat created_at_ms seen, per broadcast. The chat endpoint has no since_id. */
  liveChatSinceMs?: Record<string, string>;
};

export type XMentionsOptions = {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  /** Overrides state.mentionsSinceId for this call. */
  sinceId?: string;
  /** 5 to 100. X default when omitted. */
  maxResults?: number;
  /** Read and updated in place: mentionsSinceId becomes the newest id seen. */
  state?: XCursorState;
  /** Ask X to expand authors (billed per user). Default true. */
  expandAuthors?: boolean;
};

export type XSearchOptions = {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  /** The live post id. Replies in its conversation are read. Set this, hashtag, or both. */
  conversationId?: string;
  /** Hashtag, with or without #. Posts with it are read too. */
  hashtag?: string;
  /** Overrides state.searchSinceId for this call. */
  sinceId?: string;
  /** 10 to 100. X default when omitted. */
  maxResults?: number;
  state?: XCursorState;
  /** Ask X to expand authors (billed per user). Default true. */
  expandAuthors?: boolean;
};

export type XReadResult = {
  events: ChatEvent[];
  /** Posts returned by X in this call (meta.result_count, or data length). */
  postsRead: number;
  /** Ids of every post returned, including ones skipped as malformed. */
  postIds: string[];
};

export type XDraftOptions = {
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  replyLimit?: PlatformLimit;
};

const MENTIONS_MAX_RESULTS = { min: 5, max: 100 } as const;
const SEARCH_MAX_RESULTS = { min: 10, max: 100 } as const;
const POST_FIELDS = "created_at,conversation_id,in_reply_to_user_id,author_id";
// Read-only recent search. Built from parts so no post-creation path appears in this file.
const SEARCH_PATH = ["", "2", "tweets", "search", "recent"].join("/");

export async function readXMentions(options: XMentionsOptions = {}): Promise<ChatEvent[]> {
  return (await readXMentionsPage(options)).events;
}

export async function readXMentionsPage(options: XMentionsOptions = {}): Promise<XReadResult> {
  const env = options.env ?? process.env;
  const token = readXToken(env);
  const userId = readEnv(env, X_ENV.userId);
  const url = new URL(`/2/users/${encodeURIComponent(userId)}/mentions`, X_MENTIONS_ORIGIN);
  url.searchParams.set("tweet.fields", POST_FIELDS);
  if (options.expandAuthors !== false) {
    url.searchParams.set("expansions", "author_id");
    url.searchParams.set("user.fields", USER_FIELDS);
  }
  const sinceId = options.sinceId ?? options.state?.mentionsSinceId;
  if (sinceId !== undefined) url.searchParams.set("since_id", checkPostId(sinceId, "since_id"));
  if (options.maxResults !== undefined) url.searchParams.set("max_results", String(checkMaxResults(options.maxResults, MENTIONS_MAX_RESULTS)));
  const page = await fetchPosts(url, token, options.fetchImpl, "mentions", undefined, userId);
  if (options.state && page.newestId && isNewer(page.newestId, options.state.mentionsSinceId)) options.state.mentionsSinceId = page.newestId;
  return { events: page.events, postsRead: page.postsRead, postIds: page.postIds };
}

export function buildXSearchQuery(conversationId?: string, hashtag?: string): string {
  const conversation = conversationId === undefined || conversationId === "" ? undefined : `conversation_id:${checkPostId(conversationId, "conversation id")}`;
  const tag = normalizeHashtag(hashtag);
  if (conversation && tag) return `(${conversation} OR #${tag})`;
  if (conversation) return conversation;
  if (tag) return `#${tag}`;
  throw new Error(`X search needs ${X_ENV.livePostId}, ${X_ENV.liveHashtag}, or both`);
}

function normalizeHashtag(hashtag: string | undefined): string | undefined {
  if (hashtag === undefined || hashtag === "") return undefined;
  const tag = hashtag.startsWith("#") ? hashtag.slice(1) : hashtag;
  if (!/^[\p{L}\p{N}_]{1,100}$/u.test(tag)) throw new Error("X hashtag may contain only letters, digits, and _");
  return tag;
}

export async function readXSearch(options: XSearchOptions): Promise<XReadResult> {
  const env = options.env ?? process.env;
  const token = readXToken(env);
  const url = new URL(SEARCH_PATH, X_MENTIONS_ORIGIN);
  url.searchParams.set("query", buildXSearchQuery(options.conversationId, options.hashtag));
  url.searchParams.set("tweet.fields", POST_FIELDS);
  if (options.expandAuthors !== false) {
    url.searchParams.set("expansions", "author_id");
    url.searchParams.set("user.fields", USER_FIELDS);
  }
  const sinceId = options.sinceId ?? options.state?.searchSinceId;
  if (sinceId !== undefined) url.searchParams.set("since_id", checkPostId(sinceId, "since_id"));
  if (options.maxResults !== undefined) url.searchParams.set("max_results", String(checkMaxResults(options.maxResults, SEARCH_MAX_RESULTS)));
  const page = await fetchPosts(url, token, options.fetchImpl, "search", { conversationId: options.conversationId, hashtag: normalizeHashtag(options.hashtag) }, optionalEnv(env, X_ENV.userId));
  if (options.state && page.newestId && isNewer(page.newestId, options.state.searchSinceId)) options.state.searchSinceId = page.newestId;
  return { events: page.events, postsRead: page.postsRead, postIds: page.postIds };
}

export type XChatPollerOptions = {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  /** Live post id for the search source. Falls back to X_LIVE_POST_ID. */
  conversationId?: string;
  /** Hashtag for the search source. Falls back to X_LIVE_HASHTAG. With neither, only mentions are read. */
  hashtag?: string;
  /** Per call, per source. Clamped to the remaining read budget. */
  maxResults?: number;
  /** JSON file that keeps since_id values between polls and restarts. */
  stateFile?: string;
  /** Overrides X_MAX_READS_PER_STREAM. */
  maxReadsPerStream?: number;
  /** Overrides X_STREAM_CREDIT_CAP_USD. Required: polling refuses to start without a cap. */
  creditCapUsd?: number;
  /** Overrides X_EXPAND_AUTHORS (default true). When false, events show author_id only. */
  expandAuthors?: boolean;
  /** Overrides X_AUDIENCE_FILTER (default all). */
  audienceFilter?: XAudienceFilter;
  /** Overrides X_FOLLOWERS_MODE: lookup (default, per-author connection_status) or list (full follower list). */
  followersMode?: "lookup" | "list";
  /** Overrides X_BROADCAST_ID. When unset, the live broadcast is auto-detected from GET /2/broadcasts. */
  broadcastId?: string;
  /** Overrides X_LIVE_CHAT (default on): read broadcast chat as the primary source when a broadcast is live. */
  liveChat?: boolean;
  /** Overrides X_READ_MODE (default "api"). */
  readMode?: "api" | "agent";
  /** Overrides X_SECONDARY_SOURCES (default "mentions,search"; "none" for live chat only). */
  secondarySources?: Array<"mentions" | "search">;
  /** Overrides X_BROADCAST_CHECK_INTERVAL_MS (default 60000) for auto-detect. */
  broadcastCheckIntervalMs?: number;
  /** Sink for per-post filter logs. Default console.warn (stderr). */
  log?: (line: string) => void;
  /** Overrides X_FOLLOW_STATUS_TTL_MS (default 6 h). */
  followStatusTtlMs?: number;
  /** Overrides X_FOLLOWERS_TTL_MS (default 6 h). */
  followersTtlMs?: number;
  /** Overrides X_CREDIT_CHECK_INTERVAL_MS (default 300000). */
  creditCheckIntervalMs?: number;
  now?: () => Date;
};

export type XCreditBalance = {
  totalBalance: number;
  /** Free grants with their expiry, so an expiring grant is not counted as spend. */
  grants: Array<{ amount: number; expiresAt: number }>;
};

/** GET /2/usage/credits. Read only. The token never appears in the result or errors. */
export async function readXCredits(options: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch } = {}): Promise<XCreditBalance> {
  const token = readXToken(options.env ?? process.env);
  const response = await (options.fetchImpl ?? fetch)(new URL("/2/usage/credits", X_MENTIONS_ORIGIN), {
    headers: { authorization: `Bearer ${token}` },
  });
  if (response.status === 429) throw new XRateLimitError("credits", response);
  if (response.status === 401) throw new XAuthError("credits");
  if (!response.ok) throw new Error(`X credits read failed (${response.status})`);
  const body = await response.json() as { data?: { total_balance?: unknown; free_grants?: Array<Record<string, unknown>> } };
  const total = body.data?.total_balance;
  if (typeof total !== "number" || !Number.isFinite(total)) throw new Error("X credits response has no total_balance");
  const grants: XCreditBalance["grants"] = [];
  for (const grant of body.data?.free_grants ?? []) {
    const expiresAt = typeof grant.expires_at === "string" ? Date.parse(grant.expires_at) : Number.NaN;
    if (typeof grant.amount === "number" && Number.isFinite(grant.amount) && !Number.isNaN(expiresAt)) grants.push({ amount: grant.amount, expiresAt });
  }
  return { totalBalance: total, grants };
}

/**
 * Polls mentions and, when a live post id is set, recent search. Merges both
 * into one ChatEvent feed, deduped by post id. Counts posts read against
 * X_MAX_READS_PER_STREAM and stops with a system warning event at the cap.
 * Read only: replies go through XDrafts.
 */
export class XChatPoller {
  readonly maxReads: number | undefined;
  readonly state: XCursorState = {};
  readonly creditCapUsd: number | undefined;
  readonly creditCheckIntervalMs: number;
  readonly conversationId: string | undefined;
  readonly hashtag: string | undefined;
  readonly expandAuthors: boolean;
  readonly audience: XAudienceFilter;
  readonly followersTtlMs: number;
  readonly followersMode: "lookup" | "list";
  readonly followStatusTtlMs: number;
  readonly liveChat: boolean;
  readonly secondary: Set<"mentions" | "search">;
  readonly broadcastCheckIntervalMs: number;
  /** "api": the poller reads X over HTTP. "agent": posts arrive from the Grok Bot X tools via ingestPosts(); no HTTP reads. */
  readonly readMode: "api" | "agent";
  /** Agent mode: USD spent this stream on paid calls (follow lookups, replies), tracked locally. */
  agentSpentUsd = 0;
  /** Agent mode: recently fed ids, oldest first, persisted (bounded) as recentIds in the state file. */
  private readonly recentIds: string[] = [];
  /** since_ids loaded from the state file at start; used to skip posts fed before a restart. */
  private resumeSince: Pick<XCursorState, "mentionsSinceId" | "searchSinceId"> = {};
  /** The broadcast whose chat is read, or undefined when none is live. */
  broadcastId: string | undefined;
  private readonly fixedBroadcast: boolean;
  private lastBroadcastCheck = Number.NEGATIVE_INFINITY;
  /** True when only the app-only bearer token is set: follow status is unknown. */
  readonly appOnlyToken: boolean;
  private warned = new Set<string>();
  /** Events dropped by the followers filter because the follow status was unknown. */
  unknownFollowDropped = 0;
  readonly maxResults: number | undefined;
  /** author_id to username and badges. Persisted in the state file. */
  readonly authors = new Map<string, XAuthor>();
  followerIds: Set<string> | undefined;
  private followersFetchedAt = 0;
  /** Estimated follower-fetch cost, set by prepare(). */
  followerFetchEstimateUsd: number | undefined;
  reads = 0;
  stopped = false;
  /** USD spent this stream, from the last credit check. */
  spentUsd = 0;
  /** Per source: epoch ms before which the source is skipped after a 429. */
  readonly skipUntil: Record<string, number> = {};
  private startCredits: XCreditBalance | undefined;
  private lastCreditCheck = 0;
  private readonly options: XChatPollerOptions;
  private readonly seen = new Set<string>();
  private loaded = false;

  constructor(options: XChatPollerOptions = {}) {
    this.options = options;
    const env = options.env ?? process.env;
    this.maxReads = options.maxReadsPerStream ?? readOptionalPositiveInt(env, X_ENV.maxReadsPerStream);
    this.creditCapUsd = options.creditCapUsd ?? readOptionalPositiveNumber(env, X_ENV.streamCreditCapUsd);
    if (this.creditCapUsd !== undefined && !(this.creditCapUsd > 0)) throw new Error(`${X_ENV.streamCreditCapUsd} must be a positive number`);
    this.creditCheckIntervalMs = options.creditCheckIntervalMs
      ?? readOptionalPositiveInt(env, X_ENV.creditCheckIntervalMs)
      ?? X_CREDIT_CHECK_INTERVAL_DEFAULT_MS;
    this.conversationId = options.conversationId ?? optionalEnv(env, X_ENV.livePostId);
    this.hashtag = options.hashtag ?? optionalEnv(env, X_ENV.liveHashtag);
    if (this.conversationId !== undefined || this.hashtag !== undefined) buildXSearchQuery(this.conversationId, this.hashtag);
    this.expandAuthors = options.expandAuthors ?? readBool(env, X_ENV.expandAuthors, true);
    const audience = options.audienceFilter ?? optionalEnv(env, X_ENV.audienceFilter) ?? "all";
    if (!X_AUDIENCE_FILTERS.includes(audience as XAudienceFilter)) throw new Error(`${X_ENV.audienceFilter} must be one of: ${X_AUDIENCE_FILTERS.join(", ")}`);
    this.audience = audience as XAudienceFilter;
    if (this.audience !== "all" && this.audience !== "followers" && !this.expandAuthors) {
      throw new Error(`${X_ENV.audienceFilter}=${this.audience} needs ${X_ENV.expandAuthors} on: the subscriber flag comes from the author lookup`);
    }
    this.followersTtlMs = options.followersTtlMs ?? readOptionalPositiveInt(env, X_ENV.followersTtlMs) ?? X_FOLLOWERS_TTL_DEFAULT_MS;
    this.maxResults = options.maxResults ?? readOptionalPositiveInt(env, X_ENV.maxResults);
    const mode = options.followersMode ?? optionalEnv(env, X_ENV.followersMode) ?? "lookup";
    if (mode !== "lookup" && mode !== "list") throw new Error(`${X_ENV.followersMode} must be lookup or list`);
    this.followersMode = mode;
    this.followStatusTtlMs = options.followStatusTtlMs ?? readOptionalPositiveInt(env, X_ENV.followStatusTtlMs) ?? X_FOLLOW_STATUS_TTL_DEFAULT_MS;
    this.appOnlyToken = !optionalEnv(env, X_ENV.userAccessToken) && !!optionalEnv(env, X_ENV.bearerToken);
    this.liveChat = options.liveChat ?? readBool(env, X_ENV.liveChat, true);
    const rawSecondary = options.secondarySources ?? (optionalEnv(env, X_ENV.secondarySources) ?? "mentions,search").split(",").map((v) => v.trim()).filter((v) => v && v !== "none");
    for (const name of rawSecondary) if (name !== "mentions" && name !== "search") throw new Error(`${X_ENV.secondarySources} items must be mentions, search, or none`);
    this.secondary = new Set(rawSecondary as Array<"mentions" | "search">);
    const readMode = options.readMode ?? optionalEnv(env, X_ENV.readMode) ?? "api";
    if (readMode !== "api" && readMode !== "agent") throw new Error(`${X_ENV.readMode} must be api or agent`);
    this.readMode = readMode;
    this.broadcastCheckIntervalMs = options.broadcastCheckIntervalMs ?? readOptionalPositiveInt(env, X_ENV.broadcastCheckIntervalMs) ?? X_BROADCAST_CHECK_INTERVAL_DEFAULT_MS;
    const fixed = options.broadcastId ?? optionalEnv(env, X_ENV.broadcastId);
    if (fixed !== undefined && !BROADCAST_ID.test(fixed)) throw new Error(`${X_ENV.broadcastId} must be 1 to 13 letters or digits`);
    this.broadcastId = fixed;
    this.fixedBroadcast = fixed !== undefined;
    if (this.wantsFollowers() && this.followersMode === "lookup" && !this.expandAuthors) {
      throw new Error(`${X_ENV.audienceFilter}=${this.audience} with ${X_ENV.followersMode}=lookup needs ${X_ENV.expandAuthors} on`);
    }
  }

  private wantsFollowers(): boolean {
    return this.audience === "followers" || this.audience === "followers_or_subscribers";
  }

  /** Emits a warning event only the first time for each key. */
  private warnOnce(key: string, text: string): ChatEvent | undefined {
    if (this.warned.has(key)) return undefined;
    this.warned.add(key);
    return this.systemEvent(text);
  }

  /** The full follower list is fetched only in list mode. */
  private needsFollowers(): boolean {
    return this.wantsFollowers() && this.followersMode === "list";
  }

  /**
   * One-time startup step. When the filter needs followers, reads followers_count
   * (one user read) and returns the estimated follower-fetch cost. Returns a
   * one-line summary for the launcher. Never prints secrets.
   */
  async prepare(): Promise<string> {
    await this.load();
    let line = `x-live: audience=${this.audience}, expand_authors=${this.expandAuthors ? "on" : "off"}, cached_authors=${this.authors.size}`;
    if (this.wantsFollowers() && this.followersMode === "lookup") {
      line += `, follow check per new author via connection_status (~$${X_PRICE_USD.userRead.toFixed(2)} each, cached ${Math.round(this.followStatusTtlMs / 3_600_000)} h)`;
    }
    if (this.needsFollowers()) {
      if (this.followerIds && this.nowDate().getTime() - this.followersFetchedAt < this.followersTtlMs) {
        this.followerFetchEstimateUsd = 0;
        line += `, followers cached (${this.followerIds.size}), fetch cost $0.00`;
      } else {
        const count = await readXFollowerCount({ env: this.options.env, fetchImpl: this.options.fetchImpl });
        this.followerFetchEstimateUsd = followerFetchCostUsd(count);
        line += `, follower fetch est. $${this.followerFetchEstimateUsd.toFixed(2)} (${count} followers x $${X_PRICE_USD.followerRead.toFixed(3)}, counts toward ${X_ENV.streamCreditCapUsd})`;
      }
    }
    return line;
  }

  async poll(): Promise<ChatEvent[]> {
    if (this.stopped) return [];
    // Agent mode: reads come from the Grok Bot X tools through ingestPosts(), never from HTTP here.
    if (this.readMode === "agent") return [];
    if (this.creditCapUsd === undefined) {
      throw new Error(`${X_ENV.streamCreditCapUsd} is not set. X live polling refuses to start without a per-stream credit cap.`);
    }
    if ((this.skipUntil.credits ?? 0) > this.nowDate().getTime()) return [];
    let capEvent: ChatEvent | undefined;
    try {
      capEvent = await this.checkCredits();
    } catch (error) {
      if (error instanceof XAuthError) throw error;
      // Fail closed: without a fresh balance, do not read posts this tick.
      return [this.failure("credits", error)];
    }
    if (capEvent) return [capEvent];
    await this.load();
    const out: ChatEvent[] = [];
    if (this.needsFollowers()) {
      const followerEvent = await this.ensureFollowers();
      if (followerEvent) {
        out.push(followerEvent);
        if (this.stopped) return out;
      }
    }
    const sources: Array<{ name: string; range: { min: number; max: number }; read: (maxResults: number | undefined) => Promise<XReadResult> }> = [];
    if (this.liveChat) out.push(...await this.findBroadcast());
    const broadcastId = this.broadcastId;
    if (this.liveChat && broadcastId) {
      // Primary when a broadcast is live.
      sources.push({
        name: "live_chat",
        range: CHAT_MAX_RESULTS,
        read: (maxResults) => readXBroadcastChat({ env: this.options.env, fetchImpl: this.options.fetchImpl, broadcastId, maxResults, state: this.state }),
      });
    }
    if (this.secondary.has("mentions")) {
      sources.push({
        name: "mentions",
        range: MENTIONS_MAX_RESULTS,
        read: (maxResults) => readXMentionsPage({ env: this.options.env, fetchImpl: this.options.fetchImpl, maxResults, state: this.state, expandAuthors: false }),
      });
    }
    const conversationId = this.conversationId;
    const hashtag = this.hashtag;
    if (this.secondary.has("search") && (conversationId !== undefined || hashtag !== undefined)) {
      sources.push({
        name: "search",
        range: SEARCH_MAX_RESULTS,
        read: (maxResults) => readXSearch({ env: this.options.env, fetchImpl: this.options.fetchImpl, conversationId, hashtag, maxResults, state: this.state, expandAuthors: false }),
      });
    }
    for (const source of sources) {
      const maxResults = this.budget(source.range);
      if (maxResults === null) {
        out.push(this.stop());
        break;
      }
      if ((this.skipUntil[source.name] ?? 0) > this.nowDate().getTime()) continue;
      let page: XReadResult;
      try {
        page = await source.read(maxResults);
      } catch (error) {
        if (error instanceof XAuthError) throw error;
        if (source.name === "live_chat" && !(error instanceof XRateLimitError)) {
          const warn = this.warnOnce(`live_chat:${String((error as Error).message)}`, `X live chat read failed: ${(error as Error).message}. The Livestream API needs a whitelisted app, and docs.x.com says chat history is served after the broadcast ends. Secondary sources keep running.`);
          if (warn) out.push(warn);
          continue;
        }
        out.push(this.failure(source.name, error));
        continue;
      }
      // ponytail: X bills each unique post once per UTC day (docs.x.com pricing, "Deduplication"),
      // so the read cap counts unique post ids per UTC day, not meta.result_count. result_count
      // over-counts when since_id is lost or X re-sends an old post. Expanded users are billed
      // separately and are not counted here.
      this.reads += this.countBilled(page.postIds);
      out.push(...await this.resolveAuthors(page.events));
      for (const event of page.events) {
        if (!this.passesAudience(event)) continue;
        if (event.id !== undefined) {
          const key = event.source === "live_chat" ? `chat:${event.id}` : event.id;
          if (this.seen.has(key)) continue;
          this.seen.add(key);
        }
        out.push(event);
      }
    }
    if (!this.stopped && this.maxReads !== undefined && this.reads >= this.maxReads) out.push(this.stop());
    await this.save();
    return out;
  }

  /**
   * Feeds one X Activity API webhook delivery (broadcast.chat) through the same pipeline as poll():
   * credit cap, read cap, dedupe, author cache, audience filter, state file. Other event types are ignored.
   */
  async ingest(delivery: unknown): Promise<ChatEvent[]> {
    if (this.stopped) return [];
    if (this.creditCapUsd === undefined) {
      throw new Error(`${X_ENV.streamCreditCapUsd} is not set. The X webhook receiver refuses to run without a per-stream credit cap.`);
    }
    const event = xaaBroadcastChatEvent(delivery);
    if (!event || event.id === undefined) return [];
    await this.load();
    const key = `chat:${event.id}`;
    if (this.seen.has(key)) return [];
    const out: ChatEvent[] = [];
    if ((this.skipUntil.credits ?? 0) <= this.nowDate().getTime()) {
      try {
        const capEvent = await this.checkCredits();
        if (capEvent) return [capEvent];
      } catch (error) {
        if (error instanceof XAuthError) throw error;
        // The event is already delivered (and billed), so keep it; the cap is rechecked next time.
        out.push(this.failure("credits", error));
      }
    }
    if (this.maxReads !== undefined && this.reads >= this.maxReads) return [...out, this.stop()];
    if (this.needsFollowers()) {
      const followerEvent = await this.ensureFollowers();
      if (followerEvent) out.push(followerEvent);
      if (this.stopped) return out;
    }
    // ponytail: X has no published price for broadcast.chat deliveries; count each unique message
    // as one read so X_MAX_READS_PER_STREAM and the USD cap still bound spend.
    this.reads += this.countBilled([key]);
    this.seen.add(key);
    out.push(...await this.resolveAuthors([event]));
    if (this.passesAudience(event)) out.push(event);
    if (!this.stopped && this.maxReads !== undefined && this.reads >= this.maxReads) out.push(this.stop());
    await this.save();
    return out;
  }

  /**
   * Agent mode: ingests one JSON line (or parsed value) of posts from the Grok Bot X tools
   * (get_users_mentions, search_posts_all, get_posts_by_ids). Accepts a page {data, includes},
   * an array of posts, or one post. Same dedupe, audience filter, cap and feed as poll(). The
   * reads were free; only follow lookups (and replies) count toward X_STREAM_CREDIT_CAP_USD.
   */
  async ingestPosts(input: unknown): Promise<ChatEvent[]> {
    if (this.stopped) return [];
    if (this.creditCapUsd === undefined) throw new Error(`${X_ENV.streamCreditCapUsd} is not set. X agent mode refuses to start without a per-stream credit cap.`);
    await this.load();
    let value = input;
    if (typeof input === "string") {
      if (input.trim() === "") return [];
      try {
        value = JSON.parse(input);
      } catch {
        const warn = this.warnOnce("agent-json", "X agent input: skipped a line that is not JSON.");
        return warn ? [warn] : [];
      }
    }
    const env = this.options.env ?? process.env;
    const ownerId = optionalEnv(env, X_ENV.userId);
    const all = xAgentPostEvents(value, { ownerId, conversationId: this.conversationId, hashtag: this.hashtag });
    // After a restart, ids at or below either since_id loaded from the state file were already fed.
    const resume = [this.resumeSince.mentionsSinceId, this.resumeSince.searchSinceId].reduce<string | undefined>((a, b) => (b !== undefined && isNewer(b, a) ? b : a), undefined);
    const fresh: ChatEvent[] = [];
    for (const event of all) {
      if (event.id === undefined) continue;
      // since_id per source advances for every post seen, even dropped ones, so the next run starts past them.
      const key = event.source === "search" || event.source === "hashtag" ? "searchSinceId" : "mentionsSinceId";
      if (isNewer(event.id, this.state[key])) this.state[key] = event.id;
      if (this.seen.has(event.id) || (resume !== undefined && !isNewer(event.id, resume))) continue;
      this.rememberSeen(event.id);
      if (ownerId !== undefined && event.author_id === ownerId) continue; // the streamer's own posts
      fresh.push(event);
    }
    if (fresh.length === 0) {
      await this.save();
      return [];
    }
    const out = await this.resolveAuthors(fresh);
    for (const event of fresh) if (this.passesAudience(event)) out.push(event);
    await this.save();
    return out;
  }

  /** Agent mode: remembers an id, keeping only the newest X_AGENT_SEEN_MAX for the state file. */
  private rememberSeen(id: string): void {
    this.seen.add(id);
    this.recentIds.push(id);
    if (this.recentIds.length > X_AGENT_SEEN_MAX) this.recentIds.splice(0, this.recentIds.length - X_AGENT_SEEN_MAX);
  }

  /** USD left under the cap. Agent mode tracks spend locally; api mode uses the last credit check. */
  remainingUsd(): number | undefined {
    if (this.creditCapUsd === undefined) return undefined;
    return this.creditCapUsd - (this.readMode === "agent" ? this.agentSpentUsd : this.spentUsd);
  }

  /** Reserves a paid action (for example a reply) against the cap. Returns false and stops when it would exceed it. */
  reserveUsd(amount: number): boolean {
    const left = this.remainingUsd();
    if (left === undefined || amount > left + 1e-9) return false;
    if (this.readMode === "agent") this.agentSpentUsd += amount;
    else this.spentUsd += amount;
    return true;
  }

  private stopForSpend(what: string): ChatEvent {
    this.stopped = true;
    return this.systemEvent(`X credit cap reached: ${what} would exceed ${X_ENV.streamCreditCapUsd} ($${this.agentSpentUsd.toFixed(3)} spent of $${String(this.creditCapUsd)}). X stopped for this stream.`);
  }

  /** Fills user and badges from the author cache, looking up only unknown (or stale follow-status) authors. */
  private async resolveAuthors(events: ChatEvent[]): Promise<ChatEvent[]> {
    const notes: ChatEvent[] = [];
    // Live chat carries author_username, so a new chat author needs no lookup unless follow status is wanted.
    for (const event of events) {
      if ((event.source === "live_chat" || this.readMode === "agent") && event.author_id && event.user !== event.author_id && !this.authors.has(event.author_id)) {
        this.authors.set(event.author_id, { username: event.user, badges: [] });
      }
    }
    const lookupFollows = this.wantsFollowers() && this.followersMode === "lookup";
    if (lookupFollows && this.appOnlyToken) {
      const warn = this.warnOnce("app-only", `X follow status is unknown with ${X_ENV.bearerToken} (app-only): connection_status needs ${X_ENV.userAccessToken}. Authors with unknown status are filtered out.`);
      if (warn) notes.push(warn);
    }
    if (this.expandAuthors) {
      const nowMs = this.nowDate().getTime();
      const stale = (author: XAuthor | undefined) => !author
        || (lookupFollows && !this.appOnlyToken && (author.checkedAt === undefined || nowMs - author.checkedAt >= this.followStatusTtlMs));
      let ids = [...new Set(events.map((e) => e.author_id).filter((id): id is string => id !== undefined && stale(this.authors.get(id))))];
      // Agent mode: the post already carries the username, so the only paid lookup is the follow check.
      if (this.readMode === "agent") ids = lookupFollows && !this.appOnlyToken ? ids.filter((id) => this.authors.get(id)?.checkedAt === undefined || this.nowDate().getTime() - (this.authors.get(id)?.checkedAt ?? 0) >= this.followStatusTtlMs) : [];
      if (ids.length > 0 && this.readMode === "agent") {
        const cost = ids.length * X_PRICE_USD.userRead;
        if (this.creditCapUsd !== undefined && this.agentSpentUsd + cost > this.creditCapUsd) {
          notes.push(this.stopForSpend(`follow check for ${ids.length} author(s)`));
          ids = [];
        } else this.agentSpentUsd += cost;
      }
      if (ids.length > 0) {
        try {
          // ponytail: each looked-up user is a User read ($0.010). connection_status rides on the same read,
          // so the follow check costs nothing extra. A cached author is not looked up again until its TTL ends.
          const found = await lookupXUsers(ids, {
            env: this.options.env,
            fetchImpl: this.options.fetchImpl,
            connectionField: true,
            subscriberField: this.audience !== "all" && this.audience !== "followers",
            now: nowMs,
          });
          for (const [id, author] of found) this.authors.set(id, author);
          if (lookupFollows && !this.appOnlyToken && [...found.values()].some((author) => author.followsYou === undefined)) {
            const warn = this.warnOnce("field-missing", `X did not return connection_status for some authors. The user token needs the follows.read scope (re-authorize with tweet.read users.read follows.read). Their follow status is unknown and they are filtered out.`);
            if (warn) notes.push(warn);
          }
        } catch (error) {
          if (error instanceof XAuthError) throw error;
          notes.push(this.failure("users", error));
        }
      }
    }
    for (const event of events) {
      const id = event.author_id;
      if (!id) continue;
      const author = this.expandAuthors ? this.authors.get(id) : undefined;
      // Live chat already carries the username and per-message badges (subscriber, moderator); keep them.
      const carried = event.source === "live_chat" || this.readMode === "agent" ? event.badges ?? [] : [];
      event.user = author?.username ?? (event.source === "live_chat" || this.readMode === "agent" ? event.user : id);
      const badges = [...carried, ...(author?.badges ?? [])];
      if (this.isFollower(id) === true) badges.push("follower");
      if (author?.subscribesToYou) badges.push("subscriber");
      event.badges = [...new Set(badges)];
    }
    return notes;
  }

  /** Uses X_BROADCAST_ID, or auto-detects the running broadcast at most every broadcastCheckIntervalMs. */
  private async findBroadcast(): Promise<ChatEvent[]> {
    if (this.fixedBroadcast) return [];
    const nowMs = this.nowDate().getTime();
    if ((this.skipUntil.broadcasts ?? 0) > nowMs) return [];
    if (nowMs - this.lastBroadcastCheck < this.broadcastCheckIntervalMs) return [];
    this.lastBroadcastCheck = nowMs;
    if (this.appOnlyToken) {
      const warn = this.warnOnce("broadcast-app-only", `X live chat needs ${X_ENV.userAccessToken} (broadcast.read). ${X_ENV.bearerToken} cannot read broadcasts. Using secondary sources only.`);
      return warn ? [warn] : [];
    }
    try {
      const live = pickLiveBroadcast(await listXBroadcasts({ env: this.options.env, fetchImpl: this.options.fetchImpl }));
      const before = this.broadcastId;
      this.broadcastId = live?.id;
      if (live && live.id !== before) return [this.systemEvent(`X live broadcast ${live.id} detected. Live chat is the primary source.`)];
      if (!live && before) return [this.systemEvent(`X broadcast ${before} is no longer running. Using secondary sources.`)];
      return [];
    } catch (error) {
      if (error instanceof XAuthError) throw error;
      if (error instanceof XRateLimitError) return [this.failure("broadcasts", error)];
      const warn = this.warnOnce(`broadcasts:${(error as Error).message}`, `X broadcast lookup failed: ${(error as Error).message}. The Livestream API needs a whitelisted app. Using secondary sources.`);
      return warn ? [warn] : [];
    }
  }

  /** true, false, or undefined when unknown. */
  private isFollower(id: string): boolean | undefined {
    if (this.followersMode === "list" && this.followerIds) return this.followerIds.has(id);
    if (this.followerIds?.has(id)) return true;
    return this.authors.get(id)?.followsYou;
  }

  private passesAudience(event: ChatEvent): boolean {
    if (this.audience === "all" || event.kind === "system") return true;
    const id = event.author_id;
    if (!id) return false;
    const status = this.isFollower(id);
    const follower = status === true;
    const subscriber = this.authors.get(id)?.subscribesToYou === true;
    if (status === undefined && !subscriber && this.audience !== "subscribers") {
      // Unknown follow status is filtered out, but counted and logged.
      this.unknownFollowDropped += 1;
      (this.options.log ?? console.warn)(`x-live: dropped post ${event.post_id ?? event.id ?? "?"} from ${id}: follow status unknown (${this.unknownFollowDropped} so far)`);
    }
    if (this.audience === "followers") return follower;
    if (this.audience === "subscribers") return subscriber;
    return follower || subscriber;
  }

  /** Fetches the follower id set once per TTL. Refuses when the estimate would pass the cap. */
  private async ensureFollowers(): Promise<ChatEvent | undefined> {
    const nowMs = this.nowDate().getTime();
    if (this.followerIds && nowMs - this.followersFetchedAt < this.followersTtlMs) return undefined;
    const cap = this.creditCapUsd as number;
    try {
      const estimate = this.followerFetchEstimateUsd ?? followerFetchCostUsd(await readXFollowerCount({ env: this.options.env, fetchImpl: this.options.fetchImpl }));
      if (this.spentUsd + estimate >= cap) {
        this.stopped = true;
        return this.systemEvent(`X follower fetch est. $${estimate.toFixed(2)} would reach ${X_ENV.streamCreditCapUsd} ($${cap.toFixed(2)}, $${this.spentUsd.toFixed(2)} spent). Raise the cap or set ${X_ENV.audienceFilter}=all. X polling stopped.`);
      }
      const ids = await readXFollowerIds({ env: this.options.env, fetchImpl: this.options.fetchImpl });
      this.followerIds = new Set(ids);
      this.followersFetchedAt = nowMs;
      this.followerFetchEstimateUsd = undefined;
      // The fetch is billed now: re-read the balance on the next tick so it counts toward the cap.
      this.lastCreditCheck = 0;
      return undefined;
    } catch (error) {
      if (error instanceof XAuthError) throw error;
      return this.failure("followers", error);
    }
  }

  private systemEvent(text: string): ChatEvent {
    return { platform: "x", user: "obs-bot", text, kind: "system", ts: this.nowDate().toISOString(), privileged: false };
  }

  /** Reads the balance at stream start and then every creditCheckIntervalMs. Returns a cap event when spend reaches the cap. */
  private async checkCredits(): Promise<ChatEvent | undefined> {
    const nowMs = this.nowDate().getTime();
    if (this.startCredits && nowMs - this.lastCreditCheck < this.creditCheckIntervalMs) return undefined;
    const current = await readXCredits({ env: this.options.env, fetchImpl: this.options.fetchImpl });
    this.lastCreditCheck = nowMs;
    if (!this.startCredits) {
      this.startCredits = current;
      this.startCreditsAt = nowMs;
      return undefined;
    }
    const startMs = this.startCreditsAt ?? nowMs;
    // A free grant that expired during the stream lowers the balance without any spend.
    const expired = this.startCredits.grants
      .filter((grant) => grant.expiresAt > startMs && grant.expiresAt <= nowMs)
      .reduce((sum, grant) => sum + grant.amount, 0);
    this.spentUsd = Math.max(0, round2(this.startCredits.totalBalance - current.totalBalance - expired));
    if (this.spentUsd < (this.creditCapUsd as number)) return undefined;
    this.stopped = true;
    return {
      platform: "x",
      user: "obs-bot",
      text: `X credit cap reached: $${this.spentUsd.toFixed(2)} spent of $${(this.creditCapUsd as number).toFixed(2)} (${X_ENV.streamCreditCapUsd}). X polling stopped for this stream.`,
      kind: "system",
      ts: this.nowDate().toISOString(),
      privileged: false,
    };
  }

  private startCreditsAt: number | undefined;
  private readonly billed = new Set<string>();
  postsReturned = 0;

  private countBilled(ids: string[]): number {
    const day = this.nowDate().toISOString().slice(0, 10);
    let fresh = 0;
    for (const id of ids) {
      const key = `${day}:${id}`;
      if (this.billed.has(key)) continue;
      this.billed.add(key);
      fresh += 1;
    }
    this.postsReturned += ids.length;
    return fresh;
  }

  /** Turns a read error into a system event. On 429 the source is skipped until its reset time. */
  private failure(source: string, error: unknown): ChatEvent {
    const message = error instanceof Error ? error.message : String(error);
    let text = `X ${source} read failed: ${message}`;
    if (error instanceof XRateLimitError) {
      const until = error.resetAt(this.nowDate().getTime());
      this.skipUntil[source] = until;
      text = `X ${source} rate limited (429). Skipping ${source} until ${new Date(until).toISOString()}.`;
    }
    return { platform: "x", user: "obs-bot", text, kind: "system", ts: this.nowDate().toISOString(), privileged: false };
  }

  private nowDate(): Date {
    return (this.options.now ?? (() => new Date()))();
  }

  /** max_results for the next call, or null when the cap leaves no room. */
  private budget(range: { min: number; max: number }): number | undefined | null {
    // X_MAX_RESULTS is clamped to each endpoint's min and max.
    const requested = this.maxResults === undefined ? undefined : Math.min(Math.max(this.maxResults, range.min), range.max);
    if (this.maxReads === undefined) return requested;
    const remaining = this.maxReads - this.reads;
    if (remaining < range.min) return null;
    return Math.min(requested ?? range.max, remaining, range.max);
  }

  private stop(): ChatEvent {
    this.stopped = true;
    return {
      platform: "x",
      user: "obs-bot",
      text: `X read cap reached: ${this.reads} of ${String(this.maxReads)} posts read (${X_ENV.maxReadsPerStream}). X polling stopped for this stream.`,
      kind: "system",
      ts: (this.options.now ?? (() => new Date()))().toISOString(),
      privileged: false,
    };
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.options.stateFile) return;
    let raw: string;
    try {
      raw = await readFile(this.options.stateFile, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    for (const key of ["mentionsSinceId", "searchSinceId"] as const) {
      const value = parsed[key];
      if (typeof value === "string" && /^\d{1,19}$/.test(value)) this.state[key] = value;
    }
    this.resumeSince = { mentionsSinceId: this.state.mentionsSinceId, searchSinceId: this.state.searchSinceId };
    if (Array.isArray(parsed.recentIds)) {
      for (const id of parsed.recentIds.slice(-X_AGENT_SEEN_MAX)) if (typeof id === "string" && /^\d{1,19}$/.test(id)) this.rememberSeen(id);
    }
    const chat = parsed.liveChatSinceMs;
    if (chat && typeof chat === "object") {
      this.state.liveChatSinceMs = Object.fromEntries(Object.entries(chat as Record<string, unknown>).filter(([k, v]) => BROADCAST_ID.test(k) && typeof v === "string" && /^\d{1,16}$/.test(v)) as Array<[string, string]>);
    }
    const authors = parsed.authors;
    if (authors && typeof authors === "object") {
      for (const [id, raw] of Object.entries(authors as Record<string, Record<string, unknown>>)) {
        if (!/^\d{1,19}$/.test(id) || typeof raw?.username !== "string") continue;
        const badges = Array.isArray(raw.badges) ? raw.badges.filter((b): b is string => b === "verified") : [];
        this.authors.set(id, {
          username: raw.username,
          badges,
          ...(typeof raw.subscribesToYou === "boolean" ? { subscribesToYou: raw.subscribesToYou } : {}),
          ...(typeof raw.followsYou === "boolean" && typeof raw.checkedAt === "number" ? { followsYou: raw.followsYou, checkedAt: raw.checkedAt } : {}),
        });
      }
    }
    const followers = parsed.followers as { ids?: unknown; fetchedAt?: unknown } | undefined;
    if (followers && Array.isArray(followers.ids) && typeof followers.fetchedAt === "number") {
      this.followerIds = new Set(followers.ids.filter((id): id is string => typeof id === "string"));
      this.followersFetchedAt = followers.fetchedAt;
    }
  }

  private async save(): Promise<void> {
    if (!this.options.stateFile) return;
    await mkdir(path.dirname(this.options.stateFile), { recursive: true });
    if (this.readMode === "agent") {
      // Agent mode shares the file with Stream Chat Host: keep the newer since_id from either writer.
      try {
        const disk = JSON.parse(await readFile(this.options.stateFile, "utf8")) as XCursorState;
        for (const key of ["mentionsSinceId", "searchSinceId"] as const) {
          const value = disk[key];
          if (typeof value === "string" && /^\d{1,19}$/.test(value) && isNewer(value, this.state[key])) this.state[key] = value;
        }
      } catch {
        // no file yet, or unreadable: write ours
      }
    }
    const data = {
      ...this.state,
      ...(this.recentIds.length > 0 ? { recentIds: this.recentIds } : {}),
      authors: Object.fromEntries(this.authors),
      ...(this.followerIds ? { followers: { ids: [...this.followerIds], fetchedAt: this.followersFetchedAt } } : {}),
    };
    // Write then rename, so a reader never sees a half-written file.
    const tmp = `${this.options.stateFile}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(data)}\n`, { mode: 0o600 });
    await rename(tmp, this.options.stateFile);
  }
}

export const X_RATE_LIMIT_FALLBACK_MS = 60_000;
const X_RATE_LIMIT_MAX_WAIT_MS = 15 * 60_000;

/** A 401 from X: the token is missing scopes, expired, or revoked. Fatal; the poller rethrows it. */
export class XAuthError extends Error {
  constructor(label: string) {
    super(`X ${label} read failed (401). Check ${X_ENV.userAccessToken}: it is expired, revoked, or lacks read scopes.`);
    this.name = "XAuthError";
  }
}

/** A 429 from X. resetHeaderMs is x-rate-limit-reset in epoch ms, or undefined when missing or invalid. */
export class XRateLimitError extends Error {
  readonly resetHeaderMs: number | undefined;
  constructor(label: string, response: Response) {
    const raw = Number(response.headers.get("x-rate-limit-reset"));
    const reset = Number.isFinite(raw) && raw > 0 ? raw * 1000 : undefined;
    super(`X ${label} rate limited (429)`);
    this.name = "XRateLimitError";
    this.resetHeaderMs = reset;
  }

  /** When to call again. Falls back to 60s; never waits more than 15 min. */
  resetAt(nowMs: number): number {
    const reset = this.resetHeaderMs;
    if (reset === undefined || reset <= nowMs) return nowMs + X_RATE_LIMIT_FALLBACK_MS;
    return Math.min(reset, nowMs + X_RATE_LIMIT_MAX_WAIT_MS);
  }
}

type SearchContext = { conversationId?: string; hashtag?: string };

async function fetchPosts(url: URL, token: string, fetchImpl: typeof fetch | undefined, label: string, search?: SearchContext, ownerId?: string): Promise<{ events: ChatEvent[]; postsRead: number; postIds: string[]; newestId?: string }> {
  const response = await (fetchImpl ?? fetch)(url, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (response.status === 429) throw new XRateLimitError(label, response);
  if (response.status === 401) throw new XAuthError(label);
  if (!response.ok) throw new Error(`X ${label} read failed (${response.status})`);
  const body = await response.json() as {
    data?: Array<Record<string, unknown>>;
    includes?: { users?: Array<Record<string, unknown>> };
    meta?: { newest_id?: unknown; result_count?: unknown };
  };
  const names = new Map<string, string>();
  const badges = new Map<string, string[]>();
  for (const user of body.includes?.users ?? []) {
    if (typeof user.id !== "string") continue;
    if (typeof user.username === "string") names.set(user.id, user.username);
    badges.set(user.id, userBadges(user));
  }
  const posts = body.data ?? [];
  let newestId = typeof body.meta?.newest_id === "string" && /^\d{1,19}$/.test(body.meta.newest_id) ? body.meta.newest_id : undefined;
  const events: ChatEvent[] = [];
  const seen = new Set<string>();
  const postIds: string[] = [];
  for (const tweet of posts) {
    const id = typeof tweet.id === "string" ? tweet.id : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    postIds.push(id);
    if (/^\d{1,19}$/.test(id) && isNewer(id, newestId)) newestId = id;
    const text = typeof tweet.text === "string" ? tweet.text : undefined;
    const authorId = typeof tweet.author_id === "string" ? tweet.author_id : undefined;
    const ts = typeof tweet.created_at === "string" ? tweet.created_at : undefined;
    if (!text || !authorId || !ts || Number.isNaN(Date.parse(ts))) continue;
    const replyTo = tweet.in_reply_to_user_id;
    // A reply means a reply to the owner (X_USER_ID), not to anyone else in the thread.
    const isReply = ownerId !== undefined && replyTo === ownerId;
    const source = search ? searchSource(tweet, text, search) : isReply ? "reply" : "mention";
    events.push({
      platform: "x",
      user: names.get(authorId) ?? authorId,
      text,
      kind: isReply ? "reply" : search ? "message" : "mention",
      ts,
      time: ts,
      privileged: false,
      id,
      post_id: id,
      source,
      badges: badges.get(authorId) ?? [],
      author_id: authorId,
    });
  }
  const count = typeof body.meta?.result_count === "number" && Number.isInteger(body.meta.result_count) ? body.meta.result_count : posts.length;
  return { events, postsRead: count, postIds, ...(newestId ? { newestId } : {}) };
}

/** verified only for blue, business, or government (or legacy verified: true). Other values, such as none, are not verified. */
export function userBadges(user: Record<string, unknown>): string[] {
  const list: string[] = [];
  if (user.verified === true || (typeof user.verified_type === "string" && VERIFIED_TYPES.has(user.verified_type))) list.push("verified");
  return list;
}

/**
 * followsYou comes from the official user field connection_status (enum value
 * "followed_by", relative to the authenticated user). undefined means unknown.
 * checkedAt is when followsYou was read (epoch ms).
 */
export type XAuthor = { username: string; badges: string[]; subscribesToYou?: boolean; followsYou?: boolean; checkedAt?: number };

/** GET /2/users?ids= in batches of 100. Billed per user returned. */
export async function lookupXUsers(ids: string[], options: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch; subscriberField?: boolean; connectionField?: boolean; now?: number } = {}): Promise<Map<string, XAuthor>> {
  const token = readXToken(options.env ?? process.env);
  const out = new Map<string, XAuthor>();
  for (let i = 0; i < ids.length; i += 100) {
    const url = new URL("/2/users", X_MENTIONS_ORIGIN);
    url.searchParams.set("ids", ids.slice(i, i + 100).join(","));
    const fields = [USER_FIELDS];
    if (options.connectionField) fields.push("connection_status");
    if (options.subscriberField) fields.push("subscription");
    url.searchParams.set("user.fields", fields.join(","));
    const response = await (options.fetchImpl ?? fetch)(url, { headers: { authorization: `Bearer ${token}` } });
    if (response.status === 429) throw new XRateLimitError("users", response);
    if (response.status === 401) throw new XAuthError("users");
    if (!response.ok) throw new Error(`X users read failed (${response.status})`);
    const body = await response.json() as { data?: Array<Record<string, unknown>> };
    for (const user of body.data ?? []) {
      if (typeof user.id !== "string" || typeof user.username !== "string") continue;
      const subscription = user.subscription as { subscribes_to_you?: unknown } | undefined;
      const flag = typeof subscription?.subscribes_to_you === "boolean" ? subscription.subscribes_to_you
        : typeof user.subscribes_to_you === "boolean" ? user.subscribes_to_you : undefined;
      const connection = Array.isArray(user.connection_status) ? user.connection_status : undefined;
      out.set(user.id, {
        username: user.username,
        badges: userBadges(user),
        ...(flag === undefined ? {} : { subscribesToYou: flag }),
        ...(options.connectionField && connection ? { followsYou: connection.includes("followed_by"), checkedAt: options.now ?? Date.now() } : {}),
      });
    }
  }
  return out;
}

/** followers_count for one user, from public_metrics. One user read. */
export async function readXFollowerCount(options: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch } = {}): Promise<number> {
  const env = options.env ?? process.env;
  const token = readXToken(env);
  const url = new URL(`/2/users/${encodeURIComponent(readEnv(env, X_ENV.userId))}`, X_MENTIONS_ORIGIN);
  url.searchParams.set("user.fields", "public_metrics");
  const response = await (options.fetchImpl ?? fetch)(url, { headers: { authorization: `Bearer ${token}` } });
  if (response.status === 401) throw new XAuthError("user");
  if (!response.ok) throw new Error(`X user read failed (${response.status})`);
  const body = await response.json() as { data?: { public_metrics?: { followers_count?: unknown } } };
  const count = body.data?.public_metrics?.followers_count;
  if (typeof count !== "number") throw new Error("X user response has no followers_count");
  return count;
}

/** GET /2/users/:id/followers, all pages (max_results 1000). Billed per follower returned. */
export async function readXFollowerIds(options: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch } = {}): Promise<string[]> {
  const env = options.env ?? process.env;
  const token = readXToken(env);
  const userId = readEnv(env, X_ENV.userId);
  const ids: string[] = [];
  let next: string | undefined;
  for (let page = 0; page < 1000; page += 1) {
    const url = new URL(`/2/users/${encodeURIComponent(userId)}/followers`, X_MENTIONS_ORIGIN);
    url.searchParams.set("max_results", "1000");
    if (next) url.searchParams.set("pagination_token", next);
    const response = await (options.fetchImpl ?? fetch)(url, { headers: { authorization: `Bearer ${token}` } });
    if (response.status === 429) throw new XRateLimitError("followers", response);
    if (response.status === 401) throw new XAuthError("followers");
    if (!response.ok) throw new Error(`X followers read failed (${response.status})`);
    const body = await response.json() as { data?: Array<{ id?: unknown }>; meta?: { next_token?: unknown } };
    for (const user of body.data ?? []) if (typeof user.id === "string") ids.push(user.id);
    next = typeof body.meta?.next_token === "string" ? body.meta.next_token : undefined;
    if (!next) break;
  }
  return ids;
}

export function followerFetchCostUsd(followers: number): number {
  return round2(followers * X_PRICE_USD.followerRead);
}

export type XBroadcast = { id: string; state: string; startMs?: number; title?: string };

/**
 * GET /2/broadcasts: the authenticated user's broadcasts. Needs a user token
 * (OAuth 2.0 broadcast.read, or OAuth 1.0a user) on a Livestream-API-whitelisted app.
 */
export async function listXBroadcasts(options: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch } = {}): Promise<XBroadcast[]> {
  const token = readXUserToken(options.env ?? process.env, "broadcasts");
  const url = new URL("/2/broadcasts", X_MENTIONS_ORIGIN);
  url.searchParams.set("max_results", "10");
  url.searchParams.set("broadcast.fields", "id,state,start_ms,title");
  const body = await getJson(url, token, options.fetchImpl, "broadcasts") as { data?: Array<Record<string, unknown>> };
  const out: XBroadcast[] = [];
  for (const raw of body.data ?? []) {
    const id = typeof raw.id === "string" ? raw.id : typeof raw.broadcast_id === "string" ? raw.broadcast_id : "";
    if (!BROADCAST_ID.test(id)) continue;
    const start = typeof raw.start_ms === "string" ? Number(raw.start_ms) : Number.NaN;
    out.push({ id, state: typeof raw.state === "string" ? raw.state : "", ...(Number.isFinite(start) ? { startMs: start } : {}), ...(typeof raw.title === "string" ? { title: raw.title } : {}) });
  }
  return out;
}

/** The running broadcast with the newest start, if any. */
export function pickLiveBroadcast(list: XBroadcast[]): XBroadcast | undefined {
  return list.filter((b) => /^running$/i.test(b.state)).sort((a, b) => (b.startMs ?? 0) - (a.startMs ?? 0))[0];
}

/**
 * GET /2/broadcasts/:id/chat, newest first. docs.x.com says this is history,
 * available after the broadcast ends; real-time chat comes from the X Activity
 * API broadcast.chat webhook. Messages at or before sinceMs are skipped.
 */
export async function readXBroadcastChat(options: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch; broadcastId: string; maxResults?: number; state?: XCursorState }): Promise<XReadResult> {
  if (!BROADCAST_ID.test(options.broadcastId)) throw new Error("X broadcast id must be 1 to 13 letters or digits");
  const token = readXUserToken(options.env ?? process.env, "broadcast chat");
  const url = new URL(`/2/broadcasts/${options.broadcastId}/chat`, X_MENTIONS_ORIGIN);
  url.searchParams.set("max_results", String(Math.min(Math.max(options.maxResults ?? 100, CHAT_MAX_RESULTS.min), CHAT_MAX_RESULTS.max)));
  url.searchParams.set("chat_message.fields", "author_name,author_username,broadcast_id,created_at_ms,id,reply_to,text");
  url.searchParams.set("expansions", "author_id");
  const body = await getJson(url, token, options.fetchImpl, "broadcast chat") as { data?: Array<Record<string, unknown>> };
  const since = Number(options.state?.liveChatSinceMs?.[options.broadcastId] ?? "0");
  const events: ChatEvent[] = [];
  const ids: string[] = [];
  let newest = since;
  for (const raw of body.data ?? []) {
    const event = xChatMessageEvent(raw);
    if (!event) continue;
    const ms = Number(raw.created_at_ms);
    ids.push(event.id as string);
    if (ms <= since) continue;
    if (ms > newest) newest = ms;
    events.push(event);
  }
  events.reverse(); // oldest first, like the other sources
  if (options.state && newest > since) options.state.liveChatSinceMs = { ...options.state.liveChatSinceMs, [options.broadcastId]: String(newest) };
  return { events, postsRead: (body.data ?? []).length, postIds: ids };
}

/** Maps one BroadcastChatMessage (spec schema) to a ChatEvent with source live_chat. */
export function xChatMessageEvent(raw: Record<string, unknown>): ChatEvent | undefined {
  const id = typeof raw.id === "string" ? raw.id : "";
  const text = typeof raw.text === "string" ? raw.text : "";
  const ms = Number(raw.created_at_ms);
  if (!id || !text || !Number.isFinite(ms)) return undefined;
  const authorId = typeof raw.author_id === "string" ? raw.author_id : undefined;
  const user = typeof raw.author_username === "string" ? raw.author_username : authorId ?? "unknown";
  const time = new Date(ms).toISOString();
  return {
    platform: "x", user, text, kind: typeof raw.reply_to === "string" ? "reply" : "message", ts: time, time,
    privileged: false, id, post_id: id, source: "live_chat", badges: [], ...(authorId ? { author_id: authorId } : {}),
  };
}

/**
 * Maps an X Activity API broadcast.chat delivery (the documented real-time path)
 * to a ChatEvent. is_subscriber becomes the subscriber badge. No webhook server
 * is included here; this is the mapper for one.
 */
export function xaaBroadcastChatEvent(delivery: unknown): ChatEvent | undefined {
  const data = (delivery as { data?: Record<string, unknown> })?.data;
  if (!data || data.event_type !== "broadcast.chat") return undefined;
  const payload = data.payload as Record<string, unknown> | undefined;
  const author = (payload?.author as { data?: Record<string, unknown> } | undefined)?.data ?? {};
  const id = typeof payload?.message_id === "string" ? payload.message_id : "";
  const text = typeof payload?.message === "string" ? payload.message : "";
  if (!id || !text) return undefined;
  const time = typeof data.created_at === "string" && !Number.isNaN(Date.parse(data.created_at)) ? data.created_at : new Date().toISOString();
  const badges = userBadges(author);
  if (payload?.is_subscriber === true) badges.push("subscriber");
  if (payload?.is_moderator === true) badges.push("moderator");
  return {
    platform: "x", user: typeof author.username === "string" ? author.username : String(author.id ?? "unknown"), text,
    kind: typeof payload?.reply_to === "string" ? "reply" : "message", ts: time, time, privileged: false,
    id, post_id: id, source: "live_chat", badges, ...(typeof author.id === "string" ? { author_id: author.id } : {}),
  };
}

async function getJson(url: URL, token: string, fetchImpl: typeof fetch | undefined, label: string): Promise<unknown> {
  const response = await (fetchImpl ?? fetch)(url, { headers: { authorization: `Bearer ${token}` } });
  if (response.status === 429) throw new XRateLimitError(label, response);
  if (response.status === 401) throw new XAuthError(label);
  if (!response.ok) throw new Error(`X ${label} read failed (${response.status})`);
  return response.json();
}

/** Broadcast endpoints are user-context only: the app-only bearer cannot read them. */
function readXUserToken(env: NodeJS.ProcessEnv, label: string): string {
  const token = optionalEnv(env, X_ENV.userAccessToken);
  if (!token) throw new Error(`X ${label} needs ${X_ENV.userAccessToken} (user context, broadcast.read); ${X_ENV.bearerToken} cannot read it`);
  return token;
}

/** "search" for replies in the live post conversation, "hashtag" for posts found by the tag. */
function searchSource(tweet: Record<string, unknown>, text: string, search: SearchContext): "search" | "hashtag" {
  if (search.conversationId && tweet.conversation_id === search.conversationId) return "search";
  if (search.hashtag && text.toLowerCase().includes(`#${search.hashtag.toLowerCase()}`)) return "hashtag";
  return search.conversationId ? "search" : "hashtag";
}

function checkPostId(value: string, label: string): string {
  if (!/^\d{1,19}$/.test(value)) throw new Error(`X ${label} must be a numeric post id`);
  return value;
}

function checkMaxResults(value: number, range: { min: number; max: number }): number {
  if (!Number.isInteger(value) || value < range.min || value > range.max) {
    throw new Error(`X max_results must be an integer from ${range.min} to ${range.max}`);
  }
  return value;
}

function isNewer(candidate: string, current: string | undefined): boolean {
  return current === undefined || BigInt(candidate) > BigInt(current);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function readOptionalPositiveNumber(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const raw = optionalEnv(env, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return value;
}

function readBool(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = optionalEnv(env, name);
  if (raw === undefined) return fallback;
  if (/^(1|true|on|yes)$/i.test(raw)) return true;
  if (/^(0|false|off|no)$/i.test(raw)) return false;
  throw new Error(`${name} must be on or off`);
}

function readOptionalPositiveInt(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const raw = optionalEnv(env, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

export class XDrafts {
  private readonly env: NodeJS.ProcessEnv;
  private readonly now: () => Date;
  private readonly limiter: RateLimiter;

  constructor(options: XDraftOptions = {}) {
    this.env = options.env ?? process.env;
    this.now = options.now ?? (() => new Date());
    this.limiter = new RateLimiter({
      twitch: { capacity: 1, perMs: 60_000 },
      youtube: { capacity: 1, perMs: 60_000 },
      kick: { capacity: 1, perMs: 60_000 },
      x: options.replyLimit ?? DEFAULT_REPLY_LIMITS.x,
    });
  }

  announce(text: string): Promise<XDraft> {
    return this.write("announce", text);
  }

  async reply(text: string, inReplyTo: string, now = this.now().getTime()): Promise<XDraftWrite> {
    if (!inReplyTo) throw new Error("X reply draft needs the post it answers");
    if (!this.limiter.tryTake("x", now)) return { dropReason: "local_rate_limit" };
    return { draft: await this.write("reply", text, inReplyTo) };
  }

  private async write(kind: XDraft["kind"], text: string, inReplyTo?: string): Promise<XDraft> {
    if (!text.includes(BOT_DISCLOSURE)) throw new Error("X draft must identify as a bot");
    const directory = readEnv(this.env, X_ENV.draftDir);
    await mkdir(directory, { recursive: true });
    const draft: XDraft = {
      id: randomUUID(),
      kind,
      text,
      bot: true,
      disclosure: BOT_DISCLOSURE,
      status: "draft",
      createdAt: this.now().toISOString(),
      ...(inReplyTo ? { inReplyTo } : {}),
    };
    await writeFile(path.join(directory, `${draft.id}.json`), `${JSON.stringify(draft, null, 2)}\n`, { mode: 0o600 });
    return draft;
  }
}

export { publishXDraft };

/** Names of required X variables that are missing. Empty when the poller can start. */
export function missingXEnv(env: NodeJS.ProcessEnv): string[] {
  const missing: string[] = [];
  const agent = optionalEnv(env, X_ENV.readMode) === "agent";
  const audience = optionalEnv(env, X_ENV.audienceFilter) ?? "all";
  // Agent mode reads for free through Grok Bot; a token is only needed for the paid follow check.
  const needsToken = !agent || audience !== "all";
  if (needsToken && !optionalEnv(env, X_ENV.userAccessToken) && !optionalEnv(env, X_ENV.bearerToken)) missing.push(X_ENV.userAccessToken);
  if (!optionalEnv(env, X_ENV.userId)) missing.push(X_ENV.userId);
  if (!optionalEnv(env, X_ENV.streamCreditCapUsd)) missing.push(X_ENV.streamCreditCapUsd);
  return missing;
}

function readXToken(env: NodeJS.ProcessEnv): string {
  const userToken = optionalEnv(env, X_ENV.userAccessToken);
  if (userToken) return userToken;
  const bearer = optionalEnv(env, X_ENV.bearerToken);
  if (bearer) return bearer;
  throw new Error(`${X_ENV.userAccessToken} or ${X_ENV.bearerToken} is not set`);
}

function optionalEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const raw = env[name];
  if (raw == null || raw.length === 0 || raw === `\${${name}}` || raw === `\${env:${name}}`) return undefined;
  return raw;
}

function readEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = optionalEnv(env, name);
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

/**
 * Maps posts from the Grok Bot X tools to chat events. Shapes accepted: an X API page
 * ({data, includes.users}), an array of posts, or a single post. The author's username may come from
 * includes.users, author_username, username, or author.username. An explicit "source" of mention,
 * reply, search or hashtag wins over the derived one.
 */
export function xAgentPostEvents(value: unknown, context: { ownerId?: string; conversationId?: string; hashtag?: string } = {}): ChatEvent[] {
  if (!value || typeof value !== "object") return [];
  const body = value as { data?: unknown; includes?: { users?: Array<Record<string, unknown>> } };
  const posts: unknown[] = Array.isArray(value) ? value : Array.isArray(body.data) ? body.data : body.data && typeof body.data === "object" ? [body.data] : [value];
  const users = new Map<string, Record<string, unknown>>();
  for (const user of body.includes?.users ?? []) if (typeof user?.id === "string") users.set(user.id, user);
  const events: ChatEvent[] = [];
  for (const raw of posts) {
    if (!raw || typeof raw !== "object") continue;
    const post = raw as Record<string, unknown>;
    const id = typeof post.id === "string" && /^\d{1,19}$/.test(post.id) ? post.id : undefined;
    const text = typeof post.text === "string" ? post.text : undefined;
    const nested = post.author && typeof post.author === "object" ? post.author as Record<string, unknown> : undefined;
    const authorId = typeof post.author_id === "string" ? post.author_id : typeof nested?.id === "string" ? nested.id : undefined;
    const ts = typeof post.created_at === "string" && !Number.isNaN(Date.parse(post.created_at)) ? post.created_at : undefined;
    if (!id || !text || !authorId || !ts) continue;
    const user = users.get(authorId) ?? nested ?? {};
    const username = [user.username, post.author_username, post.username].find((v): v is string => typeof v === "string" && v !== "");
    const isReply = context.ownerId !== undefined && post.in_reply_to_user_id === context.ownerId;
    const explicit = typeof post.source === "string" && ["mention", "reply", "search", "hashtag"].includes(post.source) ? post.source : undefined;
    // A search hit (for example to:<handle>) that replies to the streamer is a reply.
    let source = isReply && (explicit === "search" || explicit === "hashtag") ? "reply" : explicit;
    if (!source) {
      if (context.conversationId && post.conversation_id === context.conversationId) source = "search";
      else if (context.hashtag && text.toLowerCase().includes(`#${context.hashtag.toLowerCase()}`)) source = "hashtag";
      else source = isReply ? "reply" : "mention";
    }
    events.push({
      platform: "x", user: username ?? authorId, text,
      kind: source === "reply" ? "reply" : source === "mention" ? "mention" : "message",
      ts, time: ts, privileged: false, id, post_id: id, source, badges: userBadges(user), author_id: authorId,
    });
  }
  return events;
}
