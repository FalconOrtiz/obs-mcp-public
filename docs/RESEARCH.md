# obs-websocket v5 research

Protocol reference, read before implementation:

https://github.com/obsproject/obs-websocket/blob/master/docs/generated/protocol.md

Authentication check in the server, used to confirm the hash steps:

https://github.com/obsproject/obs-websocket/blob/master/src/utils/Crypto.cpp

The notes below are the parts this server implements. Request and field names match that generated protocol document (obs-websocket 5.x, RPC version 1).

## Connection

OBS 28+ exposes obs-websocket v5. The default listen address used here is `ws://127.0.0.1:4455`.

The first HTTP request may set `Sec-WebSocket-Protocol` to `obswebsocket.json` (JSON text frames) or `obswebsocket.msgpack`. This server offers only `obswebsocket.json`.

After the upgrade the server immediately sends opcode 0 `Hello`. The client may send only opcode 1 `Identify` until it receives opcode 2 `Identified`. Any other message before that is closed with `WebSocketCloseCode::NotIdentified` (4007).

Base object for every message:

```json
{ "op": 0, "d": {} }
```

## Opcodes used

| `op` | Name | Direction in this server |
| --- | --- | --- |
| 0 | Hello | received |
| 1 | Identify | sent |
| 2 | Identified | received |
| 3 | Reidentify | not sent in phase 1 |
| 5 | Event | ignored (`eventSubscriptions` is `EventSubscription::None`, value 0) |
| 6 | Request | sent |
| 7 | RequestResponse | received |
| 8 | RequestBatch | sent |
| 9 | RequestBatchResponse | received |

`Identify` sends `rpcVersion: 1`. `Hello.rpcVersion` must be at least 1. `Identified.negotiatedRpcVersion` must be 1.

`Request` data is `requestType`, `requestId`, and optional `requestData`. `RequestResponse` echoes those ids and includes `requestStatus` (`result`, `code`, optional `comment`) plus optional `responseData`. `result` is true only for `RequestStatus::Success` (100).

`RequestBatch` data is `requestId`, optional `haltOnFailure` (default false), optional `executionType` (default `SerialRealtime` = 0), and `requests`. Items use the same shape as a request, with optional `requestId`. `SerialFrame` is 1 and `Parallel` is 2. `RequestBatchResponse` returns `results` in processing order. With `haltOnFailure`, OBS stops after the first failure and returns only the processed items.

## Authentication

From "Creating an authentication string" in the protocol document, and from `Utils::Crypto::GenerateSecret` / `CheckAuthenticationString`:

1. If `Hello.d` has no `authentication` object, `Identify` omits `authentication`.
2. Otherwise concatenate the password with the server `salt`, SHA256 the UTF-8 bytes, and base64-encode the raw digest. That string is the base64 secret.
3. Concatenate the base64 secret with the server `challenge`, SHA256 that UTF-8 string, and base64-encode the raw digest. That is `Identify.d.authentication`.
4. A missing or wrong string closes the socket with `WebSocketCloseCode::AuthenticationFailed` (4009).

The protocol page shows this Hello example with password `supersecretpassword`:

```json
{
  "challenge": "+IxH4CnCiqpX1rM9scsNynZzbOe4KhDeYcTNS3PDaeY=",
  "salt": "lM1GncleQOaCu9lT1yeUZhFYnqhsLLP1G5lAGo3ixaI="
}
```

Running the steps above on those inputs produces:

```text
1Ct943GAT+6YQUUX47Ia/ncufilbe6+oD6lY+5kaCu4=
```

The Identify example printed later on the same page (`Dj6cLS+jrNA0HpCArRg0Z/Fc+YHdt2FQfAvgD1mip6Y=`) does not match that challenge, salt, and password. The client follows the written algorithm and `Crypto.cpp`, and the test suite locks the computed vector. It does not copy the unmatched example string.

## Request status codes

Mapped in `src/protocol.ts` from the protocol `RequestStatus` table:

