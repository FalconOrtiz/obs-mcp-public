# Verification

The unit tests never open a connection to a real OBS instance. Every networked check uses the in-repo fake obs-websocket server (`test/fake-obs.ts`), which accepts a `node:http` WebSocket upgrade and speaks opcodes 0, 1, 2, 5, 6, 7, 8, and 9.

Command:

```bash
node --experimental-strip-types --test --test-reporter spec test/*.test.ts
```

Result for v0.1.0 (Node v22.18.0): **101 tests, 101 passed, 0 failed**. `engines.node` is `>=22.18`. The per-file table below is from the phase 1 to 5b history and is kept for reference.

| File | Tests |
| --- | --- |
| `test/protocol.test.ts` | 4 |
| `test/client.test.ts` | 8 |
| `test/tools.test.ts` | 7 |
| `test/mcp.test.ts` | 3 |
| `test/recipes.test.ts` | 6 |
| `test/bot.test.ts` | 6 |
| `test/twitch.test.ts` | 8 |
| `test/youtube.test.ts` | 5 |
| `test/kick-x.test.ts` | 5 |

Phase 2 checks: scene-pack dry-run does not connect; apply writes the backup before `CreateScene` and skips scenes that already exist; transition and mic-chain request order; celebration `RequestBatch` hold; `obs_set_stream_service` refuses a `key` argument, sends `OBS_STREAM_KEY` on the wire, and does not echo it. Live OBS was still not available.

Phase 3 checks: chat text is escaped and wrapped as untrusted data; an injection-flagged `!brb` does not send `SetCurrentProgramScene`; a privileged `!brb` sends that request once; the reply limiter drops the message past capacity; `kill()` aborts a hanging model call in under a second; a kill file does the same; `llm.ts` contains the env name `OBS_LLM_API_KEY` and no provider key, and the OpenAI-compatible provider throws when that variable is unset. No live LLM and no live OBS were used.

Phase 4 checks: a local EventSub stand-in (`test/fake-eventsub.ts`) plus `test/fixtures/twitch`. Welcome leads to one `channel.chat.message` subscription and no client text frames. Notifications map to `ChatEvent`; duplicates, the bot's own user, and subscriber-only badges do not. Send Chat posts the Helix body, refuses a message that does not say `I'm a bot.`, and does not echo the token. The local send cap is 20 per 30 seconds. Reconnect follows `reconnect_url` unchanged and does not subscribe again. A missing welcome and an expired subscribe window reject. No live Twitch call was made.

Phase 5 checks: `youtubeQuotaPlan(5000)` is 2,000 list calls per day and 3,600 list units per hour against a 10,000 unit day. The poller waits `pollingIntervalMillis`, sends `nextPageToken` as `pageToken`, skips `chatEndedEvent` and duplicate ids, and stops on `offlineAt` or a spent list budget. Insert costs 20 units, requires `I'm a bot.`, and applies the 10-per-60-seconds reply cap. `streamList` stays unimplemented. No live YouTube call was made.

Phase 5b checks: a locally generated RSA key signs `messageId.timestamp.rawBody`. A matching Kick webhook maps to `ChatEvent`; a bad signature, a tampered body, and a stale timestamp are rejected; duplicates and non-chat types are ignored. The public key is loaded from a mocked `https://api.kick.com/public/v1/public-key` response and is not embedded. X mentions come from `test/fixtures/x/mentions.json`. Announce and reply drafts are files. `publishXDraft` throws, and neither adapter source posts to `/2/tweets`. No live Kick or X call was made.

## What the tests cover

- SHA256 authentication string against the protocol steps and a frozen vector for the documented salt and challenge
- Identify with and without a password, including opcode, `rpcVersion`, and `eventSubscriptions: 0`
- Authentication failure close code 4009 is not retried
- Two dropped connections, then success, with growing backoff
- RequestBatch opcode 8 and RequestBatchResponse opcode 9, including `haltOnFailure`
- Request status 600 mapped to a resource-not-found message
- Close code 4011 does not open another connection
- An event (opcode 5) delivered before a response does not break the request
- Redaction of `streamServiceSettings` key, stream key, password, secret, and token fields
- Dry-run writes return the request body and do not open a socket
- Confirmed writes send that request
- A live batch sends the original stream key and returns a redacted copy
- `obs_status` tolerates preview failure 506 when studio mode is off
- Scene-collection backup writes JSON, redacts keys inside scene items, and refuses to overwrite unless asked
- MCP `initialize`, `tools/list` (read tools first, 25 tools, `dry_run` default true), `tools/call`, unknown method, and a stdio parse error
- The password is not written to the stdio server's stdout or stderr during that exchange
- The stdio server closes the OBS socket and exits with code 0 when stdin ends

