import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { XChatPoller, buildXSearchQuery, readXCredits, readXMentions, readXSearch, type XCursorState } from "../packages/obs-bot/src/adapters/x.ts";

const env = { X_USER_ACCESS_TOKEN: "x-token-test", X_USER_ID: "42", X_STREAM_CREDIT_CAP_USD: "5" };
type Post = { id: string; text: string; author_id: string; created_at: string; in_reply_to_user_id?: string };

const reads = (x: { calls: URL[] }) => x.calls.filter((u) => u.pathname !== "/2/usage/credits" && u.pathname !== "/2/users" && u.pathname !== "/2/broadcasts");

function post(id: string, author = "u1", reply = false): Post {
  return { id, text: `post ${id}`, author_id: author, created_at: "2026-10-18T12:00:00.000Z", ...(reply ? { in_reply_to_user_id: "42" } : {}) };
}

/** Fake X HTTP: routes by path, records every URL, never answers a write. */
function fakeX(routes: { mentions?: Post[][]; search?: Post[][]; credits?: unknown[] }) {
  const calls: URL[] = [];
  const queues = { mentions: [...(routes.mentions ?? [])], search: [...(routes.search ?? [])] };
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(url);
    assert.equal(init?.method ?? "GET", "GET");
    if (url.pathname === "/2/broadcasts") return new Response(JSON.stringify({ data: [] }), { status: 200 });
    if (url.pathname === "/2/usage/credits") {
      const next = routes.credits && routes.credits.length > 1 ? routes.credits.shift() : routes.credits?.[0];
      return new Response(JSON.stringify(next ?? { data: { total_balance: 100, free_grants: [] } }), { status: 200 });
    }
    if (url.pathname === "/2/users") {
      const names: Record<string, string> = { u1: "ada", u2: "grace" };
      return new Response(JSON.stringify({ data: (url.searchParams.get("ids") ?? "").split(",").map((id) => ({ id, username: names[id] ?? `user${id}` })) }), { status: 200 });
    }
    const key = url.pathname.endsWith("/mentions") ? "mentions" : url.pathname === "/2/tweets/search/recent" ? "search" : null;
    if (!key) return new Response("{}", { status: 404 });
    const max = Number(url.searchParams.get("max_results") ?? "100");
    const data = (queues[key].shift() ?? []).slice(0, max);
    const ids = data.map((p) => BigInt(p.id));
    const body = data.length
      ? { data, includes: { users: [{ id: "u1", username: "ada" }, { id: "u2", username: "grace" }] }, meta: { newest_id: String(ids.reduce((a, b) => (b > a ? b : a))), result_count: data.length } }
      : { meta: { result_count: 0 } };
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

test("readXMentions sends since_id and max_results and keeps the newest id in state", async () => {
  const x = fakeX({ mentions: [[post("105"), post("103", "u2", true)], [post("110")]] });
  const state: XCursorState = {};
  const first = await readXMentions({ env, fetchImpl: x.fetchImpl, maxResults: 20, state });
  assert.equal(first.length, 2);
  assert.equal(first[0].id, "105");
  assert.equal(state.mentionsSinceId, "105");
  assert.equal(x.calls[0].searchParams.get("since_id"), null);
  assert.equal(x.calls[0].searchParams.get("max_results"), "20");
  await readXMentions({ env, fetchImpl: x.fetchImpl, state });
  assert.equal(x.calls[1].searchParams.get("since_id"), "105");
  assert.equal(state.mentionsSinceId, "110");
  await readXMentions({ env, fetchImpl: x.fetchImpl, sinceId: "200" });
  assert.equal(x.calls[2].searchParams.get("since_id"), "200");
  await assert.rejects(() => readXMentions({ env, fetchImpl: x.fetchImpl, maxResults: 3 }), /from 5 to 100/);
  await assert.rejects(() => readXMentions({ env, fetchImpl: x.fetchImpl, sinceId: "abc" }), /numeric post id/);
});

test("recent search builds the conversation and hashtag query and uses since_id", async () => {
  assert.equal(buildXSearchQuery("1900"), "conversation_id:1900");
  assert.equal(buildXSearchQuery("1900", "#MiStream"), "(conversation_id:1900 OR #MiStream)");
  assert.throws(() => buildXSearchQuery("1900", "bad tag"), /letters, digits/);
  assert.throws(() => buildXSearchQuery("x1900"), /numeric post id/);
  const x = fakeX({ search: [[post("2001", "u2", true)], []] });
  const state: XCursorState = { searchSinceId: "2000" };
  const page = await readXSearch({ env, fetchImpl: x.fetchImpl, conversationId: "1900", hashtag: "MiStream", maxResults: 10, state });
  const url = x.calls[0];
  assert.equal(url.origin + url.pathname, "https://api.x.com/2/tweets/search/recent");
  assert.equal(url.searchParams.get("query"), "(conversation_id:1900 OR #MiStream)");
  assert.equal(url.searchParams.get("since_id"), "2000");
  assert.equal(url.searchParams.get("max_results"), "10");
  assert.equal(page.postsRead, 1);
  assert.deepEqual(page.events.map((e) => [e.platform, e.user, e.kind, e.id, e.privileged]), [["x", "grace", "reply", "2001", false]]);
  assert.equal(state.searchSinceId, "2001");
  assert.equal(JSON.stringify(page).includes("x-token-test"), false);
});

test("the poller merges mentions and search, dedupes by post id, and persists since_id", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "obs-mcp-xpoll-"));
  const stateFile = path.join(dir, "x-state.json");
  const x = fakeX({ mentions: [[post("300"), post("301")]], search: [[post("301"), post("302", "u2", true)]] });
  const poller = new XChatPoller({ env, fetchImpl: x.fetchImpl, conversationId: "250", hashtag: "live", stateFile });
  const events = await poller.poll();
  assert.deepEqual(events.map((e) => e.id), ["300", "301", "302"]);
  assert.ok(events.every((e) => e.platform === "x" && e.privileged === false));
  const saved = JSON.parse(await readFile(stateFile, "utf8")) as XCursorState;
  assert.deepEqual({ mentionsSinceId: saved.mentionsSinceId, searchSinceId: saved.searchSinceId }, { mentionsSinceId: "301", searchSinceId: "302" });
  assert.deepEqual(Object.keys((saved as { authors: object }).authors).sort(), ["u1", "u2"], "author cache persisted");

  const y = fakeX({ mentions: [[]], search: [[]] });
  const restarted = new XChatPoller({ env, fetchImpl: y.fetchImpl, conversationId: "250", stateFile });
  assert.deepEqual(await restarted.poll(), []);
  const yReads = reads(y);
  assert.equal(yReads[0].searchParams.get("since_id"), "301");
  assert.equal(yReads[1].searchParams.get("since_id"), "302");
});

