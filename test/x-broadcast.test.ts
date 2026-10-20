import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { XChatPoller, pickLiveBroadcast, readXBroadcastChat, xaaBroadcastChatEvent, type XCursorState } from "../packages/obs-bot/src/adapters/x.ts";
import { xBroadcastChatDelete, xBroadcastChatMute, xBroadcastChatSend, xChatWriteGate } from "../packages/obs-bot/src/adapters/x-broadcast-write.ts";

const env = { X_USER_ACCESS_TOKEN: "x-token-test", X_USER_ID: "42", X_STREAM_CREDIT_CAP_USD: "10" };
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });
const msg = (id: string, ms: number, author = "7", text = `m${id}`) => ({ id, text, author_id: author, author_username: `user${author}`, created_at_ms: String(ms), broadcast_id: "1mGPaZaAdNqJN" });
const T0 = Date.parse("2026-10-18T13:00:00.000Z");

function fakeX(opts: { broadcasts?: unknown[][]; chat?: Array<unknown[] | number>; mentions?: unknown[][] }) {
  const calls: URL[] = [];
  const auth: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(url);
    auth.push((init?.headers as Record<string, string>)?.authorization ?? "");
    assert.equal(init?.method ?? "GET", "GET", "the reader never writes");
    if (url.pathname === "/2/usage/credits") return json({ data: { total_balance: 50 } });
    if (url.pathname === "/2/broadcasts") return json({ data: opts.broadcasts?.shift() ?? [] });
    if (url.pathname.endsWith("/chat")) {
      const next = opts.chat?.shift();
      if (typeof next === "number") return json({}, next, next === 429 ? { "x-rate-limit-reset": String(Math.floor(T0 / 1000) + 90) } : {});
      return json({ data: next ?? [] });
    }
    if (url.pathname === "/2/users") return json({ data: (url.searchParams.get("ids") ?? "").split(",").map((id) => ({ id, username: `user${id}`, connection_status: id === "7" ? ["followed_by"] : [] })) });
    if (url.pathname.endsWith("/mentions")) return json({ data: opts.mentions?.shift() ?? [] });
    return json({}, 404);
  }) as typeof fetch;
  return { calls, auth, fetchImpl, paths: () => calls.map((u) => u.pathname) };
}

test("auto-detects the running broadcast and makes live chat the primary source", async () => {
  assert.equal(pickLiveBroadcast([{ id: "a", state: "Ended", startMs: 9 }, { id: "b", state: "Running", startMs: 1 }, { id: "c", state: "RUNNING", startMs: 5 }])?.id, "c");
  let nowMs = T0;
  const x = fakeX({
    broadcasts: [[{ id: "1mGPaZaAdNqJN", state: "Running", start_ms: String(T0 - 60_000) }]],
    chat: [[msg("3", T0 + 3), msg("2", T0 + 2)], [msg("4", T0 + 4), msg("3", T0 + 3)]],
    mentions: [[{ id: "900", text: "@streamer hi", author_id: "8", created_at: "2026-10-18T13:00:00.000Z" }], []],
  });
  const poller = new XChatPoller({ env, fetchImpl: x.fetchImpl, now: () => new Date(nowMs) });
  const first = await poller.poll();
  assert.match(first[0].text, /live broadcast 1mGPaZaAdNqJN detected/);
  const feed = first.filter((e) => e.kind !== "system");
  assert.deepEqual(feed.map((e) => [e.source, e.post_id, e.user]), [["live_chat", "2", "user7"], ["live_chat", "3", "user7"], ["mention", "900", "user8"]], "live chat first, oldest first, then mentions");
  const order = x.paths().filter((p) => p !== "/2/usage/credits" && p !== "/2/users");
  assert.deepEqual(order, ["/2/broadcasts", "/2/broadcasts/1mGPaZaAdNqJN/chat", "/2/users/42/mentions"]);
  const chatUrl = x.calls.find((u) => u.pathname.endsWith("/chat"));
  assert.equal(chatUrl?.searchParams.get("expansions"), "author_id");
  nowMs += 25_000;
  const second = await poller.poll();
  assert.deepEqual(second.filter((e) => e.source === "live_chat").map((e) => e.post_id), ["4"], "dedupe by created_at_ms and message id");
  assert.equal(x.paths().filter((p) => p === "/2/broadcasts").length, 1, "no re-detect within the check interval");
  assert.ok(x.auth.every((a) => a === "Bearer x-token-test"), "user token on every read");
  assert.equal(JSON.stringify([...first, ...second]).includes("x-token-test"), false);
});