| Code | Name |
| --- | --- |
| 0 | Unknown |
| 10 | NoError |
| 100 | Success |
| 203 | MissingRequestType |
| 204 | UnknownRequestType |
| 205 | GenericError |
| 206 | UnsupportedRequestBatchExecutionType |
| 207 | NotReady |
| 300 | MissingRequestField |
| 301 | MissingRequestData |
| 400 | InvalidRequestField |
| 401 | InvalidRequestFieldType |
| 402 | RequestFieldOutOfRange |
| 403 | RequestFieldEmpty |
| 404 | TooManyRequestFields |
| 500 | OutputRunning |
| 501 | OutputNotRunning |
| 502 | OutputPaused |
| 503 | OutputNotPaused |
| 504 | OutputDisabled |
| 505 | StudioModeActive |
| 506 | StudioModeNotActive |
| 600 | ResourceNotFound |
| 601 | ResourceAlreadyExists |
| 602 | InvalidResourceType |
| 603 | NotEnoughResources |
| 604 | InvalidResourceState |
| 605 | InvalidInputKind |
| 606 | ResourceNotConfigurable |
| 607 | InvalidFilterKind |
| 700 | ResourceCreationFailed |
| 701 | ResourceActionFailed |
| 702 | RequestProcessingFailed |
| 703 | CannotAct |

Close codes that stop the retry loop: 4009 authentication failed, 4010 unsupported RPC version, 4011 session invalidated. The protocol says a client that receives 4011 (the session list Kick button) must not reconnect automatically.

Other connection failures retry with exponential backoff.

## Requests this server sends

| Tool | Requests |
| --- | --- |
| `obs_status` | `GetVersion`, `GetStreamStatus`, `GetRecordStatus`, `GetStudioModeEnabled`, `GetCurrentProgramScene`, `GetCurrentPreviewScene`, `GetStats` |
| `obs_list_scenes` | `GetSceneList` |
| `obs_list_inputs` | `GetInputList` (`inputKind` optional) |
| `obs_get_scene_items` | `GetSceneItemList` |
| `obs_list_transitions` | `GetSceneTransitionList`, `GetCurrentSceneTransition` |
| `obs_set_current_scene` | `SetCurrentProgramScene` |
| `obs_set_preview_scene` | `SetCurrentPreviewScene` (only when studio mode is on; otherwise OBS returns 506) |
| `obs_set_studio_mode` | `SetStudioModeEnabled` |
| `obs_set_transition` | `SetCurrentSceneTransition` (`transitionName`), `SetCurrentSceneTransitionDuration` (`transitionDuration`, 50 through 20000) |
| `obs_trigger_studio_transition` | `TriggerStudioModeTransition` |
| `obs_set_input_mute` | `SetInputMute` |
| `obs_set_input_volume` | `SetInputVolume` (`inputVolumeDb` -100 through 26, or `inputVolumeMul` 0 through 20) |
| `obs_set_scene_item_enabled` | `SetSceneItemEnabled` |
| `obs_set_source_filter_enabled` | `SetSourceFilterEnabled` |
| `obs_stream` | `StartStream`, `StopStream`, `ToggleStream` |
| `obs_record` | `StartRecord`, `StopRecord`, `PauseRecord`, `ResumeRecord` |
| `obs_replay_buffer` | `StartReplayBuffer`, `StopReplayBuffer`, `SaveReplayBuffer` |
| `obs_virtualcam` | `StartVirtualCam`, `StopVirtualCam`, `ToggleVirtualCam` |
| `obs_batch` | opcode 8 with the caller-supplied request list |
| `obs_backup_scene_collection` | `GetVersion`, `GetSceneList`, `GetGroupList`, `GetSceneTransitionList`, `GetCurrentSceneTransition`, then `GetSceneItemList` per scene and `GetGroupSceneItemList` per group (`sceneName`) |

`GetCurrentPreviewScene` failure 505 or 506 is reported as `previewScene: null` inside `obs_status`. Other failed status calls fail the tool.

## Stream key

`GetStreamServiceSettings` / `SetStreamServiceSettings` use `streamServiceType` and `streamServiceSettings`. The protocol notes that simple RTMP uses type `rtmp_custom` with settings fields `server` and `key`. `key` is the stream key.