test("X_MAX_READS_PER_STREAM stops polling with one warning event", async () => {
  const many = (start: number, n: number) => Array.from({ length: n }, (_, i) => post(String(start + i)));
  const x = fakeX({ mentions: [many(400, 8), many(500, 10)], search: [many(600, 10)] });
  const poller = new XChatPoller({
    env: { ...env, X_MAX_READS_PER_STREAM: "25" },
    fetchImpl: x.fetchImpl,
    conversationId: "390",
    now: () => new Date("2026-10-18T12:00:00.000Z"),
  });
  assert.equal(poller.maxReads, 25);
  const first = await poller.poll();
  assert.equal(reads(x)[0].searchParams.get("max_results"), "25");
  assert.equal(reads(x)[1].searchParams.get("max_results"), "17");
  assert.equal(poller.reads, 18);
  assert.equal(first.filter((e) => e.kind === "system").length, 0);
  const second = await poller.poll();
  assert.equal(reads(x)[2].searchParams.get("max_results"), "7");
  assert.equal(poller.reads, 25);
  assert.equal(reads(x).length, 3, "search is skipped when fewer than 10 reads remain");
  const warnings = second.filter((e) => e.kind === "system");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].text, /X read cap reached: 25 of 25/);
  assert.equal(warnings[0].privileged, false);
  assert.equal(poller.stopped, true);
  assert.deepEqual(await poller.poll(), []);
  assert.equal(reads(x).length, 3);
  assert.throws(() => new XChatPoller({ env: { ...env, X_MAX_READS_PER_STREAM: "0" } }), /positive integer/);
});

