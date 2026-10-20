import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { XChatPoller, followerFetchCostUsd, userBadges } from "../packages/obs-bot/src/adapters/x.ts";
import { main, maxTicksFromEnv } from "../scripts/x-live.ts";

const env = { X_USER_ACCESS_TOKEN: "x-token-test", X_USER_ID: "42", X_STREAM_CREDIT_CAP_USD: "10" };
const at = "2026-10-18T12:00:00.000Z";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const post = (id: string, author: string) => ({ id, text: `p${id}`, author_id: author, created_at: at });

/** Fake X: mentions queue, users lookup, followers pages, credits. Records each call. */
function fakeX(opts: { mentions: Array<Array<ReturnType<typeof post>>>; followers?: string[][]; followersCount?: number; subscribers?: string[]; balance?: number[]; followsYou?: string[]; omitConnection?: boolean }) {
  const calls: URL[] = [];
  const balance = [...(opts.balance ?? [100])];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    calls.push(url);
    if (url.pathname === "/2/broadcasts") return new Response(JSON.stringify({ data: [] }), { status: 200 });
    if (url.pathname === "/2/usage/credits") return json({ data: { total_balance: balance.length > 1 ? balance.shift() : balance[0] } });
    if (url.pathname === "/2/users") {
      return json({ data: (url.searchParams.get("ids") ?? "").split(",").map((id) => ({
        id, username: `user${id}`, verified_type: id === "7" ? "blue" : "none",
        ...(url.searchParams.get("user.fields")?.includes("subscription") ? { subscription: { subscribes_to_you: (opts.subscribers ?? []).includes(id) } } : {}),
        ...(url.searchParams.get("user.fields")?.includes("connection_status") && !opts.omitConnection
          ? { connection_status: (opts.followsYou ?? []).includes(id) ? ["followed_by"] : [] } : {}),
      })) });
    }
    if (url.pathname === "/2/users/42") return json({ data: { id: "42", public_metrics: { followers_count: opts.followersCount ?? 555 } } });
    if (url.pathname === "/2/users/42/followers") {
      const pages = opts.followers ?? [[]];
      const index = url.searchParams.get("pagination_token") ? Number(url.searchParams.get("pagination_token")!.slice(-1)) : 0;
      return json({ data: pages[index].map((id) => ({ id })), meta: index + 1 < pages.length ? { next_token: `token-page-000000${index + 1}` } : {} });
    }
    if (url.pathname.endsWith("/mentions")) return json({ data: opts.mentions.shift() ?? [], meta: {} });
    return json({}, 404);
  }) as typeof fetch;
  return { calls, fetchImpl, paths: () => calls.map((u) => u.pathname) };
}

test("verified only for blue, business, government, or verified: true", () => {
  for (const type of ["blue", "business", "government"]) assert.deepEqual(userBadges({ verified_type: type }), ["verified"]);
  assert.deepEqual(userBadges({ verified: true }), ["verified"]);
  for (const type of ["none", "legacy", "", "unknown"]) assert.deepEqual(userBadges({ verified_type: type }), []);
});

test("X_MAX_RESULTS is clamped per endpoint and X_MAX_TICKS stops the launcher", async () => {
  const x = fakeX({ mentions: [[], [], [], []] });
  const poller = new XChatPoller({ env: { ...env, X_MAX_RESULTS: "500", X_LIVE_HASHTAG: "t" }, fetchImpl: x.fetchImpl });
  await poller.poll();
  const reads = x.calls.filter((u) => u.pathname.endsWith("/mentions") || u.pathname.includes("/search/"));
  assert.deepEqual(reads.map((u) => u.searchParams.get("max_results")), ["100", "100"]);
  const low = fakeX({ mentions: [[]] });
  await new XChatPoller({ env: { ...env, X_MAX_RESULTS: "1" }, fetchImpl: low.fetchImpl }).poll();
  assert.equal(low.calls.find((u) => u.pathname.endsWith("/mentions"))?.searchParams.get("max_results"), "5");
  assert.equal(maxTicksFromEnv({ X_MAX_TICKS: "3" }), 3);
  assert.throws(() => maxTicksFromEnv({ X_MAX_TICKS: "0" }), /positive integer/);
  const ticks = fakeX({ mentions: [[], [], [], [], []] });
  const lines: string[] = [];
  const code = await main({ env: { ...env, X_MAX_TICKS: "2" }, makePoller: (e) => new XChatPoller({ env: e, fetchImpl: ticks.fetchImpl }), writeError: (l) => lines.push(l), run: { sleep: async () => {} } });
  assert.equal(code, 0);
  assert.equal(ticks.paths().filter((p) => p.endsWith("/mentions")).length, 2);
  assert.match(lines[0], /^x-live: audience=all, expand_authors=on/);
});

