import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { XChatPoller, missingXEnv, xAgentPostEvents } from "../packages/obs-bot/src/adapters/x.ts";
import { xReplyApprovalId, xReplyCostUsd, xReplyExcludeIds, xReplyPost } from "../packages/obs-bot/src/adapters/x-reply.ts";
import { runAgentFeed } from "../scripts/x-agent-feed.ts";

const base = { X_READ_MODE: "agent", X_USER_ID: "42", X_STREAM_CREDIT_CAP_USD: "0.03" };
const post = (id: string, author: string, extra: Record<string, unknown> = {}) => ({ id, text: `hola ${id}`, author_id: author, created_at: "2026-10-18T13:00:00.000Z", ...extra });
async function* lines(items: unknown[]) { for (const item of items) yield typeof item === "string" ? item : JSON.stringify(item); }
const noHttp = (async () => { throw new Error("no HTTP in agent mode"); }) as typeof fetch;

test("agent mode: no HTTP reads; tool-shaped JSON lines go through dedupe into feed lines", async () => {
  assert.deepEqual(missingXEnv(base), [], "no token needed for free reads with audience=all");
  const poller = new XChatPoller({ env: base, fetchImpl: noHttp });
  assert.deepEqual(await poller.poll(), [], "poll() never reads in agent mode");
  const out: string[] = [];
  const page = { data: [post("101", "7", { in_reply_to_user_id: "42" }), post("102", "8")], includes: { users: [{ id: "7", username: "ana", verified_type: "blue" }, { id: "8", username: "bo" }] } };
  await runAgentFeed({ poller, lines: lines([page, post("102", "8", { author_username: "bo" }), [post("103", "9", { username: "cy", source: "search" })], "not json", ""]), write: (l) => out.push(l) });
  const feed = out.map((l) => JSON.parse(l));
  assert.deepEqual(feed.map((f) => [f.source, f.user, f.post_id, f.kind]), [
    ["reply", "ana", "101", "reply"], ["mention", "bo", "102", "mention"], ["search", "cy", "103", "message"], ["system", "obs-bot", null, "system"],
  ], "102 deduped, bad line warned once");
  assert.deepEqual(feed[0].badges, ["verified"]);
  assert.equal(poller.agentSpentUsd, 0);
  assert.deepEqual(xAgentPostEvents({ data: post("5", "1", { author: { id: "1", username: "nested" } }) }).map((e) => e.user), ["nested"]);
});

test("agent mode: follow check is the only paid call, cached, and stops at the cap", async () => {
  const env = { ...base, X_USER_ACCESS_TOKEN: "x-token-test", X_AUDIENCE_FILTER: "followers" };
  const paths: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    paths.push(url.pathname);
    assert.equal(url.pathname, "/2/users", "only the user lookup");
    assert.match(url.searchParams.get("user.fields") ?? "", /connection_status/);
    return new Response(JSON.stringify({ data: (url.searchParams.get("ids") ?? "").split(",").map((id) => ({ id, username: `u${id}`, connection_status: id === "7" ? ["followed_by"] : [] })) }));
  }) as typeof fetch;
  const poller = new XChatPoller({ env, fetchImpl });
  const a = await poller.ingestPosts(JSON.stringify([post("201", "7"), post("202", "8")]));
  assert.deepEqual(a.map((e) => [e.post_id, e.badges]), [["201", ["follower"]]]);
  assert.ok(Math.abs(poller.agentSpentUsd - 0.02) < 1e-9);
  await poller.ingestPosts(JSON.stringify(post("203", "7")));
  assert.equal(paths.length, 1, "author 7 cached");
  const c = await poller.ingestPosts(JSON.stringify([post("204", "10"), post("205", "11")]));
  assert.match(c[0].text, /X credit cap reached/);
  assert.equal(poller.stopped, true);
  assert.equal(paths.length, 1, "no lookup past the cap");
});

test("missing connection_status warns about the follows.read scope", async () => {
  const fetchImpl = (async () => new Response(JSON.stringify({ data: [{ id: "7", username: "u7" }] }))) as typeof fetch;
  const poller = new XChatPoller({ env: { ...base, X_STREAM_CREDIT_CAP_USD: "5", X_USER_ACCESS_TOKEN: "t", X_AUDIENCE_FILTER: "followers" }, fetchImpl });
  const events = await poller.ingestPosts(JSON.stringify(post("301", "7")));
  assert.match(events[0].text, /follows\.read/);
  assert.equal(events.length, 1, "unknown status filtered out");
});