## Live check on Windows (2026-10-18)

Run against the phase 1 server before this release.

- OBS Studio 32.1.0, obs-websocket 5.7.2, on `ws://127.0.0.1:4455`.
- Password authentication through `OBS_WS_PASSWORD`, set as a user environment variable. The value was not logged or printed.
- MCP `initialize` and `tools/list`: OK.
- `obs_status`: OK (current scene, 30 fps, not streaming, not recording).
- `obs_list_scenes`: OK, 9 scenes.
- `obs_list_inputs` and `obs_list_transitions`: OK.
- `obs_set_studio_mode` with the default dry run returned the request and did not send it.
- `obs_set_current_scene` with `dry_run: false` switched to a second scene and back. `obs_status` confirmed each switch. The write was approved by the operator first.
- Bug found: the process stayed alive after stdin closed, because the OBS WebSocket stayed open. Fixed in `src/index.ts`: on stdin end or close, the server closes the OBS client and exits. The test "stdio server closes the OBS socket and exits when stdin ends" covers it.

## X read sources and read cap (fake HTTP, `test/x-poll.test.ts`)

- `readXMentions` sends `since_id` and `max_results` (5 to 100) and keeps the newest id in a shared `XCursorState`.
- `readXSearch` reads recent search with `conversation_id:<live post id>`, plus `OR #hashtag` when one is set. It sends `since_id` and `max_results` (10 to 100).
- `XChatPoller` merges both sources into one `ChatEvent` feed, deduped by post id. It saves the `since_id` values to a JSON state file and loads them after a restart.
- `X_MAX_READS_PER_STREAM` counts posts read. `max_results` is clamped to the remaining budget. At the cap, polling stops and one `system` warning event is emitted. A source is skipped when the remaining budget is below its minimum `max_results`.
- Every request is a GET. Replies stay draft-only through `XDrafts`.
- `X_STREAM_CREDIT_CAP_USD` is required. Without it, `XChatPoller.poll()` refuses to start and makes no X call. At stream start and every `X_CREDIT_CHECK_INTERVAL_MS` (default 900000), it reads `GET /2/usage/credits` `total_balance`. When start balance minus current balance reaches the cap, polling stops and one `system` event "X credit cap reached" is emitted. Free grants that expire during the stream are not counted as spend.
- `obs_set_stream_service` redacts the key in the dry-run preview, the live result, and errors, even when OBS echoes the key in an error comment.
- On a 429, the poller skips only that source until `x-rate-limit-reset` (60 s fallback when the header is missing, at most 15 min) and emits one `system` event. Read errors never throw out of `poll()`. A failed credits read fails closed: no posts are read that tick.

### X live dry run (2026-10-18, offline replay of captured X responses, fake token)

A local harness replayed captured mentions and recent-search responses from a test account. There was no network and no real token. It ran 4 ticks at 30 s, with a $5 cap and `#Technology`.

- Bugs found during the dry run and fixed:
  - Search needed a live post id. It now runs hashtag-only (`#tag`), live-post-only, or both. `X_LIVE_POST_ID` and `X_LIVE_HASHTAG` are read from env.
  - Hashtag posts were labeled `mention`. Every X event now has `source` (`mention`, `reply`, `search`, `hashtag`), `badges` (`verified` when X says so, otherwise `[]`), `time` and `post_id`. `ts` and `id` stay as aliases for the bot core.
  - The read counter double-counted posts X re-sent. It now counts unique post ids per UTC day, which matches X billing deduplication. `postsReturned` keeps the raw total.
  - The default `X_CREDIT_CHECK_INTERVAL_MS` is now 300000 (5 min).
- Re-run after the fixes:
  - Tick 1: 8 events (5 mentions and 3 hashtag posts). The overlapping post was deduped, reads 8.
  - Tick 2: 1 new mention. 5 re-sent mentions were not counted, reads 9 (14 before the fix). Search got a 429 and was skipped until reset; mentions kept flowing.
  - Tick 3: credit cap reached at $5.14 of $5.00. One system event, and polling stopped.
  - Tick 4: no X calls. State file kept both `since_id` values. `TOKEN_LEAK=false`.