Tool results and backup files replace, inside any `streamServiceSettings` object, fields named `key`, fields whose names include both `stream` and `key`, and fields whose names include `password`, `secret`, or `token`. `server` is left intact. A field named `key` outside `streamServiceSettings` is not treated as a stream key. The request actually written to the socket on `dry_run: false` still contains the original values.

`obs_set_stream_service` calls `SetStreamServiceSettings` with `streamServiceType` (default `rtmp_custom`) and settings `server` plus `key`. The key is taken only from the `OBS_STREAM_KEY` environment variable. The tool schema has no key field. The preview request always shows `key` as `[REDACTED]`.

Recipe filter ids match obs-filters: `noise_suppress_filter` (`method: rnnoise`), `noise_gate_filter`, `compressor_filter`, and `limiter_filter`. Stinger settings use the obs-transitions property names `path`, `tp_type`, `transition_point`, and `audio_fade_style`. `Sleep` is sent only inside a `RequestBatch`, which is the only place the protocol allows it. There is no obs-websocket request to create a transition, so a stinger must already exist in OBS.

## Chat bot trust boundary

`packages/obs-bot` does not call a chat platform. A `ChatEvent` is `{ platform, user, text, kind, ts }` with `platform` one of `twitch`, `youtube`, `kick`, or `x`. `privileged` is accepted only when the value is exactly `true`.

Chat text is escaped (`&`, `<`, `>`) and wrapped in `<untrusted_chat>`. Patterns that ask to ignore prior instructions, replace the persona, hide that the speaker is a bot, or reveal the prompt set `flagged`. A flagged event never matches an OBS rule, even when the text starts with an allow-listed command.

Default rules match only at the start of the trimmed text: `!starting`, `!live`, `!brb`, `!ending` map to `SetCurrentProgramScene` for those scene names. The language-model provider cannot add rules or actions.

Reply budgets: Twitch 20/30s, YouTube 10/60s, Kick 20/30s, X 5/15min. OBS action budgets: 4/30s, and 2/60s on X. `KillSwitch.kill()` aborts the in-flight `AbortSignal`. A watched file is polled every 200ms.

`OBS_LLM_PROVIDER` selects `mock` (the default) or `openai-compatible`. The key, model, and base URL are `OBS_LLM_API_KEY`, `OBS_LLM_MODEL`, and `OBS_LLM_BASE_URL`. Outbound chat always sets `bot: true`, prefixes `[bot]`, and includes `I'm a bot.`

## Twitch EventSub and Send Chat

EventSub WebSocket handling:

https://dev.twitch.tv/docs/eventsub/handling-websocket-events/

`channel.chat.message` version 1, including the moderator-badge example used as a fixture:

https://dev.twitch.tv/docs/eventsub/eventsub-subscription-types/

Send Chat Message:

https://dev.twitch.tv/docs/api/reference/#send-chat-message

The socket URL is `wss://eventsub.wss.twitch.tv/ws`. The first frame is `session_welcome`. Its `payload.session.id` is the `session_id` on the subscription transport, and `keepalive_timeout_seconds` (default 10) is the window to subscribe before Twitch closes the socket. The subscription body is `type: channel.chat.message`, `version: "1"`, condition `broadcaster_user_id` plus `user_id`, transport `method: websocket`. WebSocket subscriptions require a user access token. The documented scope for reading chat is `user:read:chat`. If an app access token is used instead, Twitch also requires `user:bot` from the user who sends the chat message and either `channel:bot` from the broadcaster or moderator status. This client sends the bearer token from `TWITCH_ACCESS_TOKEN` and does not request an app token.

Chat notifications use `metadata.message_type: notification` and `subscription_type: channel.chat.message`. The text is `payload.event.message.text`. The login is `chatter_user_login`. A non-null `reply` object is a reply. Badge `set_id` of `broadcaster` or `moderator`, or a chatter id equal to the broadcaster id, is privileged. Twitch may resend a frame with the same `message_id`; the client keeps a set of ids. The bot's own `chatter_user_id` is dropped so a send does not loop.

`session_reconnect` carries `payload.session.reconnect_url`. The client connects to that string unchanged and does not subscribe again. The previous socket closes after the new welcome. A socket that closes without that frame is left down. Twitch does not replay missed events.