const credits = (total: number, grants: Array<{ amount: number; expires_at: string }> = []) => ({ data: { total_balance: total, free_grants: grants } });

test("X live polling refuses to start without X_STREAM_CREDIT_CAP_USD", async () => {
  const x = fakeX({ mentions: [[post("1")]] });
  const { X_STREAM_CREDIT_CAP_USD: _cap, ...noCap } = env;
  const poller = new XChatPoller({ env: noCap, fetchImpl: x.fetchImpl });
  await assert.rejects(() => poller.poll(), /X_STREAM_CREDIT_CAP_USD is not set/);
  assert.equal(x.calls.length, 0, "no X call before a cap is set");
  assert.throws(() => new XChatPoller({ env: { ...env, X_STREAM_CREDIT_CAP_USD: "-1" } }), /positive number/);
  assert.throws(() => new XChatPoller({ env: { ...env, X_STREAM_CREDIT_CAP_USD: "abc" } }), /positive number/);
});

test("the credit cap reads the balance at start and every interval, then stops with one event", async () => {
  let nowMs = Date.parse("2026-10-18T12:00:00.000Z");
  const x = fakeX({
    mentions: [[post("10")], [post("11")], [post("12")], [post("13")]],
    credits: [credits(100), credits(97.5), credits(94.9)],
  });
  const poller = new XChatPoller({ env: { ...env, X_CREDIT_CHECK_INTERVAL_MS: "900000" }, fetchImpl: x.fetchImpl, now: () => new Date(nowMs) });
  assert.equal(poller.creditCapUsd, 5);
  assert.equal(poller.creditCheckIntervalMs, 900_000);
  assert.equal((await poller.poll()).length, 1);
  nowMs += 25_000;
  await poller.poll();
  assert.equal(x.calls.filter((u) => u.pathname === "/2/usage/credits").length, 1, "no credit read before the interval");
  nowMs += 900_000;
  const mid = await poller.poll();
  assert.equal(poller.spentUsd, 2.5);
  assert.equal(mid.filter((e) => e.kind === "system").length, 0);
  nowMs += 900_000;
  const capped = await poller.poll();
  assert.equal(capped.length, 1);
  assert.equal(capped[0].kind, "system");
  assert.match(capped[0].text, /X credit cap reached: \$5\.10 spent of \$5\.00/);
  assert.equal(poller.stopped, true);
  const before = x.calls.length;
  assert.deepEqual(await poller.poll(), []);
  assert.equal(x.calls.length, before, "no X calls after the cap");
  assert.equal(JSON.stringify(capped).includes("x-token-test"), false);
});

test("a free grant that expires mid-stream is not counted as spend", async () => {
  let nowMs = Date.parse("2026-10-18T18:40:00.000Z");
  const grant = { amount: 20, expires_at: "2026-10-18T18:52:53.000Z" };
  const x = fakeX({ mentions: [[], []], credits: [credits(108.64, [grant]), credits(88.14)] });
  const poller = new XChatPoller({ env, fetchImpl: x.fetchImpl, now: () => new Date(nowMs) });
  await poller.poll();
  nowMs += 900_000;
  const events = await poller.poll();
  assert.equal(poller.spentUsd, 0.5);
  assert.equal(poller.stopped, false);
  assert.equal(events.filter((e) => e.kind === "system").length, 0);
});

test("readXCredits keeps the token out of results and errors", async () => {
  const ok = await readXCredits({ env, fetchImpl: (async () => new Response(JSON.stringify(credits(12.5)), { status: 200 })) as typeof fetch });
  assert.equal(ok.totalBalance, 12.5);
  await assert.rejects(
    () => readXCredits({ env, fetchImpl: (async () => new Response("no", { status: 403 })) as typeof fetch }),
    (error: Error) => error.message === "X credits read failed (403)" && !error.message.includes("x-token-test"),
  );
  await assert.rejects(() => readXCredits({ env, fetchImpl: (async () => new Response("{}", { status: 200 })) as typeof fetch }), /no total_balance/);
});

