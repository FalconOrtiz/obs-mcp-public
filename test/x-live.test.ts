import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { X_CREDIT_CHECK_INTERVAL_DEFAULT_MS, XAuthError, XChatPoller, buildXSearchQuery, readXMentions, readXSearch } from "../packages/obs-bot/src/adapters/x.ts";
import { parseChatEvent } from "../packages/obs-bot/src/events.ts";
import { feedLine, main, pollIntervalFromEnv, runXLive } from "../scripts/x-live.ts";

const env = { X_USER_ACCESS_TOKEN: "x-token-test", X_USER_ID: "42", X_STREAM_CREDIT_CAP_USD: "5" };
const at = "2026-10-18T12:00:00.000Z";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

test("search works hashtag-only, live-post-only, and with both", async () => {
  assert.equal(buildXSearchQuery(undefined, "#MiStream"), "#MiStream");
  assert.equal(buildXSearchQuery("1900"), "conversation_id:1900");
  assert.equal(buildXSearchQuery("1900", "MiStream"), "(conversation_id:1900 OR #MiStream)");
  assert.throws(() => buildXSearchQuery(), /X_LIVE_POST_ID, X_LIVE_HASHTAG, or both/);
  const urls: URL[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    urls.push(url);
    if (url.pathname === "/2/broadcasts") return new Response(JSON.stringify({ data: [] }), { status: 200 });
    if (url.pathname === "/2/usage/credits") return json({ data: { total_balance: 50 } });
    return json({ meta: { result_count: 0 } });
  }) as typeof fetch;
  await readXSearch({ env, fetchImpl, hashtag: "MiStream" });
  assert.equal(urls[0].searchParams.get("query"), "#MiStream");
  const poller = new XChatPoller({ env: { ...env, X_LIVE_HASHTAG: "MiStream" }, fetchImpl });
  assert.equal(poller.conversationId, undefined);
  assert.equal(poller.hashtag, "MiStream");
  await poller.poll();
  assert.ok(urls.some((u) => u.pathname === "/2/tweets/search/recent" && u.searchParams.get("query") === "#MiStream"));
  const both = new XChatPoller({ env: { ...env, X_LIVE_POST_ID: "1900", X_LIVE_HASHTAG: "MiStream" }, fetchImpl });
  assert.equal(both.conversationId, "1900");
});

test("events carry source, badges, time and post_id, and keep ts and id as aliases", async () => {
  const fetchImpl = (async () => json({
    data: [
      { id: "11", text: "reply in live", author_id: "u1", created_at: at, conversation_id: "1900", in_reply_to_user_id: "42" },
      { id: "12", text: "hola #MiStream", author_id: "u2", created_at: at, conversation_id: "777" },
    ],
    includes: { users: [{ id: "u1", username: "ada", verified: true }, { id: "u2", username: "grace", verified_type: "none" }] },
    meta: { result_count: 2 },
  })) as typeof fetch;
  const page = await readXSearch({ env, fetchImpl, conversationId: "1900", hashtag: "MiStream" });
  const [live, tagged] = page.events;
  assert.equal(live.source, "search");
  assert.equal(live.kind, "reply");
  assert.deepEqual(live.badges, ["verified"]);
  assert.equal(tagged.source, "hashtag");
  assert.equal(tagged.kind, "message", "a hashtag post is not a mention");
  assert.deepEqual(tagged.badges, []);
  assert.equal(tagged.time, at);
  assert.equal(tagged.ts, at);
  assert.equal(tagged.post_id, "12");
  assert.equal(tagged.id, "12");
  const parsed = parseChatEvent(tagged);
  assert.equal(parsed.post_id, "12");
  assert.equal(parsed.source, "hashtag");
  const line = JSON.parse(feedLine(tagged)) as Record<string, unknown>;
  assert.deepEqual(Object.keys(line), ["platform", "source", "user", "text", "time", "post_id", "badges", "kind"]);
});

