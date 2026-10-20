import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { DEFAULT_REPLY_LIMITS } from "../packages/obs-bot/src/ratelimit.ts";
import {
  YOUTUBE_ENV,
  YOUTUBE_LIVE_CHAT_URL,
  YOUTUBE_QUOTA,
  YOUTUBE_STREAM_LIST,
  YouTubeLiveChat,
  youtubeQuotaPlan,
} from "../packages/obs-bot/src/adapters/youtube.ts";

const env = {
  YOUTUBE_ACCESS_TOKEN: "yt-token-test",
  YOUTUBE_LIVE_CHAT_ID: "chat-1",
};

type FetchCall = { url: string; method: string; headers: Record<string, string>; body: string };

function mockFetch(calls: FetchCall[], pages: unknown[], status = 200): typeof fetch {
  let index = 0;
  return async (input, init) => {
    const headers: Record<string, string> = {};
    if (init?.headers && typeof init.headers === "object" && !Array.isArray(init.headers)) {
      for (const [key, value] of Object.entries(init.headers)) headers[key.toLowerCase()] = String(value);
    }
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? init.body : "",
    });
    const page = pages[Math.min(index, pages.length - 1)];
    index += 1;
    return new Response(JSON.stringify(page), { status });
  };
}

test("quota math matches list, insert, and the unused streamList cost", () => {
  assert.equal(YOUTUBE_QUOTA.listUnits, 5);
  assert.equal(YOUTUBE_QUOTA.insertUnits, 20);
  assert.equal(YOUTUBE_QUOTA.streamListUnits, 5);
  assert.equal(YOUTUBE_QUOTA.dailyUnits, 10_000);
  const plan = youtubeQuotaPlan(5_000);
  assert.equal(plan.listCallsPerDay, 2_000);
  assert.equal(plan.listUnitsPerHour, 3_600);
  assert.ok(Math.abs(plan.hoursOfPolling - (10_000 / 3_600)) < 1e-9);
  assert.equal(YOUTUBE_STREAM_LIST.implemented, false);
  assert.equal(YOUTUBE_STREAM_LIST.transport, "grpc");
});

test("polling follows pollingIntervalMillis and the next page token", async () => {
  const first = JSON.parse(await readFile(new URL("./fixtures/youtube/list-page.json", import.meta.url), "utf8")) as {
    items: Array<{ id: string }>;
    nextPageToken: string;
  };
  const second = {
    ...first,
    nextPageToken: "page-3",
    pollingIntervalMillis: 8000,
    items: [
      first.items[0],
      {
        kind: "youtube#liveChatMessage",
        id: "LCC.owner-1",
        snippet: {
          type: "textMessageEvent",
          liveChatId: "chat-1",
          publishedAt: "2026-10-17T00:00:02.000Z",
          displayMessage: "!live",
          textMessageDetails: { messageText: "!live" },
        },
        authorDetails: {
          displayName: "Owner",
          isChatOwner: true,
          isChatModerator: false,
        },
      },
    ],
  };
  const calls: FetchCall[] = [];
  const events: Array<{ user: string; text: string; privileged?: boolean }> = [];
  const waits: number[] = [];
  const chat = new YouTubeLiveChat({
    env,
    fetchImpl: mockFetch(calls, [first, second]),
    onEvent: (event) => events.push(event),
  });
  await chat.run(async (ms) => {
    waits.push(ms);
  }, 2);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[0].headers.authorization, "Bearer yt-token-test");
  const firstUrl = new URL(calls[0].url);
  assert.equal(firstUrl.origin + firstUrl.pathname, YOUTUBE_LIVE_CHAT_URL);
  assert.equal(firstUrl.searchParams.get("liveChatId"), "chat-1");
  assert.equal(firstUrl.searchParams.get("part"), "snippet,authorDetails");
  assert.equal(firstUrl.searchParams.get("pageToken"), null);
  assert.equal(new URL(calls[1].url).searchParams.get("pageToken"), "page-2");
  assert.deepEqual(waits, [5000]);
  assert.equal(events.length, 2);
  assert.equal(events[0].user, "Mod Ada");
  assert.equal(events[0].privileged, true);
  assert.equal(events[0].text, "hello from chat");
  assert.equal(events[1].user, "Owner");
  assert.equal(events[1].text, "!live");
  assert.equal(events[1].privileged, true);
  assert.equal(chat.units, 10);
  assert.equal(JSON.stringify(events).includes("yt-token-test"), false);
});