test("authors are looked up once, cached in the state file, and shown as author_id when off", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "obs-mcp-xauth-"));
  const stateFile = path.join(dir, "state.json");
  const x = fakeX({ mentions: [[post("1", "7"), post("2", "8")], [post("3", "7")]] });
  const poller = new XChatPoller({ env, fetchImpl: x.fetchImpl, stateFile });
  const first = await poller.poll();
  assert.deepEqual(first.map((e) => [e.user, e.badges]), [["user7", ["verified"]], ["user8", []]]);
  assert.equal(x.calls.find((u) => u.pathname.endsWith("/mentions"))?.searchParams.get("expansions"), null, "no per-post expansion");
  await poller.poll();
  assert.equal(x.paths().filter((p) => p === "/2/users").length, 1, "known author 7 is not looked up again");
  const saved = JSON.parse(await readFile(stateFile, "utf8")) as { authors: Record<string, { username: string }> };
  assert.equal(saved.authors["7"].username, "user7");

  const y = fakeX({ mentions: [[post("4", "7"), post("5", "9")]] });
  const restarted = new XChatPoller({ env, fetchImpl: y.fetchImpl, stateFile });
  await restarted.poll();
  assert.equal(y.calls.find((u) => u.pathname === "/2/users")?.searchParams.get("ids"), "9", "cache survives restart");

  const z = fakeX({ mentions: [[post("6", "7")]] });
  const off = await new XChatPoller({ env: { ...env, X_EXPAND_AUTHORS: "off" }, fetchImpl: z.fetchImpl }).poll();
  assert.equal(off[0].user, "7");
  assert.equal(z.paths().includes("/2/users"), false);
  assert.throws(() => new XChatPoller({ env: { ...env, X_EXPAND_AUTHORS: "maybe" } }), /on or off/);
});

