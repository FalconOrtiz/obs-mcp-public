import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { XChatPoller } from "../packages/obs-bot/src/adapters/x.ts";
import { createXWebhookServer, verifyXWebhookSignature, xCrcResponse, xWebhookConfigFromEnv } from "../packages/obs-bot/src/adapters/x-webhook.ts";
import type { ChatEvent } from "../packages/obs-bot/src/events.ts";
import { buildActivityRequest, main as activityMain } from "../scripts/x-activity-subscriptions.ts";
import { feedLine } from "../scripts/x-live.ts";

const CLIENT = "client-secret-test";
const CONSUMER = "consumer-secret-test";
const sign = (secret: string, body: string) => `sha256=${createHmac("sha256", secret).update(body).digest("base64")}`;
const env = { X_USER_ACCESS_TOKEN: "x-token-test", X_USER_ID: "42", X_STREAM_CREDIT_CAP_USD: "10" };
const delivery = (id: string, author = "7", extra: Record<string, unknown> = {}) => ({ data: {
  event_type: "broadcast.chat", created_at: "2026-10-18T13:00:00.000Z",
  payload: { broadcast_id: "1mGPaZaAdNqJN", message_id: id, message: `hola ${id}`, is_subscriber: false, is_moderator: false, author: { data: { id: author, username: `user${author}` } }, ...extra },
} });
const fakeX = () => {
  const paths: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    paths.push(url.pathname);
    if (url.pathname === "/2/usage/credits") return new Response(JSON.stringify({ data: { total_balance: 50 } }));
    if (url.pathname === "/2/users") return new Response(JSON.stringify({ data: (url.searchParams.get("ids") ?? "").split(",").map((id) => ({ id, username: `user${id}`, connection_status: id === "7" ? ["followed_by"] : [] })) }));
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  return { paths, fetchImpl };
};

async function withServer(sink: ConstructorParameters<typeof XChatPoller>[0] | { ingest: (d: unknown) => Promise<ChatEvent[]> }, run: (base: string, events: ChatEvent[], idle: () => Promise<void>, logs: string[]) => Promise<void>, secrets = { clientSecret: CLIENT, consumerSecret: CONSUMER }) {
  const events: ChatEvent[] = [];
  const logs: string[] = [];
  const target = "ingest" in sink ? sink : new XChatPoller(sink);
  const receiver = createXWebhookServer({ config: { ...secrets, host: "127.0.0.1", port: 0, path: "/x/webhook" }, sink: target, onEvent: (e) => events.push(e), log: (l) => logs.push(l) });
  const { port } = await receiver.listen();
  try {
    await run(`http://127.0.0.1:${port}/x/webhook`, events, receiver.idle, logs);
  } finally {
    await receiver.close();
  }
}

