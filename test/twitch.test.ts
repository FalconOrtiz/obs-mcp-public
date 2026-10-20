import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { RateLimiter } from "../packages/obs-bot/src/ratelimit.ts";
import {
  TWITCH_CHAT_URL,
  TWITCH_ENV,
  TWITCH_SEND_LIMIT,
  TWITCH_SUBSCRIBE_URL,
  TwitchEventSubClient,
  sendTwitchChat,
  twitchSubscriptionBody,
} from "../packages/obs-bot/src/adapters/twitch.ts";
import { FakeEventSub } from "./fake-eventsub.ts";

const env = {
  TWITCH_CLIENT_ID: "client-test",
  TWITCH_ACCESS_TOKEN: "token-test",
  TWITCH_BOT_USER_ID: "2914196",
  TWITCH_BROADCASTER_ID: "1971641",
};

type FetchCall = { url: string; method: string; headers: Record<string, string>; body: string };

function limiter(): RateLimiter {
  return new RateLimiter({
    twitch: { capacity: 5, perMs: 30_000 },
    youtube: { capacity: 1, perMs: 60_000 },
    kick: { capacity: 1, perMs: 60_000 },
    x: { capacity: 1, perMs: 60_000 },
  });
}

function mockFetch(calls: FetchCall[], response: unknown, status = 200): typeof fetch {
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
    return new Response(JSON.stringify(response), { status });
  };
}

async function fixture(name: string): Promise<Record<string, unknown>> {
  const text = await readFile(new URL(`./fixtures/twitch/${name}`, import.meta.url), "utf8");
  return JSON.parse(text) as Record<string, unknown>;
}

test("EventSub welcome subscribes to channel.chat.message and sends no client text", async () => {
  const server = new FakeEventSub();
  await server.start();
  const calls: FetchCall[] = [];
  const client = new TwitchEventSubClient({
    env,
    url: server.url,
    fetchImpl: mockFetch(calls, { data: [{ id: "sub-1", status: "enabled" }] }),
    onEvent: () => {},
    handshakeTimeoutMs: 2000,
  });
  try {
    const ready = await client.start();
    assert.equal(ready.sessionId, "AQoQILE98gtqShGmLD7AM6yJThAB");
    assert.equal(ready.subscriptionId, "sub-1");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, TWITCH_SUBSCRIBE_URL);
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].headers.authorization, "Bearer token-test");
    assert.equal(calls[0].headers["client-id"], "client-test");
    assert.deepEqual(JSON.parse(calls[0].body), twitchSubscriptionBody(ready.sessionId, "1971641", "2914196"));
    assert.equal(server.textFrames.length, 0);
    assert.equal(JSON.stringify(ready).includes("token-test"), false);
  } finally {
    client.close();
    await server.stop();
  }
});