test("X_BROADCAST_ID skips detection; X_SECONDARY_SOURCES=none reads live chat only; since persists", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "obs-mcp-xbc-"));
  const stateFile = path.join(dir, "state.json");
  const x = fakeX({ chat: [[msg("5", T0 + 5)]] });
  const poller = new XChatPoller({ env: { ...env, X_BROADCAST_ID: "1mGPaZaAdNqJN", X_SECONDARY_SOURCES: "none" }, fetchImpl: x.fetchImpl, stateFile });
  const events = await poller.poll();
  assert.deepEqual(events.map((e) => e.post_id), ["5"]);
  assert.deepEqual(x.paths().filter((p) => p !== "/2/usage/credits"), ["/2/broadcasts/1mGPaZaAdNqJN/chat"]);
  const saved = JSON.parse(await readFile(stateFile, "utf8")) as XCursorState;
  assert.equal(saved.liveChatSinceMs?.["1mGPaZaAdNqJN"], String(T0 + 5));
  const y = fakeX({ chat: [[msg("5", T0 + 5)]] });
  assert.deepEqual(await new XChatPoller({ env: { ...env, X_BROADCAST_ID: "1mGPaZaAdNqJN", X_SECONDARY_SOURCES: "none" }, fetchImpl: y.fetchImpl, stateFile }).poll(), []);
  assert.throws(() => new XChatPoller({ env: { ...env, X_BROADCAST_ID: "bad id!" } }), /1 to 13 letters/);
  assert.throws(() => new XChatPoller({ env: { ...env, X_SECONDARY_SOURCES: "dms" } }), /mentions, search, or none/);
  const off = fakeX({ mentions: [[]] });
  await new XChatPoller({ env: { ...env, X_LIVE_CHAT: "off" }, fetchImpl: off.fetchImpl }).poll();
  assert.equal(off.paths().includes("/2/broadcasts"), false);
});

test("live chat: 429 backs off only that source, 401 is fatal, 403 warns once, audience filter applies", async () => {
  let nowMs = T0;
  const x = fakeX({ chat: [429, [msg("6", T0 + 6, "7"), msg("7", T0 + 7, "8")]], mentions: [[], [], []] });
  const poller = new XChatPoller({ env: { ...env, X_BROADCAST_ID: "1mGPaZaAdNqJN", X_AUDIENCE_FILTER: "followers" }, fetchImpl: x.fetchImpl, now: () => new Date(nowMs), log: () => {} });
  const first = await poller.poll();
  assert.match(first[0].text, /live_chat rate limited \(429\)/);
  nowMs += 30_000;
  await poller.poll();
  assert.equal(x.paths().filter((p) => p.endsWith("/chat")).length, 1, "skipped until reset");
  nowMs += 61_000;
  const third = await poller.poll();
  assert.deepEqual(third.map((e) => [e.post_id, e.badges]), [["6", ["follower"]]], "author 8 does not follow");

  const forbidden = fakeX({ chat: [403, 403], mentions: [[], []] });
  const p2 = new XChatPoller({ env: { ...env, X_BROADCAST_ID: "1mGPaZaAdNqJN" }, fetchImpl: forbidden.fetchImpl });
  const a = await p2.poll();
  const b = await p2.poll();
  assert.equal(a.filter((e) => /whitelisted app/.test(e.text)).length, 1);
  assert.equal(b.length, 0, "warned once; mentions keep running");
  assert.equal(forbidden.paths().filter((p) => p.endsWith("/mentions")).length, 2);

  const denied = fakeX({ chat: [401] });
  await assert.rejects(() => new XChatPoller({ env: { ...env, X_BROADCAST_ID: "1mGPaZaAdNqJN" }, fetchImpl: denied.fetchImpl }).poll(), /\(401\)/);
  const appOnly = fakeX({ mentions: [[]] });
  const bearer = await new XChatPoller({ env: { X_BEARER_TOKEN: "app-token-test", X_USER_ID: "42", X_STREAM_CREDIT_CAP_USD: "10" }, fetchImpl: appOnly.fetchImpl }).poll();
  assert.match(bearer[0].text, /needs X_USER_ACCESS_TOKEN \(broadcast\.read\)/);
  assert.equal(appOnly.paths().includes("/2/broadcasts"), false);
  await assert.rejects(() => readXBroadcastChat({ env: { X_BEARER_TOKEN: "app-token-test" }, broadcastId: "1mGPaZaAdNqJN" }), /needs X_USER_ACCESS_TOKEN/);
});

