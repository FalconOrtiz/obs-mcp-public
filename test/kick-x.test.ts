import assert from "node:assert/strict";
import { createSign, generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_REPLY_LIMITS } from "../packages/obs-bot/src/ratelimit.ts";
import { KICK_PUBLIC_KEY_URL, KickWebhooks, fetchKickPublicKey } from "../packages/obs-bot/src/adapters/kick.ts";
import { X_ENV, XDrafts, readXMentions } from "../packages/obs-bot/src/adapters/x.ts";
import { publishXDraft } from "../packages/obs-bot/src/adapters/x-publish.ts";

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const exported = publicKey.export({ type: "spki", format: "pem" });
if (typeof exported !== "string") throw new Error("expected a PEM string");
const pem = exported;
const timestamp = "2026-10-17T16:08:06Z";
const now = () => Date.parse(timestamp);

function sign(messageId: string, rawBody: string): string {
  const signer = createSign("RSA-SHA256");
  signer.update(`${messageId}.${timestamp}.${rawBody}`);
  signer.end();
  return signer.sign(privateKey).toString("base64");
}

function headers(messageId: string, signature: string, type = "chat.message.sent"): Record<string, string> {
  return {
    "Kick-Event-Message-Id": messageId,
    "Kick-Event-Subscription-Id": "sub-1",
    "Kick-Event-Signature": signature,
    "Kick-Event-Message-Timestamp": timestamp,
    "Kick-Event-Type": type,
    "Kick-Event-Version": "1",
  };
}

test("a signed Kick chat webhook becomes a privileged ChatEvent", async () => {
  const rawBody = await readFile(new URL("./fixtures/kick/chat-message.json", import.meta.url), "utf8");
  const hooks = new KickWebhooks({ publicKeyPem: pem, now });
  const messageId = "01KICKMSG00000000000000001";
  const received = await hooks.receive(headers(messageId, sign(messageId, rawBody)), rawBody);
  assert.equal(received.event?.platform, "kick");
  assert.equal(received.event?.user, "sender_name");
  assert.equal(received.event?.text, "Hello from Kick chat");
  assert.equal(received.event?.kind, "message");
  assert.equal(received.event?.privileged, true);
  assert.equal(received.event?.ts, "2026-10-17T16:08:06Z");

  const viewer = JSON.parse(rawBody) as {
    sender: { user_id: number; identity: { badges: Array<{ type: string }> } };
    replies_to?: unknown;
  };
  viewer.sender.identity.badges = [{ type: "subscriber" }];
  const viewerBody = JSON.stringify(viewer);
  const viewerId = "01KICKMSG00000000000000002";
  const plain = await hooks.receive(headers(viewerId, sign(viewerId, viewerBody)), viewerBody);
  assert.equal(plain.event?.privileged, false);

  viewer.replies_to = { message_id: "parent" };
  viewer.sender.user_id = 123456789;
  const replyBody = JSON.stringify(viewer);
  const replyId = "01KICKMSG00000000000000003";
  const reply = await hooks.receive(headers(replyId, sign(replyId, replyBody)), replyBody);
  assert.equal(reply.event?.kind, "reply");
  assert.equal(reply.event?.privileged, true);
});

test("a bad signature, a tampered body, a stale timestamp, and a duplicate are rejected", async () => {
  const rawBody = await readFile(new URL("./fixtures/kick/chat-message.json", import.meta.url), "utf8");
  const hooks = new KickWebhooks({ publicKeyPem: pem, now });
  const messageId = "01KICKMSG00000000000000010";
  const signature = sign(messageId, rawBody);
  await assert.rejects(() => hooks.receive(headers(messageId, `${signature.slice(0, -2)}aa`), rawBody), /signature was rejected/);
  await assert.rejects(() => hooks.receive(headers(messageId, signature), `${rawBody}\n`), /signature was rejected/);
  const stale = new KickWebhooks({ publicKeyPem: pem, now: () => now() + (6 * 60 * 1000) });
  await assert.rejects(() => stale.receive(headers(messageId, signature), rawBody), /outside the allowed window/);

  const freshId = "01KICKMSG00000000000000011";
  const first = await hooks.receive(headers(freshId, sign(freshId, rawBody)), rawBody);
  const second = await hooks.receive(headers(freshId, sign(freshId, rawBody)), rawBody);
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.event, undefined);

  const otherId = "01KICKMSG00000000000000012";
  const other = await hooks.receive(headers(otherId, sign(otherId, "{}"), "channel.followed"), "{}");
  assert.equal(other.ignored, true);
  assert.equal(other.event, undefined);
});

