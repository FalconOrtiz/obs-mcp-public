import { BOT_DISCLOSURE } from "../bot.ts";
import type { ChatEvent } from "../events.ts";
import { DEFAULT_REPLY_LIMITS, RateLimiter, type PlatformLimit } from "../ratelimit.ts";

export const YOUTUBE_ENV = {
  accessToken: "YOUTUBE_ACCESS_TOKEN",
  liveChatId: "YOUTUBE_LIVE_CHAT_ID",
} as const;

export const YOUTUBE_LIVE_CHAT_URL = "https://www.googleapis.com/youtube/v3/liveChat/messages";

/** Quota costs from the YouTube Data API quota calculator. streamList is not called. */
export const YOUTUBE_QUOTA = {
  listUnits: 5,
  insertUnits: 20,
  streamListUnits: 5,
  dailyUnits: 10_000,
} as const;

export const YOUTUBE_STREAM_LIST = {
  implemented: false,
  transport: "grpc",
  quotaUnits: YOUTUBE_QUOTA.streamListUnits,
} as const;

export type YouTubeQuotaPlan = {
  listUnits: number;
  insertUnits: number;
  streamListUnits: number;
  dailyUnits: number;
  listCallsPerDay: number;
  listUnitsPerHour: number;
  hoursOfPolling: number;
};

export type YouTubePage = {
  events: ChatEvent[];
  waitMs: number;
  offline: boolean;
  quotaExhausted: boolean;
};

export type YouTubeSendResult = {
  id: string;
  sent: boolean;
  dropReason: string | null;
};

export type YouTubeLiveChatOptions = {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  onEvent?: (event: ChatEvent) => void;
  dailyUnits?: number;
  sendLimit?: PlatformLimit;
  defaultWaitMs?: number;
};

export function youtubeQuotaPlan(intervalMs: number, dailyUnits = YOUTUBE_QUOTA.dailyUnits): YouTubeQuotaPlan {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new Error("YouTube polling interval must be positive");
  const listUnitsPerHour = (3_600_000 / intervalMs) * YOUTUBE_QUOTA.listUnits;
  return {
    listUnits: YOUTUBE_QUOTA.listUnits,
    insertUnits: YOUTUBE_QUOTA.insertUnits,
    streamListUnits: YOUTUBE_QUOTA.streamListUnits,
    dailyUnits,
    listCallsPerDay: Math.floor(dailyUnits / YOUTUBE_QUOTA.listUnits),
    listUnitsPerHour,
    hoursOfPolling: dailyUnits / listUnitsPerHour,
  };
}

export function youtubeMessageToEvent(item: unknown): ChatEvent | undefined {
  const record = asRecord(item);
  const snippet = asRecord(record?.snippet);
  const author = asRecord(record?.authorDetails);
  if (!snippet || snippet.type !== "textMessageEvent") return undefined;
  const details = asRecord(snippet.textMessageDetails);
  const text = typeof snippet.displayMessage === "string"
    ? snippet.displayMessage
    : typeof details?.messageText === "string" ? details.messageText : undefined;
  const user = typeof author?.displayName === "string" ? author.displayName : undefined;
  const ts = typeof snippet.publishedAt === "string" ? snippet.publishedAt : undefined;
  if (!text || !user || !ts || Number.isNaN(Date.parse(ts))) return undefined;
  return {
    platform: "youtube",
    user,
    text,
    kind: "message",
    ts,
    privileged: author?.isChatOwner === true || author?.isChatModerator === true,
  };
}

export class YouTubeLiveChat {
  units = 0;
  private pageToken: string | undefined;
  private readonly seen = new Set<string>();
  private stopped = false;
  private readonly env: NodeJS.ProcessEnv;
  private readonly fetchImpl: typeof fetch;
  private readonly dailyUnits: number;
  private readonly defaultWaitMs: number;
  private readonly limiter: RateLimiter;
  private readonly onEvent?: (event: ChatEvent) => void;