test("reply tool: dry run by default, needs X_REPLY_WRITE=1, per-reply approval, and budget", async () => {
  const token = "x-token-test";
  let calls = 0;
  const fetchImpl = (async (_i: string | URL | Request, init?: RequestInit) => {
    calls += 1;
    assert.deepEqual(JSON.parse(String(init?.body)), { text: "gracias!", reply: { in_reply_to_tweet_id: "101" } });
    return new Response(JSON.stringify({ data: { id: "999", text: "gracias!" } }), { status: 201 });
  }) as typeof fetch;
  const poller = new XChatPoller({ env: { ...base, X_STREAM_CREDIT_CAP_USD: "0.02" } });
  const env = { X_USER_ACCESS_TOKEN: token, X_REPLY_WRITE: "1" };
  const dry = await xReplyPost("101", "gracias!", { env, fetchImpl });
  assert.equal(dry.dry_run, true);
  assert.equal(calls, 0);
  assert.equal(JSON.stringify(dry).includes(token), false);
  assert.equal(dry.dry_run && dry.approval_id, xReplyApprovalId("101", "gracias!"));
  assert.equal(dry.dry_run && dry.cost_usd, 0.015);
  assert.equal(xReplyCostUsd("see https://x.com"), 0.2);
  await assert.rejects(() => xReplyPost("101", "gracias!", { env: { X_USER_ACCESS_TOKEN: token }, dryRun: false, approvalId: xReplyApprovalId("101", "gracias!"), budget: poller, fetchImpl }), /X_REPLY_WRITE is not 1/);
  await assert.rejects(() => xReplyPost("101", "gracias!", { env, dryRun: false, budget: poller, fetchImpl }), /approval/);
  await assert.rejects(() => xReplyPost("101", "gracias!", { env, dryRun: false, approvalId: xReplyApprovalId("101", "other"), budget: poller, fetchImpl }), /approval/);
  await assert.rejects(() => xReplyPost("101", "gracias!", { env, dryRun: false, approvalId: dry.dry_run ? dry.approval_id : "", fetchImpl }), /budget/);
  assert.equal(calls, 0);
  const live = await xReplyPost("101", "gracias!", { env, dryRun: false, approvalId: dry.dry_run ? dry.approval_id : "", budget: poller, fetchImpl });
  assert.deepEqual(live, { dry_run: false, status: 201, post_id: "999", cost_usd: 0.015 });
  assert.ok(Math.abs(poller.agentSpentUsd - 0.015) < 1e-9, "reply counted toward the cap");
  await assert.rejects(() => xReplyPost("101", "gracias!", { env, dryRun: false, approvalId: dry.dry_run ? dry.approval_id : "", budget: poller, fetchImpl }), /exceed X_STREAM_CREDIT_CAP_USD/);
  assert.equal(calls, 1);
  await assert.rejects(() => xReplyPost("101", "gracias!", { env: { X_REPLY_AS: "bot", X_BOT_TOKEN: "b", X_REPLY_WRITE: "1" } }), /cannot carry tweet\.write/);
  const bot = await xReplyPost("101", "gracias!", { env: { X_REPLY_AS: "bot_account", X_REPLY_WRITE: "1" } });
  assert.equal(bot.dry_run && bot.disabled_reason, "X_BOT_USER_ACCESS_TOKEN is not set");
});