Send Chat is `POST https://api.twitch.tv/helix/chat/messages` with `broadcaster_id`, `sender_id`, and `message`. The documented user-token scope is `user:write:chat`, and `sender_id` must be the user in the token. Success is HTTP 200 with `data[0].message_id` and `is_sent`. The message field max is 500 characters. This client also refuses text that does not include `I'm a bot.` A local limiter of 20 messages per 30 seconds returns `dropReason: local_rate_limit` without a request, ahead of Twitch's HTTP 429.

## YouTube live chat

List, the polling method this client calls:

https://developers.google.com/youtube/v3/live/docs/liveChatMessages/list

Insert:

https://developers.google.com/youtube/v3/live/docs/liveChatMessages/insert

Optional server-streaming method, not called here:

https://developers.google.com/youtube/v3/live/docs/liveChatMessages/streamList

Quota table (list 5, insert 20, streamList 5):

https://developers.google.com/youtube/data/determine_quota_cost

`liveChatMessages.list` is `GET https://www.googleapis.com/youtube/v3/liveChat/messages` with `liveChatId`, `part=snippet,authorDetails`, and `pageToken` set to the previous `nextPageToken`. The response `pollingIntervalMillis` is the wait before the next list. Messages are oldest to newest. `offlineAt` means the chat is offline and the loop stops. `snippet.type` of `textMessageEvent` maps to a `ChatEvent`. `authorDetails.isChatOwner` or `isChatModerator` is privileged. `chatEndedEvent` and the other non-text types are ignored.

`liveChatMessages.insert` is `POST` to the same path with `part=snippet`. The body sets `snippet.liveChatId`, `snippet.type` to `textMessageEvent`, and `snippet.textMessageDetails.messageText`. Quota cost is 20. The text must include `I'm a bot.` The local cap is the bot's YouTube reply limit, 10 per 60 seconds.

`streamList` is a long-lived gRPC server stream. Google documents the same 5-unit cost and recommends it over polling. This package does not open that stream and does not depend on a gRPC library. Polling is the implemented fallback.

The default YouTube Data API daily quota is 10,000 units. List-only polling at 5,000 ms is `3600000 / 5000 * 5 = 3600` units per hour, so `10000 / 3600` hours of the default day. The number of list calls that fit in a day is `floor(10000 / 5) = 2000`. A call that would pass the budget is not sent.

## Kick webhooks

Signature rules and the instruction not to hardcode the public key:

https://github.com/KickEngineering/KickDevDocs/blob/main/events/webhook-security.md

Public key response (`publicKey` PEM, or a raw PEM body):

https://github.com/KickEngineering/KickDevDocs/blob/main/apis/public-key.md

`chat.message.sent` version 1 payload, including sender badges:

https://github.com/KickEngineering/KickDevDocs/blob/main/events/event-types.md

Headers used here are `Kick-Event-Message-Id`, `Kick-Event-Subscription-Id`, `Kick-Event-Signature` (base64), `Kick-Event-Message-Timestamp`, `Kick-Event-Type`, and `Kick-Event-Version`. The signed string is `messageId.timestamp.rawBody`. Verification is RSA PKCS#1 v1.5 with SHA-256, which is what `crypto.createVerify("RSA-SHA256")` checks. The key is fetched from `https://api.kick.com/public/v1/public-key` and cached for the process. A timestamp more than five minutes from the local clock is rejected before the signature check. Moderator and broadcaster badges, and a sender id equal to the broadcaster id, are privileged. `replies_to` makes the kind `reply`. This client does not call a Kick chat-send endpoint.

## X mentions and drafts

Mentions timeline:

https://developer.x.com/en/docs/twitter-api/tweets/timelines/api-reference/get-users-id-mentions

The read is `GET https://api.x.com/2/users/:id/mentions` with `tweet.fields=created_at,conversation_id,in_reply_to_user_id`, `expansions=author_id`, and `user.fields=username`. The token is `X_USER_ACCESS_TOKEN` (OAuth 2.0 user context, primary), or `X_BEARER_TOKEN` (app-only, read-only fallback) when that user token is unset. A tweet with `in_reply_to_user_id` equal to `X_USER_ID` is a reply. The rest are mentions. `privileged` stays false, so X text cannot match the OBS allow list.