test("followers filter: one paginated fetch per TTL, cost estimate, cap refusal, and filtering", async () => {
  assert.equal(followerFetchCostUsd(555), 5.55);
  const dir = await mkdtemp(path.join(tmpdir(), "obs-mcp-xfol-"));
  const stateFile = path.join(dir, "state.json");
  let nowMs = Date.parse(at);
  const x = fakeX({ mentions: [[post("1", "7"), post("2", "8")], [post("3", "8")]], followers: [["7", "11"], ["12"]], followersCount: 3 });
  const poller = new XChatPoller({ env: { ...env, X_AUDIENCE_FILTER: "followers", X_FOLLOWERS_MODE: "list" }, fetchImpl: x.fetchImpl, stateFile, now: () => new Date(nowMs) });
  const line = await poller.prepare();
  assert.match(line, /follower fetch est\. \$0\.03 \(3 followers x \$0\.010, counts toward X_STREAM_CREDIT_CAP_USD\)/);
  const first = await poller.poll();
  assert.deepEqual(first.map((e) => [e.post_id, e.badges]), [["1", ["verified", "follower"]]], "author 8 is not a follower");
  assert.equal(x.paths().filter((p) => p === "/2/users/42/followers").length, 2, "two pages");
  assert.equal(x.calls.find((u) => u.pathname === "/2/users/42/followers")?.searchParams.get("max_results"), "1000");
  nowMs += 30_000;
  await poller.poll();
  assert.equal(x.paths().filter((p) => p === "/2/users/42/followers").length, 2, "cached within TTL");
  assert.equal(x.paths().filter((p) => p === "/2/usage/credits").length, 2, "balance re-read right after the fetch");
  const saved = JSON.parse(await readFile(stateFile, "utf8")) as { followers: { ids: string[] } };
  assert.deepEqual(saved.followers.ids.sort(), ["11", "12", "7"]);

  const big = fakeX({ mentions: [[post("1", "7")]], followersCount: 555 });
  const capped = new XChatPoller({ env: { ...env, X_STREAM_CREDIT_CAP_USD: "5", X_AUDIENCE_FILTER: "followers", X_FOLLOWERS_MODE: "list" }, fetchImpl: big.fetchImpl });
  assert.match(await capped.prepare(), /est\. \$5\.55 \(555 followers/);
  const events = await capped.poll();
  assert.equal(events.length, 1);
  assert.match(events[0].text, /follower fetch est\. \$5\.55 would reach X_STREAM_CREDIT_CAP_USD \(\$5\.00/);
  assert.equal(capped.stopped, true);
  assert.equal(big.paths().includes("/2/users/42/followers"), false, "no follower fetch past the cap");
});

test("subscribers filter uses the official subscription.subscribes_to_you field and needs author lookup", async () => {
  const x = fakeX({ mentions: [[post("1", "7"), post("2", "8")]], subscribers: ["8"] });
  const events = await new XChatPoller({ env: { ...env, X_AUDIENCE_FILTER: "subscribers" }, fetchImpl: x.fetchImpl }).poll();
  assert.deepEqual(events.map((e) => [e.post_id, e.badges]), [["2", ["subscriber"]]]);
  assert.match(x.calls.find((u) => u.pathname === "/2/users")?.searchParams.get("user.fields") ?? "", /subscription/);
  const both = fakeX({ mentions: [[post("1", "7"), post("2", "8"), post("3", "9")]], subscribers: ["8"], followers: [["7"]], followersCount: 1 });
  const either = await new XChatPoller({ env: { ...env, X_AUDIENCE_FILTER: "followers_or_subscribers", X_FOLLOWERS_MODE: "list" }, fetchImpl: both.fetchImpl }).poll();
  assert.deepEqual(either.map((e) => e.post_id), ["1", "2"]);
  assert.throws(() => new XChatPoller({ env: { ...env, X_AUDIENCE_FILTER: "subscribers", X_EXPAND_AUTHORS: "off" } }), /needs X_EXPAND_AUTHORS on/);
  assert.throws(() => new XChatPoller({ env: { ...env, X_AUDIENCE_FILTER: "vip" } }), /must be one of/);
  assert.equal(JSON.stringify(either).includes("x-token-test"), false);
});

test("README makes X_USER_ACCESS_TOKEN primary with setup steps and no values", async () => {
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  assert.match(readme, /`X_USER_ACCESS_TOKEN` is the primary token/);
  assert.match(readme, /tweet\.read users\.read follows\.read offline\.access/);
  assert.match(readme, /setx X_USER_ACCESS_TOKEN <token>/);
  assert.match(readme, /Read-Host "X user access token" -AsSecureString/);
  assert.match(readme, /Never paste it in chat, and never commit it/);
  assert.match(readme, /`X_BEARER_TOKEN` is a read-only fallback/);
  const research = await readFile(new URL("../docs/RESEARCH.md", import.meta.url), "utf8");
  assert.match(research, /555 x \$0\.010 = \$5\.55/);
  assert.match(research, /https:\/\/api\.x\.com\/2\/openapi\.json/);
});

test("followers filter defaults to the per-author connection_status lookup, cached with a TTL", async () => {
  let nowMs = Date.parse(at);
  const logs: string[] = [];
  const x = fakeX({ mentions: [[post("1", "7"), post("2", "8")], [post("3", "7")], [post("4", "7")]], followsYou: ["7"] });
  const poller = new XChatPoller({ env: { ...env, X_AUDIENCE_FILTER: "followers", X_FOLLOW_STATUS_TTL_MS: "3600000" }, fetchImpl: x.fetchImpl, now: () => new Date(nowMs), log: (l) => logs.push(l) });
  assert.equal(poller.followersMode, "lookup");
  assert.match(await poller.prepare(), /follow check per new author via connection_status \(~\$0\.01 each, cached 1 h\)/);
  const first = await poller.poll();
  assert.deepEqual(first.map((e) => [e.post_id, e.badges]), [["1", ["verified", "follower"]]]);
  assert.equal(x.paths().includes("/2/users/42/followers"), false, "no full-list fetch in lookup mode");
  assert.match(x.calls.find((u) => u.pathname === "/2/users")?.searchParams.get("user.fields") ?? "", /connection_status/);
  assert.deepEqual(logs, [], "author 8 is a known non-follower, not unknown");
  nowMs += 60_000;
  await poller.poll();
  assert.equal(x.paths().filter((p) => p === "/2/users").length, 1, "cached within TTL");
  nowMs += 3_600_000;
  await poller.poll();
  assert.equal(x.paths().filter((p) => p === "/2/users").length, 2, "re-checked after the TTL");
  assert.equal(x.calls.filter((u) => u.pathname === "/2/users").at(-1)?.searchParams.get("ids"), "7");
});

test("missing connection_status or an app-only token warns once and filters unknown authors out, logged", async () => {
  const logs: string[] = [];
  const x = fakeX({ mentions: [[post("1", "7")], [post("2", "9")]], omitConnection: true });
  const poller = new XChatPoller({ env: { ...env, X_AUDIENCE_FILTER: "followers" }, fetchImpl: x.fetchImpl, log: (l) => logs.push(l) });
  const first = await poller.poll();
  assert.equal(first.length, 1);
  assert.match(first[0].text, /did not return connection_status/);
  const second = await poller.poll();
  assert.equal(second.filter((e) => e.kind === "system").length, 0, "warned once");
  assert.equal(poller.unknownFollowDropped, 2);
  assert.equal(logs.length, 2);
  assert.match(logs[0], /dropped post 1 from 7: follow status unknown/);

  const bearerEnv = { X_BEARER_TOKEN: "app-token-test", X_USER_ID: "42", X_STREAM_CREDIT_CAP_USD: "10", X_AUDIENCE_FILTER: "followers" };
  const y = fakeX({ mentions: [[post("1", "7")], [post("2", "7")]], followsYou: ["7"], omitConnection: true });
  const appOnly = new XChatPoller({ env: bearerEnv, fetchImpl: y.fetchImpl, log: () => {} });
  assert.equal(appOnly.appOnlyToken, true);
  const a = await appOnly.poll();
  assert.equal(a.filter((e) => /app-only/.test(e.text)).length, 1);
  const b = await appOnly.poll();
  assert.equal(b.filter((e) => e.kind === "system").length, 0);
  assert.equal(JSON.stringify([...a, ...b]).includes("app-token-test"), false);
});

test("follow status persists in the state file; list mode stays opt-in with the cap refusal", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "obs-mcp-xfs-"));
  const stateFile = path.join(dir, "state.json");
  const nowMs = Date.parse(at);
  const x = fakeX({ mentions: [[post("1", "7")]], followsYou: ["7"] });
  await new XChatPoller({ env: { ...env, X_AUDIENCE_FILTER: "followers" }, fetchImpl: x.fetchImpl, stateFile, now: () => new Date(nowMs) }).poll();
  const saved = JSON.parse(await readFile(stateFile, "utf8")) as { authors: Record<string, { followsYou: boolean; checkedAt: number }> };
  assert.equal(saved.authors["7"].followsYou, true);
  assert.equal(saved.authors["7"].checkedAt, nowMs);
  const y = fakeX({ mentions: [[post("2", "7")]] });
  const events = await new XChatPoller({ env: { ...env, X_AUDIENCE_FILTER: "followers" }, fetchImpl: y.fetchImpl, stateFile, now: () => new Date(nowMs + 1000) }).poll();
  assert.deepEqual(events.map((e) => e.post_id), ["2"]);
  assert.equal(y.paths().includes("/2/users"), false, "cached follow status reused after restart");
  assert.throws(() => new XChatPoller({ env: { ...env, X_FOLLOWERS_MODE: "scrape" } }), /lookup or list/);
  assert.throws(() => new XChatPoller({ env: { ...env, X_AUDIENCE_FILTER: "followers", X_EXPAND_AUTHORS: "off" } }), /needs X_EXPAND_AUTHORS on/);
  const list = new XChatPoller({ env: { ...env, X_AUDIENCE_FILTER: "followers", X_FOLLOWERS_MODE: "list", X_EXPAND_AUTHORS: "off" } });
  assert.equal(list.followersMode, "list");
});