- Launcher: `scripts/run-x-live.ps1` loads `OBS_WS_PASSWORD`, `OBS_STREAM_KEY`, `OBS_STREAM_SERVER` and every `X_*` from User scope into the process. It prints only names and set or not set, refuses to start without `X_STREAM_CREDIT_CAP_USD`, then runs `scripts/x-live.ts` (a read-only JSON-lines feed, polled every `X_POLL_INTERVAL_MS`, default 25000). The Linux CI has no PowerShell, so the test checks the script text.
- Cost note: expanded users are billed as User reads ($0.010 each, per docs.x.com pricing). They are not in the read counter. The USD credit cap covers them.
- `source`/`kind` `reply` means a reply to `X_USER_ID` only (`in_reply_to_user_id == X_USER_ID`). Replies to anyone else are `mention` (or `message` in search). Posts under the live post stay `search`.
- `scripts/x-live.ts` and `run-x-live.ps1` exit 1 with the missing variable name when `X_USER_ACCESS_TOKEN` or `X_USER_ID` is unset. A 401 from X is fatal: one clear error naming `X_USER_ACCESS_TOKEN`, exit 1, no retry.
- A first real tick against the X API passed.
- The `verified` badge is set only for `verified_type` blue, business, or government, or `verified: true`.
- `X_MAX_TICKS` stops the feed after N polls. `X_MAX_RESULTS` is clamped per endpoint (mentions 5 to 100, search 10 to 100).
- `X_EXPAND_AUTHORS` (default on): posts are read without `expansions`. Only unknown author ids are looked up (`GET /2/users?ids=`, $0.010 each), and the cache is kept in memory and in `X_STATE_FILE`. Off shows `author_id` only.
- `X_AUDIENCE_FILTER`: `followers` fetches the follower set once per `X_FOLLOWERS_TTL_MS` (paginated, $0.010 per follower; about $5.55 for 555 followers). It refuses and stops if the estimate would reach the cap, and re-reads the balance after the fetch. `subscribers` uses the official `subscription.subscribes_to_you` user field (⚠️ not yet verified live). See docs/RESEARCH.md.
- Tested with fakes only. No live follower fetch has run.
- Design decision: a per-author follow check. `X_FOLLOWERS_MODE=lookup` (default) reads `connection_status` (`followed_by`) on the new-author lookup and caches it for `X_FOLLOW_STATUS_TTL_MS`. `list` is opt-in. A missing field or an app-only token warns once. Unknown authors are filtered out under `followers`, and each dropped post is logged. Tested with fakes only.

## X live chat (Broadcasts API)

1. Confirm the app is whitelisted for the Livestream API, and the user token has `broadcast.read` (re-authorize if it was minted before).
2. Dry run: `X_LIVE_CHAT=auto`, `X_SECONDARY_SOURCES=mentions`, `X_MAX_TICKS=3`, run `scripts/run-x-live.ps1`. Expect "live broadcast … detected" while live, or one warning and mentions only.
3. After the broadcast ends, set `X_BROADCAST_ID` to its id and rerun: chat history should appear with `source: "live_chat"`.
4. Write tools: call with the default dry_run and check the preview shows `Bearer [REDACTED]`. Do not set `X_CHAT_WRITE=1` without the owner's OK.

## X webhook receiver (owner steps, nothing automatic)

1. Set `X_CLIENT_SECRET` (or `X_CONSUMER_SECRET`) in User scope. Never paste it in chat.
2. Run `node --experimental-strip-types scripts/x-webhook.ts`; expect `listening on http://127.0.0.1:8787/x/webhook`.
3. Local CRC smoke test: `curl "http://127.0.0.1:8787/x/webhook?crc_token=test"` returns a `response_token` starting with `sha256=`. An unsigned `curl -X POST` returns 401.
4. Owner decision: expose it over HTTPS (for example `cloudflared tunnel --url http://127.0.0.1:8787`), register the URL with `POST /2/webhooks`, and confirm the CRC passes.
5. `scripts/x-activity-subscriptions.ts create --webhook-id <id>` (dry run), check the preview, then rerun with `--live --confirm` only with the owner's OK.
6. Go live and confirm `live_chat` lines appear on stdout. Delete the subscription afterwards if it should not stay.

## Agent read mode

1. `X_READ_MODE=agent`, `X_AUDIENCE_FILTER=all`: pipe one saved `get_users_mentions` result into `scripts/x-agent-feed.ts`; expect feed lines and zero X HTTP calls.
2. With `X_AUDIENCE_FILTER=followers`: re-authorized token with `follows.read`; expect `follower` badges and no "connection_status" warning. If the warning appears, the scope is still missing.
3. Replies: run `xReplyPost` dry; check `approval_id` and `cost_usd`. A live reply only after the owner approves that exact text, with `X_REPLY_WRITE=1`.
4. Bot accounts: X only lets an Automated bot account reply to posts that @mention it or that it wrote. Pass `targetAuthorId` and `mentionedUserIds` (or `excludeReplyUserIds`) so the reply sets `reply.exclude_reply_user_ids` and tags only the person it answers.