Announce posts and replies are JSON files in `X_DRAFT_DIR` with `status: "draft"` and `bot: true`. `publishXDraft` throws `XApprovalRequired` for every input. The reader never requests `POST /2/tweets`. There is no variable that enables a post. A later code change, after the owner approves posting, is the only way a post could exist.

## X audience filter: followers and subscribers

Sources, checked 2026-10-18:
- The official OpenAPI spec at `https://api.x.com/2/openapi.json` (version 2.172). docs.x.com answered 403 to the fetch tool, so the spec was read directly.
- Pricing: https://docs.x.com/x-api/getting-started/pricing (mirror read: https://x-preview.mintlify.app/x-api/getting-started/pricing).
- Followers endpoint: https://docs.x.com/x-api/users/get-followers.
- User fields: https://docs.x.com/x-api/fundamentals/data-dictionary.

Followers:
- `GET /2/users/{id}/followers` exists. It takes `max_results` from 1 to 1000 and `pagination_token`. Security is an OAuth 2.0 user token (`follows.read tweet.read users.read`), an OAuth 1.0a user token, or an app-only bearer token.
- Pricing: "Following/Followers: Read" costs $0.010 per resource returned, deduplicated per UTC day.
- List mode (`X_FOLLOWERS_MODE=list`, opt-in) fetches the full set once per stream (paginated with `max_results=1000`) and caches it in the state file for `X_FOLLOWERS_TTL_MS` (default 6 h).
- Cost estimate for about 555 followers: 555 x $0.010 = $5.55 per full fetch, plus $0.010 for the `followers_count` lookup. A second fetch on the same UTC day should be deduplicated. This is above a $5 cap on its own, so the poller refuses the fetch and stops with a clear event when `spent + estimate >= X_STREAM_CREDIT_CAP_USD`. After a fetch it re-reads the balance on the next tick, so the real cost counts toward the cap.
- Default since 2026-10-18 (design decision): a per-author follow check. The field is `connection_status`. In the spec, the `UserFieldsParameter` enum lists `connection_status`, and `components.schemas.User.properties.connection_status` points to `#/components/schemas/UserConnectionStatus`. That is an array of `blocking`, `follow_request_received`, `follow_request_sent`, `followed_by`, `following`, `muting`, described as "A connection between the authenticated User and this User". `followed_by` means the author follows the authenticated user.
- The new-author lookup (`GET /2/users?ids=`) requests `connection_status` on the same User read. The cost is about $0.010 per unique new author, with no extra charge for the field. It is cached with the author for `X_FOLLOW_STATUS_TTL_MS` (default 6 h), in memory and in `X_STATE_FILE`.
- The full follower list (above) is opt-in only, with `X_FOLLOWERS_MODE=list`, and keeps the cap refusal.
- ⚠️ Not verified live. The field is relative to the authenticated user, so it needs `X_USER_ACCESS_TOKEN`. With only `X_BEARER_TOKEN`, or if X omits the field, the poller warns once, treats follow status as unknown, filters those authors out under `followers`, and logs each dropped post.

Paid subscribers (Subscriptions, formerly Super Follows):
- There is no endpoint that lists who subscribes to you.
- The spec does define user fields `subscription.subscribes_to_you` and `subscribes_to_you` ("Indicates if this User subscribes to you"), relative to the authenticated user. The code reads that field on the author lookup (`GET /2/users?ids=`, $0.010 per user, cached), so `subscribers` works without scraping.
- ⚠️ Unverified live. It needs `X_USER_ACCESS_TOKEN` (user context); an app-only bearer token cannot answer "you". If X omits the field, no author passes the `subscribers` filter.
- Third-party "subscriptions" APIs (for example tweetapi.com, xquik.com) are not official X APIs and are not used.

Author billing:
- Expanded users are billed as "User: Read" ($0.010 each). The poller requests posts without `expansions`, then looks up only author ids missing from its cache (in memory and in `X_STATE_FILE`). A known author is not requested again.
- With `X_EXPAND_AUTHORS=off`, there is no user lookup at all, and events show `author_id`.