test("offlineAt and a spent list budget stop the poller before another request", async () => {
  const calls: FetchCall[] = [];
  const offline = new YouTubeLiveChat({
    env,
    fetchImpl: mockFetch(calls, [{
      nextPageToken: "page-2",
      pollingIntervalMillis: 5000,
      offlineAt: "2026-10-17T01:00:00.000Z",
      items: [],
    }]),
  });
  const waits: number[] = [];
  await offline.run(async (ms) => {
    waits.push(ms);
  }, 5);
  assert.equal(calls.length, 1);
  assert.deepEqual(waits, []);
  assert.equal(offline.units, 5);

  let extra = 0;
  const spent = new YouTubeLiveChat({
    env,
    dailyUnits: 10_000,
    fetchImpl: async () => {
      extra += 1;
      return new Response("{}", { status: 200 });
    },
  });
  spent.units = 9_996;
  const page = await spent.pollOnce();
  assert.equal(page.quotaExhausted, true);
  assert.equal(extra, 0);
});

test("insert costs 20 units, identifies as a bot, and stays under the reply cap", async () => {
  assert.equal(DEFAULT_REPLY_LIMITS.youtube.capacity, 10);
  assert.equal(DEFAULT_REPLY_LIMITS.youtube.perMs, 60_000);
  const calls: FetchCall[] = [];
  const chat = new YouTubeLiveChat({
    env,
    fetchImpl: mockFetch(calls, [{ id: "LCC.sent-1" }]),
    sendLimit: { capacity: 1, perMs: 60_000 },
  });
  const sent = await chat.send("[bot] Hello. I'm a bot.");
  const blocked = await chat.send("[bot] Hello. I'm a bot.");
  assert.equal(sent.sent, true);
  assert.equal(sent.id, "LCC.sent-1");
  assert.equal(blocked.sent, false);
  assert.equal(blocked.dropReason, "local_rate_limit");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "POST");
  assert.equal(new URL(calls[0].url).searchParams.get("part"), "snippet");
  assert.deepEqual(JSON.parse(calls[0].body), {
    snippet: {
      liveChatId: "chat-1",
      type: "textMessageEvent",
      textMessageDetails: { messageText: "[bot] Hello. I'm a bot." },
    },
  });
  assert.equal(chat.units, 20);
  assert.equal(JSON.stringify(sent).includes("yt-token-test"), false);
  await assert.rejects(() => chat.send("hello"), /identify as a bot/);
  const broke = new YouTubeLiveChat({ env, dailyUnits: 10_000, fetchImpl: mockFetch([], [{}]) });
  broke.units = 9_981;
  await assert.rejects(() => broke.send("[bot] I'm a bot."), /daily budget/);
});

test("a missing YouTube token fails before fetch and streamList is not imported", async () => {
  let called = false;
  const chat = new YouTubeLiveChat({
    env: { YOUTUBE_LIVE_CHAT_ID: "chat-1", YOUTUBE_ACCESS_TOKEN: `\${${YOUTUBE_ENV.accessToken}}` },
    fetchImpl: async () => {
      called = true;
      return new Response("{}", { status: 200 });
    },
  });
  await assert.rejects(() => chat.pollOnce(), /YOUTUBE_ACCESS_TOKEN is not set/);
  assert.equal(called, false);
  const source = await readFile(new URL("../packages/obs-bot/src/adapters/youtube.ts", import.meta.url), "utf8");
  assert.equal(source.includes("@grpc"), false);
  assert.equal(source.includes("grpc"), true);
  assert.match(source, /streamList is not called/);
  assert.equal(/ya29\.[A-Za-z0-9_-]+/.test(source), false);
});