test("a 429 skips only that source until x-rate-limit-reset and never throws out of the poller", async () => {
  let nowMs = Date.parse("2026-10-18T12:00:00.000Z");
  const resetSec = Math.floor(nowMs / 1000) + 120;
  const calls: string[] = [];
  let searchLimited = true;
  let mentionsFailNoHeader = false;
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    calls.push(url.pathname);
    if (url.pathname === "/2/broadcasts") return new Response(JSON.stringify({ data: [] }), { status: 200 });
    if (url.pathname === "/2/usage/credits") return new Response(JSON.stringify(credits(100)), { status: 200 });
    if (url.pathname === "/2/users") return new Response(JSON.stringify({ data: [{ id: "u1", username: "ada" }, { id: "u2", username: "grace" }] }), { status: 200 });
    if (url.pathname.endsWith("/mentions")) {
      if (mentionsFailNoHeader) return new Response("{}", { status: 429 });
      return new Response(JSON.stringify({ data: [post(String(700 + calls.length))], includes: { users: [{ id: "u1", username: "ada" }] } }), { status: 200 });
    }
    if (searchLimited) return new Response("{}", { status: 429, headers: { "x-rate-limit-reset": String(resetSec) } });
    return new Response(JSON.stringify({ data: [post("900", "u2", true)] }), { status: 200 });
  }) as typeof fetch;
  const poller = new XChatPoller({ env, fetchImpl, conversationId: "650", now: () => new Date(nowMs) });
  const first = await poller.poll();
  assert.equal(first.filter((e) => e.kind === "mention").length, 1, "mentions still flow");
  const warn = first.filter((e) => e.kind === "system");
  assert.equal(warn.length, 1);
  assert.match(warn[0].text, /search rate limited \(429\)\. Skipping search until 2026-10-18T12:02:00/);
  assert.equal(poller.skipUntil.search, resetSec * 1000);

  nowMs += 60_000;
  calls.length = 0;
  searchLimited = false;
  const second = await poller.poll();
  assert.equal(calls.includes("/2/tweets/search/recent"), false, "search skipped before reset");
  assert.equal(second.filter((e) => e.kind === "mention").length, 1);

  nowMs += 61_000;
  calls.length = 0;
  const third = await poller.poll();
  assert.equal(calls.includes("/2/tweets/search/recent"), true, "search resumes after reset");
  assert.equal(third.some((e) => e.id === "900"), true);

  mentionsFailNoHeader = true;
  const fourth = await poller.poll();
  assert.equal(poller.skipUntil.mentions, nowMs + 60_000, "missing header falls back to 60s");
  assert.ok(fourth.some((e) => e.kind === "system" && /mentions rate limited/.test(e.text)));
  assert.equal(JSON.stringify(fourth).includes("x-token-test"), false);
});

test("a credits 429 or error fails closed for that tick without throwing", async () => {
  let nowMs = Date.parse("2026-10-18T12:00:00.000Z");
  let status = 429;
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    calls.push(url.pathname);
    if (url.pathname === "/2/broadcasts") return new Response(JSON.stringify({ data: [] }), { status: 200 });
    if (url.pathname === "/2/usage/credits") {
      return status === 200 ? new Response(JSON.stringify(credits(100)), { status: 200 }) : new Response("{}", { status });
    }
    return new Response(JSON.stringify({ meta: { result_count: 0 } }), { status: 200 });
  }) as typeof fetch;
  const poller = new XChatPoller({ env, fetchImpl, now: () => new Date(nowMs) });
  const first = await poller.poll();
  assert.deepEqual(calls, ["/2/usage/credits"], "no post reads without a balance");
  assert.match(first[0].text, /credits rate limited/);
  nowMs += 30_000;
  assert.deepEqual(await poller.poll(), []);
  assert.equal(calls.length, 1, "credits skipped until the fallback reset");
  nowMs += 31_000;
  status = 500;
  const third = await poller.poll();
  assert.match(third[0].text, /X credits read failed: X credits read failed \(500\)/);
  status = 200;
  assert.deepEqual(await poller.poll(), []);
  assert.equal(poller.stopped, false);
});