Verified badge: `verified` is set only for `verified_type` in `blue`, `business`, `government`, or `verified: true`. `none` and any other value are not verified.

## X live broadcast chat (Broadcasts API, Livestream API, Bots)

Sources: the official spec at `https://api.x.com/2/openapi.json` (v2.172), the Livestream API pages (getting-started, authentication, chat/get-chat-history, chat/accessing-live-chat), `x-api/activity/event-payloads`, `xchat/bots`, and the pricing page. Checked 2026-10-18.

| Endpoint | Auth (from the spec) | Used by |
|---|---|---|
| `GET /2/broadcasts` (`ids` or `max_results` 1-100) | OAuth 2.0 user token, scope `broadcast.read` (or OAuth 1.0a user) | auto-detect (`listXBroadcasts`) |
| `GET /2/broadcasts/{id}` | user token, `broadcast.read` | not used |
| `GET /2/broadcasts/{id}/chat` (`max_results` 1-200, `pagination_token`, newest first) | user token, `broadcast.read`; only for a broadcast **owned by the authenticated user** | `readXBroadcastChat` |
| `POST /2/broadcasts/{id}/chat` (`text` 1-140, `reply_to`) | user token, `broadcast.read` + `broadcast.write`; posted as the token's user | `xBroadcastChatSend` (dry_run) |
| `POST /2/broadcasts/{id}/chat/mutes` (`user_id`, `end_at_ms`, `message_id`) | `broadcast.read` + `broadcast.write`; caller must be host or moderator | `xBroadcastChatMute` (dry_run) |
| `DELETE /2/broadcasts/{id}/chat/{message_id}` | `broadcast.read` + `broadcast.write`; host or moderator | `xBroadcastChatDelete` (dry_run) |
| `GET/POST /2/broadcasts/chat/moderators` | owner, read/write | not used; the owner adds the bot as moderator |
| `POST /2/activity/subscriptions` with event `broadcast.chat` | user context with `broadcast.read`, a registered webhook (CRC) | not built; `xaaBroadcastChatEvent` maps the payload |

Important limits:

- **Access is gated.** The Livestream API needs a whitelisted app (access request form on the docs site). Without it the reads fail with 403; the poller warns once and keeps mentions/search running.
- **Chat history is post-broadcast.** The docs say `GET /2/broadcasts/{id}/chat` is "only accessible after the broadcast has finished". Real-time chat is delivered by the X Activity API `broadcast.chat` webhook (also `broadcast.chat.remove`). The polling source is built as requested and will start returning messages if X serves them during the broadcast; the reliable live path is the webhook, which needs a public HTTPS endpoint and is not built here.
- **Cost.** The pricing page lists no Broadcasts or chat price (Post read $0.005, User read $0.010). The poller counts each chat message as one read for the USD cap (`X_STREAM_CREDIT_CAP_USD`) and still checks `/2/usage/credits` balance, so unknown prices are capped, not unbounded.

Who can read chat:

- **User token (`X_USER_ACCESS_TOKEN`, owner, `broadcast.read`)**: yes, for your own broadcasts (history; live via the webhook).
- **Bot token (`X_BOT_TOKEN`, `xcbot_…`)**: no for the owner's chat history (owner only). It can post as the bot account; mute/delete need it to be a moderator (inferred from "host or moderator" plus the bot's `broadcast.read/broadcast.write` scopes). ⚠️ Not verified live.

Bots rules (XChat bots docs): bot management endpoints use the app bearer (OAuth 2.0 app-only); the `xcbot_…` token is shown once, one active token per bot; the bot account carries the "Automated by @owner" label; default limit 1 bot per project. Bot replies must follow the X automation rules: label the account, no unsolicited mass messages, no spam. Our write tools default to dry_run and never post on their own.

## X Activity API webhook (real-time broadcast chat)

Checked 2026-10-18 in `x-api/webhooks/introduction`, `x-api/webhooks/quickstart`, `x-api/activity/introduction`, `x-api/activity/quickstart` and spec v2.172.