test("agent mode state file: since_id per source, merged with Stream Chat Host's writes", async () => {
  const { mkdtemp, readFile, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const dir = await mkdtemp(path.join(tmpdir(), "obs-mcp-agent-"));
  const stateFile = path.join(dir, "x-state.json");
  const poller = new XChatPoller({ env: base, stateFile });
  await poller.ingestPosts(JSON.stringify([post("500", "7"), post("520", "8", { source: "search" })]));
  let disk = JSON.parse(await readFile(stateFile, "utf8"));
  assert.equal(disk.mentionsSinceId, "500");
  assert.equal(disk.searchSinceId, "520");
  await writeFile(stateFile, JSON.stringify({ ...disk, mentionsSinceId: "900" }));
  await poller.ingestPosts(JSON.stringify(post("600", "7")));
  disk = JSON.parse(await readFile(stateFile, "utf8"));
  assert.equal(disk.mentionsSinceId, "900", "a newer since_id written by the host is kept");
  const restarted = new XChatPoller({ env: base, stateFile });
  assert.deepEqual((await restarted.ingestPosts(JSON.stringify([post("600", "7"), post("901", "7")]))).map((e) => e.post_id), ["901"], "after restart, ids at or below the saved since_id are skipped");
});

test("regression: run 2 of the Stream Chat Host pipe test (same data + 1 new) yields exactly 1 event", async () => {
  const { existsSync } = await import("node:fs");
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const { main } = await import("../scripts/x-agent-feed.ts");
  const fixtures = new URL("./fixtures/", import.meta.url);
  const sets = [[fileURLToPath(new URL("agent-run1.jsonl", fixtures)), fileURLToPath(new URL("agent-run2.jsonl", fixtures))]];
  // Optional: replay your own capture with X_AGENT_RUN1 / X_AGENT_RUN2.
  if (process.env.X_AGENT_RUN1 && process.env.X_AGENT_RUN2 && existsSync(process.env.X_AGENT_RUN1)) sets.push([process.env.X_AGENT_RUN1, process.env.X_AGENT_RUN2]);
  for (const [run1, run2] of sets) {
    const dir = await mkdtemp(path.join(tmpdir(), "obs-mcp-pipe-"));
    const env = { X_READ_MODE: "agent", X_USER_ID: "42", X_STREAM_CREDIT_CAP_USD: "5", X_STATE_FILE: path.join(dir, "state.json") };
    const first: string[] = [];
    assert.equal(await main({ env: { ...env, X_AGENT_INPUT: run1 }, write: (l) => first.push(l) }), 0);
    const one = first.map((l) => JSON.parse(l));
    assert.equal(one.some((e) => e.post_id === "1900000000000014000"), false, "own post dropped");
    assert.equal(new Set(one.map((e) => e.post_id)).size, one.length, "no duplicates in run 1");
    assert.ok(one.every((e) => e.source !== "search"), "search hits replying to the streamer are labeled reply (or deduped)");
    const second: string[] = [];
    assert.equal(await main({ env: { ...env, X_AGENT_INPUT: run2 }, write: (l) => second.push(l) }), 0);
    assert.deepEqual(second.map((l) => [JSON.parse(l).post_id, JSON.parse(l).source]), [["2119999999999999999", "reply"]], `run 2 from ${run2}`);
    if (run1.includes("fixtures")) assert.match(first.join("\n"), /🔥/, "UTF-8 emoji kept");
  }
});

test("search hit replying to the streamer is labeled reply; recentIds stay bounded", async () => {
  const events = xAgentPostEvents(post("700", "7", { in_reply_to_user_id: "42", source: "search" }), { ownerId: "42" });
  assert.equal(events[0].source, "reply");
  const poller = new XChatPoller({ env: base });
  for (let i = 0; i < 2100; i += 1) await poller.ingestPosts(JSON.stringify(post(String(10_000 + i), "7")));
  assert.equal((poller as unknown as { recentIds: string[] }).recentIds.length, 2000);
});

test("reply tags only the target author: other auto-mentioned users are excluded", async () => {
  assert.deepEqual(xReplyExcludeIds({ targetAuthorId: "7", mentionedUserIds: ["9", "7", "8", "9"] }), ["8", "9"]);
  assert.deepEqual(xReplyExcludeIds({ targetAuthorId: "7", mentionedUserIds: ["9"], excludeReplyUserIds: ["5"] }), ["5"]);
  assert.deepEqual(xReplyExcludeIds({}), []);
  assert.throws(() => xReplyExcludeIds({ excludeReplyUserIds: ["abc"] }), /numeric/);
  const env = { X_REPLY_AS: "bot_account", X_BOT_USER_ACCESS_TOKEN: "b", X_REPLY_WRITE: "1" };
  const dry = await xReplyPost("101", "hola", { env, targetAuthorId: "7", mentionedUserIds: ["7", "8"] });
  assert.ok(dry.dry_run);
  assert.deepEqual(dry.request.body, { text: "hola", reply: { in_reply_to_tweet_id: "101", exclude_reply_user_ids: ["8"] } });
  assert.equal(dry.approval_id, xReplyApprovalId("101", "hola", ["8"]));
  assert.notEqual(dry.approval_id, xReplyApprovalId("101", "hola"));
  const plain = await xReplyPost("101", "hola", { env });
  assert.ok(plain.dry_run && !("exclude_reply_user_ids" in plain.request.body.reply));
});