test("X_CREDIT_CHECK_INTERVAL_MS defaults to 300000", () => {
  assert.equal(X_CREDIT_CHECK_INTERVAL_DEFAULT_MS, 300_000);
  assert.equal(new XChatPoller({ env }).creditCheckIntervalMs, 300_000);
});

test("the read cap counts unique posts per UTC day, not re-sent ones", async () => {
  let nowMs = Date.parse("2026-10-18T23:59:00.000Z");
  const pages = [["1", "2", "3"], ["2", "3", "4"], ["4"]];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname === "/2/broadcasts") return new Response(JSON.stringify({ data: [] }), { status: 200 });
    if (url.pathname === "/2/usage/credits") return json({ data: { total_balance: 50 } });
    if (url.pathname === "/2/users") return json({ data: [{ id: "u1", username: "ada" }] });
    const ids = pages.shift() ?? [];
    return json({ data: ids.map((id) => ({ id, text: `p${id}`, author_id: "u1", created_at: at })), meta: { result_count: ids.length } });
  }) as typeof fetch;
  const poller = new XChatPoller({ env, fetchImpl, now: () => new Date(nowMs) });
  await poller.poll();
  await poller.poll();
  assert.equal(poller.reads, 4, "2 and 3 were re-sent and not billed again");
  assert.equal(poller.postsReturned, 6);
  nowMs += 120_000; // next UTC day: X bills post 4 again
  await poller.poll();
  assert.equal(poller.reads, 5);
  const source = await readFile(new URL("../packages/obs-bot/src/adapters/x.ts", import.meta.url), "utf8");
  assert.match(source, /\/\/ ponytail: X bills each unique post once per UTC day/);
});

test("runXLive prints feed lines, sleeps X_POLL_INTERVAL_MS, and stops when the poller stops", async () => {
  assert.equal(pollIntervalFromEnv({}), 25_000);
  assert.equal(pollIntervalFromEnv({ X_POLL_INTERVAL_MS: "30000" }), 30_000);
  assert.throws(() => pollIntervalFromEnv({ X_POLL_INTERVAL_MS: "5" }), /at least 1000/);
  const lines: string[] = [];
  const sleeps: number[] = [];
  let n = 0;
  const poller = {
    stopped: false,
    async poll() {
      n += 1;
      if (n === 2) this.stopped = true;
      return [{ platform: "x" as const, user: "ada", text: "hi", kind: "mention" as const, ts: at, id: String(n) }];
    },
  };
  const ticks = await runXLive({ poller, intervalMs: 25_000, write: (l) => lines.push(l), sleep: async (ms) => { sleeps.push(ms); } });
  assert.equal(ticks, 2);
  assert.deepEqual(sleeps, [25_000]);
  assert.equal(lines.length, 2);
  assert.equal((JSON.parse(lines[0]) as { post_id: string }).post_id, "1");
});

test("run-x-live.ps1 loads User-scope vars without printing values", async () => {
  const script = await readFile(new URL("../scripts/run-x-live.ps1", import.meta.url), "utf8");
  assert.match(script, /\[Environment\]::GetEnvironmentVariable\(\$name, 'User'\)/);
  assert.match(script, /SetEnvironmentVariable\(\$name, \$value, 'Process'\)/);
  for (const name of ["OBS_WS_PASSWORD", "OBS_STREAM_KEY"]) assert.ok(script.includes(`'${name}'`));
  assert.match(script, /Where-Object \{ \$_ -like 'X_\*' \}/);
  assert.match(script, /scripts\/x-live\.ts/);
  assert.match(script, /X_STREAM_CREDIT_CAP_USD is not set/);
  for (const line of script.split("\n").filter((l) => /Write-(Host|Output)|echo|Out-/.test(l))) {
    assert.equal(/\$value|\$env:[A-Z_]+[^}]*\)|\$\{?env:/.test(line.replace("$env:X_STREAM_CREDIT_CAP_USD))", "")), false, `prints a value: ${line}`);
  }
  assert.equal(/Write-(Host|Output)[^\n]*\$value/.test(script), false);
});