test("chat notifications map to ChatEvent and skip duplicates, self, and subscribers", async () => {
  const server = new FakeEventSub();
  await server.start();
  const calls: FetchCall[] = [];
  const events: Array<{ user: string; text: string; kind: string; privileged?: boolean }> = [];
  const revoked: string[] = [];
  const client = new TwitchEventSubClient({
    env,
    url: server.url,
    fetchImpl: mockFetch(calls, { data: [{ id: "sub-1" }] }),
    onEvent: (event) => events.push(event),
    onRevocation: (status) => revoked.push(status),
    handshakeTimeoutMs: 2000,
  });
  try {
    await client.start();
    const message = await fixture("chat-message.json");
    server.send(message);
    server.send(structuredClone(message));
    const own = structuredClone(message) as { metadata: { message_id: string }; payload: { event: { chatter_user_id: string } } };
    own.metadata.message_id = "own-message";
    own.payload.event.chatter_user_id = "2914196";
    server.send(own);
    const viewer = structuredClone(message) as {
      metadata: { message_id: string };
      payload: { event: { badges: Array<{ set_id: string }>; reply: unknown; message: { text: string } } };
    };
    viewer.metadata.message_id = "viewer-message";
    viewer.payload.event.badges = [{ set_id: "subscriber" }];
    viewer.payload.event.message.text = "!brb";
    server.send(viewer);
    const reply = structuredClone(message) as { metadata: { message_id: string }; payload: { event: { reply: unknown } } };
    reply.metadata.message_id = "reply-message";
    reply.payload.event.reply = { parent_message_id: "parent-1" };
    server.send(reply);
    server.send({
      metadata: {
        message_id: "rev-1",
        message_type: "revocation",
        message_timestamp: "2022-11-16T10:11:13.000000000Z",
        subscription_type: "channel.chat.message",
        subscription_version: "1",
      },
      payload: { subscription: { status: "authorization_revoked", type: "channel.chat.message" } },
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(events.length, 3);
    assert.equal(events[0].user, "viewer32");
    assert.equal(events[0].text, "Hi chat");
    assert.equal(events[0].kind, "message");
    assert.equal(events[0].privileged, true);
    assert.equal(events[1].text, "!brb");
    assert.equal(events[1].privileged, false);
    assert.equal(events[2].kind, "reply");
    assert.deepEqual(revoked, ["authorization_revoked"]);
  } finally {
    client.close();
    await server.stop();
  }
});

test("send chat posts the Helix body and keeps the token out of the result", async () => {
  const calls: FetchCall[] = [];
  const response = await fixture("send-chat-response.json");
  const result = await sendTwitchChat("[bot] Hello. I'm a bot.", {
    env,
    fetchImpl: mockFetch(calls, response),
    limiter: limiter(),
  });
  assert.equal(result.isSent, true);
  assert.equal(result.messageId, "abc-123-def");
  assert.equal(result.dropReason, null);
  assert.equal(calls[0].url, TWITCH_CHAT_URL);
  assert.equal(calls[0].headers.authorization, "Bearer token-test");
  assert.deepEqual(JSON.parse(calls[0].body), {
    broadcaster_id: "1971641",
    sender_id: "2914196",
    message: "[bot] Hello. I'm a bot.",
  });
  assert.equal(JSON.stringify(result).includes("token-test"), false);
  await assert.rejects(
    () => sendTwitchChat("[bot] Hello. I'm a bot.", { env: { ...env, TWITCH_ACCESS_TOKEN: `\${${TWITCH_ENV.accessToken}}` }, fetchImpl: mockFetch([], {}), limiter: limiter() }),
    /TWITCH_ACCESS_TOKEN is not set/,
  );
});

test("send chat refuses a hidden bot and an overlong message before fetch", async () => {
  let called = false;
  const fetchImpl: typeof fetch = async () => {
    called = true;
    return new Response("{}", { status: 200 });
  };
  await assert.rejects(() => sendTwitchChat("hello", { env, fetchImpl, limiter: limiter() }), /identify as a bot/);
  await assert.rejects(
    () => sendTwitchChat(`${"a".repeat(500)} I'm a bot.`, { env, fetchImpl, limiter: limiter() }),
    /500 characters/,
  );
  assert.equal(called, false);
});

test("local send limit matches 20 per 30 seconds and blocks the extra call", async () => {
  assert.equal(TWITCH_SEND_LIMIT.capacity, 20);
  assert.equal(TWITCH_SEND_LIMIT.perMs, 30_000);
  const calls: FetchCall[] = [];
  const client = new TwitchEventSubClient({
    env,
    fetchImpl: mockFetch(calls, await fixture("send-chat-response.json")),
    onEvent: () => {},
    sendLimit: { capacity: 1, perMs: 60_000 },
  });
  const first = await client.send("[bot] I'm a bot.");
  const second = await client.send("[bot] I'm a bot.");
  assert.equal(first.isSent, true);
  assert.equal(second.isSent, false);
  assert.equal(second.dropReason, "local_rate_limit");
  assert.equal(calls.length, 1);
  client.close();
});

test("reconnect uses the new URL unchanged and does not subscribe again", async () => {
  const primary = new FakeEventSub();
  const edge = new FakeEventSub();
  await primary.start();
  await edge.start();
  const calls: FetchCall[] = [];
  const events: string[] = [];
  const client = new TwitchEventSubClient({
    env,
    url: primary.url,
    fetchImpl: mockFetch(calls, { data: [{ id: "sub-1" }] }),
    onEvent: (event) => events.push(event.text),
    handshakeTimeoutMs: 2000,
  });
  try {
    await client.start();
    const reconnectUrl = `${edge.url}/edge?session=abc`;
    primary.send({
      metadata: {
        message_id: "reconnect-1",
        message_type: "session_reconnect",
        message_timestamp: "2023-07-19T14:57:00.000000000Z",
      },
      payload: {
        session: {
          id: "AQoQILE98gtqShGmLD7AM6yJThAB",
          status: "reconnecting",
          reconnect_url: reconnectUrl,
          keepalive_timeout_seconds: null,
        },
      },
    });
    const started = Date.now();
    while (edge.requests.length === 0 && Date.now() - started < 1000) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.deepEqual(edge.requests, ["/edge?session=abc"]);
    const message = await fixture("chat-message.json");
    edge.send(message);
    const waited = Date.now();
    while (events.length === 0 && Date.now() - waited < 1000) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.deepEqual(events, ["Hi chat"]);
    assert.equal(calls.length, 1);
    assert.equal(primary.textFrames.length, 0);
    assert.equal(edge.textFrames.length, 0);
  } finally {
    client.close();
    await primary.stop();
    await edge.stop();
  }
});

test("missing welcome and a missed subscribe window fail closed", async () => {
  const quiet = new FakeEventSub();
  quiet.autoWelcome = false;
  await quiet.start();
  const quietClient = new TwitchEventSubClient({
    env,
    url: quiet.url,
    fetchImpl: mockFetch([], {}),
    onEvent: () => {},
    handshakeTimeoutMs: 40,
  });
  try {
    await assert.rejects(() => quietClient.start(), /welcome was not received/);
  } finally {
    quietClient.close();
    await quiet.stop();
  }

  const server = new FakeEventSub();
  await server.start();
  let fetches = 0;
  const hanging: typeof fetch = (_input, init) => new Promise((_resolve, reject) => {
    fetches += 1;
    init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
  });
  const client = new TwitchEventSubClient({
    env,
    url: server.url,
    fetchImpl: hanging,
    onEvent: () => {},
    handshakeTimeoutMs: 2000,
    subscribeTimeoutMs: 40,
  });
  try {
    await assert.rejects(() => client.start(), /subscribe window expired/);
    assert.equal(fetches, 1);
  } finally {
    client.close();
    await server.stop();
  }
});

test("adapter source names env vars and does not embed a token", async () => {
  const source = await readFile(new URL("../packages/obs-bot/src/adapters/twitch.ts", import.meta.url), "utf8");
  assert.match(source, /TWITCH_ACCESS_TOKEN/);
  assert.equal(source.includes("2gbdx6oar67tqtcmt49t3wpcgycthx"), false);
  assert.equal(/Bearer [A-Za-z0-9]{20,}/.test(source), false);
});