- **CRC:** X sends `GET <url>?crc_token=...` on registration, hourly, and on `PUT /2/webhooks/{id}`. Reply 200 with JSON `{"response_token": "sha256=" + base64(HMAC-SHA256(secret, crc_token))}`. The secret is the app's **OAuth 2.0 client secret**, or for OAuth 1.0-only apps the **consumer secret**. Never the bearer or a user token. A failed CRC marks the webhook invalid and stops delivery.
- **Signatures:** each POST carries `X-Twitter-Webhooks-Signature-OAuth2` (client secret, recommended) and/or legacy `X-Twitter-Webhooks-Signature` (consumer secret). Both are `sha256=<base64 HMAC-SHA256>` over the raw body bytes. The receiver prefers the OAuth2 header, falls back to the legacy one, compares in constant time, and returns 401 otherwise.
- **Note on the request:** the task named `X_CONSUMER_SECRET` and `x-twitter-webhooks-signature`. That is the documented legacy path and is supported; the docs now recommend the OAuth 2.0 client secret, so `X_CLIENT_SECRET` is also accepted and used first.
- **Subscriptions:** `POST /2/activity/subscriptions` `{event_type: "broadcast.chat", filter: {user_id}, webhook_id}`. `broadcast.chat` and `broadcast.chat.remove` are private events: user-context OAuth 2.0 with `broadcast.read`. `GET` lists, `DELETE /2/activity/subscriptions/{id}` removes (spec accepts user or app tokens). `broadcast.start`/`broadcast.end` are public (app-only OK) and could drive auto-detect later.
- **Webhooks:** `POST /2/webhooks {url}`, `GET`, `PUT /2/webhooks/{id}` (re-CRC), `DELETE`. Called with the app-only bearer. The URL must be public HTTPS.
- **Cost:** the Activity docs bill delivered Post events as Posts; no price is listed for `broadcast.chat`. The receiver counts each unique message as one read toward `X_MAX_READS_PER_STREAM` and checks the credit balance on the usual interval against `X_STREAM_CREDIT_CAP_USD`.
- `broadcast.chat.remove` is accepted and ignored for now (no retraction in the JSON feed).

## Agent read mode and the follows.read finding (2026-10-18)

- Design decision: reads go through Grok Bot's built-in public X tools (free; 30/min, 1000/day, max 25 per call), called by Stream Chat Host as agent tools. `X_READ_MODE=agent` turns off every HTTP read in the poller; posts arrive as JSON lines and use the same dedupe, audience filter and feed.
- Paid calls left: the follow check (`GET /2/users?ids=&user.fields=connection_status`, $0.010 per new author, cached) and reply posts (`POST /2/tweets`, $0.015, or $0.200 with a URL, per the pricing page). Agent mode tracks this spend locally against `X_STREAM_CREDIT_CAP_USD`, because `/2/usage/credits` would be one more HTTP call.
- Earlier finding: `connection_status` came back absent with the current token. The field describes the relationship to the authenticated user and needs the `follows.read` scope on the user token. Documented as required in README and SETUP; the warning text now says so. Re-authorize the token with `follows.read` (old tokens keep their old scopes). ⚠️ Confirm on the next live check.
- **Can the `xcbot_` token post?** No. Spec v2.172: `POST /2/tweets` security is `OAuth2UserToken [tweet.read, tweet.write, users.read]` or OAuth 1.0a user. `CreateBotRequest.scopes` / `RotateBotTokenRequest.scopes`: defaults to `dm.read, dm.write, tweet.read, users.read, media.write`, with broadcast moderation adding `broadcast.read, broadcast.write`; the Bots page says a scope outside that set returns 400. `tweet.write` is never available, and a bot has no password or login, so it cannot do the OAuth user flow either. `X_REPLY_AS=bot` now fails with that explanation.
- **Fallback:** `X_REPLY_AS=user` (streamer's token with `tweet.write`, default) or `X_REPLY_AS=bot_account`: a normal X account for the bot (for example `@name_bot`), labeled Automated in its settings, authorized through the app's OAuth 2.0 PKCE flow with `tweet.read users.read tweet.write offline.access`, stored as `X_BOT_USER_ACCESS_TOKEN`.
- Agent-mode state file and input contract: docs/AGENT_MODE.md.