test("x-live exits non-zero naming each missing variable, without calling X", async () => {
  const errors: string[] = [];
  let made = false;
  const code = await main({ env: { X_STREAM_CREDIT_CAP_USD: "5" }, writeError: (l) => errors.push(l), makePoller: () => { made = true; throw new Error("unreachable"); } });
  assert.equal(code, 1);
  assert.equal(made, false);
  assert.match(errors[0], /missing required variable\(s\): X_USER_ACCESS_TOKEN, X_USER_ID/);
  errors.length = 0;
  assert.equal(await main({ env: { X_USER_ACCESS_TOKEN: "x-token-test", X_STREAM_CREDIT_CAP_USD: "5" }, writeError: (l) => errors.push(l) }), 1);
  assert.match(errors[0], /: X_USER_ID\./);
  assert.equal(errors.join("").includes("x-token-test"), false);
});

test("a 401 from X stops x-live with exit 1 after one call, no retry", async () => {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    calls.push(url.pathname);
    if (url.pathname === "/2/broadcasts") return new Response(JSON.stringify({ data: [] }), { status: 200 });
    if (url.pathname === "/2/usage/credits") return json({ data: { total_balance: 50 } });
    return new Response("{}", { status: 401 });
  }) as typeof fetch;
  await assert.rejects(() => new XChatPoller({ env, fetchImpl }).poll(), XAuthError);
  calls.length = 0;
  const errors: string[] = [];
  const sleeps: number[] = [];
  const code = await main({
    env,
    makePoller: (e) => new XChatPoller({ env: e, fetchImpl }),
    writeError: (l) => errors.push(l),
    run: { sleep: async (ms) => { sleeps.push(ms); } },
  });
  assert.equal(code, 1);
  assert.deepEqual(calls, ["/2/usage/credits", "/2/broadcasts", "/2/users/42/mentions"], "exactly one read, no retry");
  assert.deepEqual(sleeps, []);
  assert.match(errors.at(-1) ?? "", /\(401\)\. Check X_USER_ACCESS_TOKEN/);
  assert.equal(errors.join("").includes("x-token-test"), false);
  const script = await readFile(new URL("../scripts/run-x-live.ps1", import.meta.url), "utf8");
  assert.match(script, /'X_USER_ACCESS_TOKEN', 'X_USER_ID'/);
  assert.match(script, /is not set\. Set it in User scope/);
  assert.match(script, /exit \$LASTEXITCODE/);
});

test("reply means a reply to X_USER_ID; other replies are mentions; live-post search stays search", async () => {
  const posts = [
    { id: "21", text: "@streamer hi", author_id: "u1", created_at: at, conversation_id: "1900", in_reply_to_user_id: "42" },
    { id: "22", text: "@other @streamer", author_id: "u1", created_at: at, conversation_id: "555", in_reply_to_user_id: "99" },
    { id: "23", text: "@streamer top", author_id: "u1", created_at: at, conversation_id: "23" },
  ];
  const fetchImpl = (async () => json({ data: posts, meta: { result_count: 3 } })) as typeof fetch;
  const mentions = await readXMentions({ env, fetchImpl });
  assert.deepEqual(mentions.map((e) => [e.post_id, e.source, e.kind]), [["21", "reply", "reply"], ["22", "mention", "mention"], ["23", "mention", "mention"]]);
  const urls: URL[] = [];
  const recording = (async (input: string | URL | Request) => { urls.push(new URL(String(input))); return json({ data: posts, meta: { result_count: 3 } }); }) as typeof fetch;
  const search = await readXSearch({ env, fetchImpl: recording, conversationId: "1900" });
  assert.equal(urls[0].searchParams.get("tweet.fields")?.split(",").includes("in_reply_to_user_id"), true);
  assert.equal(search.events[0].source, "search");
  assert.equal(search.events[0].kind, "reply");
  assert.equal(search.events[1].kind, "message", "a reply to someone else is not a reply to the streamer");
});