test("the X Activity API broadcast.chat payload maps to live_chat with subscriber and verified badges", () => {
  const event = xaaBroadcastChatEvent({ data: {
    created_at: "2026-10-07T19:17:36.304Z", event_type: "broadcast.chat",
    payload: { broadcast_id: "1mGPaZaAdNqJN", message_id: "2090000000000000004", message: "test", is_subscriber: true, is_moderator: false, reply_to: "1791387165736000000", author: { data: { id: "111", username: "ExampleUser", verified_type: "blue" } } },
  } });
  assert.deepEqual([event?.source, event?.user, event?.kind, event?.post_id, event?.badges, event?.time], ["live_chat", "ExampleUser", "reply", "2090000000000000004", ["verified", "subscriber"], "2026-10-07T19:17:36.304Z"]);
  assert.equal(xaaBroadcastChatEvent({ data: { event_type: "broadcast.chat.remove", payload: {} } }), undefined);
});

test("chat write tools default to dry_run, stay disabled without X_BOT_TOKEN and X_CHAT_WRITE=1, and redact the token", async () => {
  const bot = "xcbot_fake_test_token_value";
  let called = 0;
  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
    called += 1;
    assert.equal((init?.headers as Record<string, string>).authorization, `Bearer ${bot}`);
    return new Response(`{"error":"echo ${bot}"}`, { status: 403 });
  }) as typeof fetch;
  assert.deepEqual(xChatWriteGate({}), { enabled: false, reason: "X_BOT_TOKEN is not set" });
  assert.deepEqual(xChatWriteGate({ X_BOT_TOKEN: bot }), { enabled: false, reason: "X_CHAT_WRITE is not 1" });
  const dry = await xBroadcastChatSend("1mGPaZaAdNqJN", "hola [bot]", { env: { X_BOT_TOKEN: bot, X_CHAT_WRITE: "1" }, fetchImpl });
  assert.equal(dry.dry_run, true);
  assert.equal(called, 0);
  assert.equal(JSON.stringify(dry).includes(bot), false);
  assert.match(JSON.stringify(dry), /Bearer \[REDACTED\]/);
  const mute = await xBroadcastChatMute("1mGPaZaAdNqJN", "123", { env: {}, endAtMs: "1792330000000" });
  assert.equal(mute.dry_run && mute.enabled, false);
  assert.deepEqual(mute.dry_run && mute.request.body, { user_id: "123", end_at_ms: "1792330000000" });
  const del = await xBroadcastChatDelete("1mGPaZaAdNqJN", "2090000000000000004", { env: {} });
  assert.equal(del.dry_run && del.request.method, "DELETE");
  await assert.rejects(() => xBroadcastChatSend("1mGPaZaAdNqJN", "hi", { env: { X_BOT_TOKEN: bot }, dryRun: false, fetchImpl }), /disabled: X_CHAT_WRITE is not 1/);
  assert.equal(called, 0);
  await assert.rejects(
    () => xBroadcastChatSend("1mGPaZaAdNqJN", "hi", { env: { X_BOT_TOKEN: bot, X_CHAT_WRITE: "1" }, dryRun: false, fetchImpl }),
    (error: Error) => /\(403\)/.test(error.message) && !error.message.includes(bot) && error.message.includes("[REDACTED]"),
  );
  assert.throws(() => xBroadcastChatSend("1mGPaZaAdNqJN", "x".repeat(141)), /1 to 140/);
  const source = await readFile(new URL("../packages/obs-bot/src/adapters/x-broadcast-write.ts", import.meta.url), "utf8");
  assert.equal(/xcbot_[A-Za-z0-9]/.test(source), false, "no bot token in source");
});