  constructor(options: YouTubeLiveChatOptions = {}) {
    this.env = options.env ?? process.env;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.dailyUnits = options.dailyUnits ?? YOUTUBE_QUOTA.dailyUnits;
    this.defaultWaitMs = options.defaultWaitMs ?? 5_000;
    this.onEvent = options.onEvent;
    this.limiter = new RateLimiter({
      twitch: { capacity: 1, perMs: 60_000 },
      youtube: options.sendLimit ?? DEFAULT_REPLY_LIMITS.youtube,
      kick: { capacity: 1, perMs: 60_000 },
      x: { capacity: 1, perMs: 60_000 },
    });
  }

  stop(): void {
    this.stopped = true;
  }

  async pollOnce(): Promise<YouTubePage> {
    if (this.units + YOUTUBE_QUOTA.listUnits > this.dailyUnits) {
      return { events: [], waitMs: 0, offline: false, quotaExhausted: true };
    }
    const liveChatId = readEnv(this.env, YOUTUBE_ENV.liveChatId);
    const accessToken = readEnv(this.env, YOUTUBE_ENV.accessToken);
    const url = new URL(YOUTUBE_LIVE_CHAT_URL);
    url.searchParams.set("liveChatId", liveChatId);
    url.searchParams.set("part", "snippet,authorDetails");
    if (this.pageToken) url.searchParams.set("pageToken", this.pageToken);
    const response = await this.fetchImpl(url, { headers: { authorization: `Bearer ${accessToken}` } });
    if (!response.ok) throw new Error(`YouTube live chat list failed (${response.status})`);
    this.units += YOUTUBE_QUOTA.listUnits;
    const body = await response.json() as {
      nextPageToken?: string;
      pollingIntervalMillis?: number;
      offlineAt?: string;
      items?: unknown[];
    };
    if (typeof body.nextPageToken === "string" && body.nextPageToken.length > 0) this.pageToken = body.nextPageToken;
    const events: ChatEvent[] = [];
    for (const item of body.items ?? []) {
      const id = asRecord(item)?.id;
      if (typeof id === "string") {
        if (this.seen.has(id)) continue;
        this.seen.add(id);
      }
      const event = youtubeMessageToEvent(item);
      if (event) events.push(event);
    }
    const waitMs = typeof body.pollingIntervalMillis === "number" && body.pollingIntervalMillis > 0
      ? body.pollingIntervalMillis
      : this.defaultWaitMs;
    return {
      events,
      waitMs,
      offline: typeof body.offlineAt === "string" && body.offlineAt.length > 0,
      quotaExhausted: false,
    };
  }

  async run(sleep: (ms: number) => Promise<void>, maxPolls = Number.POSITIVE_INFINITY): Promise<void> {
    let polls = 0;
    while (!this.stopped && polls < maxPolls) {
      const page = await this.pollOnce();
      polls += 1;
      if (this.onEvent) {
        for (const event of page.events) this.onEvent(event);
      }
      if (page.offline || page.quotaExhausted || this.stopped || polls >= maxPolls) return;
      await sleep(page.waitMs);
    }
  }

  async send(message: string, now = Date.now()): Promise<YouTubeSendResult> {
    if (!message.includes(BOT_DISCLOSURE)) throw new Error("YouTube chat must identify as a bot");
    if (!this.limiter.tryTake("youtube", now)) return { id: "", sent: false, dropReason: "local_rate_limit" };
    if (this.units + YOUTUBE_QUOTA.insertUnits > this.dailyUnits) {
      throw new Error("YouTube quota would exceed the daily budget");
    }
    const liveChatId = readEnv(this.env, YOUTUBE_ENV.liveChatId);
    const accessToken = readEnv(this.env, YOUTUBE_ENV.accessToken);
    const url = new URL(YOUTUBE_LIVE_CHAT_URL);
    url.searchParams.set("part", "snippet");
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        snippet: {
          liveChatId,
          type: "textMessageEvent",
          textMessageDetails: { messageText: message },
        },
      }),
    });
    if (!response.ok) throw new Error(`YouTube live chat insert failed (${response.status})`);
    this.units += YOUTUBE_QUOTA.insertUnits;
    const body = await response.json() as { id?: string };
    if (typeof body.id !== "string" || body.id.length === 0) throw new Error("YouTube live chat insert returned no id");
    return { id: body.id, sent: true, dropReason: null };
  }
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