test("CRC: GET crc_token returns sha256=base64(HMAC-SHA256(client secret, token)), legacy secret as fallback", async () => {
  assert.deepEqual(xCrcResponse("challenge_string", { clientSecret: CLIENT, consumerSecret: CONSUMER }), { response_token: sign(CLIENT, "challenge_string") });
  assert.deepEqual(xCrcResponse("abc", { consumerSecret: CONSUMER }), { response_token: sign(CONSUMER, "abc") });
  await withServer({ ingest: async () => [] }, async (base, _e, _i, logs) => {
    const res = await fetch(`${base}?crc_token=challenge_string`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/json");
    const body = await res.text();
    assert.deepEqual(JSON.parse(body), { response_token: sign(CLIENT, "challenge_string") });
    assert.equal(body.includes(CLIENT), false);
    assert.equal((await fetch(base)).status, 400);
    assert.equal((await fetch(base.replace("/x/webhook", "/other?crc_token=a"))).status, 404);
    assert.equal(logs.join("\n").includes(CLIENT), false);
  });
});

test("POST signatures: bad, missing, or wrong-secret signatures are rejected with 401 and never ingested", async () => {
  let ingested = 0;
  await withServer({ ingest: async () => { ingested += 1; return []; } }, async (base, _e, idle) => {
    const body = JSON.stringify(delivery("1"));
    const post = (headers: Record<string, string>) => fetch(base, { method: "POST", body, headers });
    assert.equal((await post({})).status, 401, "no signature");
    assert.equal((await post({ "x-twitter-webhooks-signature-oauth2": sign("wrong", body) })).status, 401, "bad oauth2");
    assert.equal((await post({ "x-twitter-webhooks-signature": sign(CLIENT, body) })).status, 401, "legacy header signed with the wrong secret");
    assert.equal((await post({ "x-twitter-webhooks-signature-oauth2": sign(CLIENT, body + " ") })).status, 401, "body tampered");
    await idle();
    assert.equal(ingested, 0);
    assert.equal((await post({ "x-twitter-webhooks-signature-oauth2": sign(CLIENT, body) })).status, 200);
    assert.equal((await post({ "x-twitter-webhooks-signature": sign(CONSUMER, body) })).status, 200, "legacy fallback");
    await idle();
    assert.equal(ingested, 2);
  });
  assert.equal(verifyXWebhookSignature(Buffer.from("x"), { "x-twitter-webhooks-signature-oauth2": sign(CLIENT, "x") }, { consumerSecret: CONSUMER }), false, "oauth2 header without client secret");
});

test("signed broadcast.chat deliveries flow through dedupe, audience filter and cap into JSON feed lines", async () => {
  const x = fakeX();
  await withServer({ env: { ...env, X_AUDIENCE_FILTER: "followers", X_MAX_READS_PER_STREAM: "3" }, fetchImpl: x.fetchImpl }, async (base, events, idle) => {
    const send = async (payload: unknown) => {
      const body = JSON.stringify(payload);
      const res = await fetch(base, { method: "POST", body, headers: { "x-twitter-webhooks-signature-oauth2": sign(CLIENT, body) } });
      assert.equal(res.status, 200);
    };
    await send(delivery("2090000000000000001", "7", { is_subscriber: true, reply_to: "2090000000000000000" }));
    await send(delivery("2090000000000000001", "7"));
    await send(delivery("2090000000000000002", "8"));
    await send({ data: { event_type: "broadcast.chat.remove", payload: { message_id: "2090000000000000001" } } });
    await send([delivery("2090000000000000003", "7"), delivery("2090000000000000004", "7")]);
    await idle();
    const feed = events.filter((e) => e.kind !== "system").map((e) => JSON.parse(feedLine(e)));
    assert.deepEqual(feed.map((f) => [f.source, f.user, f.post_id, f.kind]), [
      ["live_chat", "user7", "2090000000000000001", "reply"],
      ["live_chat", "user7", "2090000000000000003", "message"],
    ], "duplicate dropped, non-follower 8 filtered, cap of 3 stops before message 4");
    assert.ok(feed[0].badges.includes("subscriber") && feed[0].badges.includes("follower"));
    assert.match(events.at(-1)?.text ?? "", /X read cap reached: 3 of 3/);
    assert.equal(x.paths.filter((p) => p === "/2/usage/credits").length, 1, "credits checked once per interval");
  });
});

test("receiver config: localhost default, configurable port, refuses without a secret; ingest refuses without a cap", async () => {
  assert.throws(() => xWebhookConfigFromEnv({}), /X_CLIENT_SECRET .*X_CONSUMER_SECRET/);
  assert.deepEqual(xWebhookConfigFromEnv({ X_CONSUMER_SECRET: CONSUMER }), { clientSecret: undefined, consumerSecret: CONSUMER, host: "127.0.0.1", port: 8787, path: "/x/webhook" });
  assert.equal(xWebhookConfigFromEnv({ X_CLIENT_SECRET: CLIENT, X_WEBHOOK_PORT: "9100" }).port, 9100);
  assert.throws(() => xWebhookConfigFromEnv({ X_CLIENT_SECRET: CLIENT, X_WEBHOOK_PORT: "99999" }), /port/);
  await assert.rejects(() => new XChatPoller({ env: { X_USER_ACCESS_TOKEN: "t", X_USER_ID: "42" } }).ingest(delivery("1")), /X_STREAM_CREDIT_CAP_USD is not set/);
});

test("subscription script: dry run by default, live needs --live and --confirm, token redacted", async () => {
  assert.deepEqual(buildActivityRequest("create", { "webhook-id": "123" }, { X_USER_ID: "42" }).body, { event_type: "broadcast.chat", filter: { user_id: "42" }, webhook_id: "123" });
  assert.throws(() => buildActivityRequest("delete", {}, {}), /--id/);
  let calls = 0;
  const fetchImpl = (async () => { calls += 1; return new Response('{"echo":"x-token-test"}', { status: 200 }); }) as typeof fetch;
  const out: string[] = [];
  const write = (l: string) => out.push(l);
  assert.equal(await activityMain(["create", "--webhook-id", "123"], { env, fetchImpl, write }), 0);
  assert.equal(await activityMain(["delete", "--id", "9", "--live"], { env, fetchImpl, write }), 1, "--confirm required");
  assert.equal(calls, 0);
  assert.match(out[0], /"dry_run":true.*Bearer \[REDACTED\]/);
  assert.equal(await activityMain(["list", "--live"], { env, fetchImpl, write }), 0);
  assert.equal(calls, 1);
  assert.equal(out.join("\n").includes("x-token-test"), false);
});