test("the Kick public key is fetched and is not stored in source", async () => {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    calls.push(String(input));
    return new Response(JSON.stringify({ publicKey: pem }), { status: 200 });
  };
  const raw = await fetchKickPublicKey(async () => new Response(pem, { status: 200 }));
  assert.equal(raw.includes("BEGIN PUBLIC KEY"), true);
  const rawBody = await readFile(new URL("./fixtures/kick/chat-message.json", import.meta.url), "utf8");
  const hooks = new KickWebhooks({ fetchImpl, now });
  const firstId = "01KICKMSG00000000000000020";
  const secondId = "01KICKMSG00000000000000021";
  await hooks.receive(headers(firstId, sign(firstId, rawBody)), rawBody);
  await hooks.receive(headers(secondId, sign(secondId, rawBody)), rawBody);
  assert.deepEqual(calls, [KICK_PUBLIC_KEY_URL]);
  const source = await readFile(new URL("../packages/obs-bot/src/adapters/kick.ts", import.meta.url), "utf8");
  assert.equal(source.includes("BEGIN PUBLIC KEY"), false);
  assert.match(source, /api\.kick\.com\/public\/v1\/public-key/);
});

test("X mentions and replies are read from a fixture and the token stays out of the result", async () => {
  const fixture = JSON.parse(await readFile(new URL("./fixtures/x/mentions.json", import.meta.url), "utf8")) as unknown;
  const calls: Array<{ url: string; authorization: string }> = [];
  const events = await readXMentions({
    env: { X_USER_ACCESS_TOKEN: "x-token-test", X_USER_ID: "42" },
    fetchImpl: async (input, init) => {
      const headers = init?.headers as Record<string, string>;
      calls.push({ url: String(input), authorization: headers.authorization });
      return new Response(JSON.stringify(fixture), { status: 200 });
    },
  });
  assert.equal(calls.length, 1);
  const url = new URL(calls[0].url);
  assert.equal(url.origin + url.pathname, "https://api.x.com/2/users/42/mentions");
  assert.equal(url.searchParams.get("expansions"), "author_id");
  assert.equal(calls[0].authorization, "Bearer x-token-test");
  assert.equal(events.length, 2);
  assert.equal(events[0].kind, "mention");
  assert.equal(events[0].user, "ada");
  assert.equal(events[0].privileged, false);
  assert.equal(events[1].kind, "reply");
  assert.equal(events[1].user, "grace");
  assert.equal(JSON.stringify(events).includes("x-token-test"), false);
  let called = false;
  await assert.rejects(() => readXMentions({
    env: { X_USER_ACCESS_TOKEN: `\${${X_ENV.userAccessToken}}`, X_BEARER_TOKEN: `\${${X_ENV.bearerToken}}`, X_USER_ID: "42" },
    fetchImpl: async () => {
      called = true;
      return new Response("{}", { status: 200 });
    },
  }), /X_USER_ACCESS_TOKEN or X_BEARER_TOKEN is not set/);
  assert.equal(called, false);
});

test("X announce and reply drafts stay local and publish always refuses", async () => {
  assert.equal(DEFAULT_REPLY_LIMITS.x.capacity, 5);
  assert.equal(DEFAULT_REPLY_LIMITS.x.perMs, 15 * 60 * 1000);
  const directory = await mkdtemp(path.join(tmpdir(), "obs-mcp-x-"));
  const drafts = new XDrafts({
    env: { X_DRAFT_DIR: directory },
    now: () => new Date("2026-10-17T00:00:00.000Z"),
    replyLimit: { capacity: 1, perMs: 60_000 },
  });
  const announce = await drafts.announce("[bot] We are live. I'm a bot.");
  const reply = await drafts.reply("[bot] Thanks. I'm a bot.", "1001");
  const blocked = await drafts.reply("[bot] Again. I'm a bot.", "1001");
  assert.equal(announce.status, "draft");
  assert.equal(announce.bot, true);
  assert.equal("draft" in reply && reply.draft?.kind, "reply");
  assert.equal("dropReason" in blocked && blocked.dropReason, "local_rate_limit");
  await assert.rejects(() => drafts.announce("hello"), /identify as a bot/);
  const names = await readdir(directory);
  assert.equal(names.length, 2);
  const saved = JSON.parse(await readFile(path.join(directory, `${announce.id}.json`), "utf8")) as { status: string; text: string };
  assert.equal(saved.status, "draft");
  await assert.rejects(async () => publishXDraft(announce), /Auto-post stays off/);
  await assert.rejects(async () => publishXDraft({ ...announce, post: true }), /Auto-post stays off/);
  const after = JSON.parse(await readFile(path.join(directory, `${announce.id}.json`), "utf8")) as { status: string };
  assert.equal(after.status, "draft");
  const publisher = await readFile(new URL("../packages/obs-bot/src/adapters/x-publish.ts", import.meta.url), "utf8");
  const reader = await readFile(new URL("../packages/obs-bot/src/adapters/x.ts", import.meta.url), "utf8");
  assert.equal(publisher.includes("fetch"), false);
  assert.equal(publisher.includes("api.x.com"), false);
  assert.equal(reader.includes("/2/tweets"), false);
});
