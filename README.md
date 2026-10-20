# obs-mcp

[![CI](https://github.com/FalconOrtiz/obs-mcp-public/actions/workflows/ci.yml/badge.svg)](https://github.com/FalconOrtiz/obs-mcp-public/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) ![Node >= 22.18](https://img.shields.io/badge/node-%3E%3D22.18-brightgreen)

MCP server for OBS Studio over [obs-websocket](https://github.com/obsproject/obs-websocket) v5 (OBS Studio 28 or newer). It speaks the WebSocket protocol on stdio as a Model Context Protocol server: list scenes and inputs, switch program and preview scenes, mute and set volume, toggle filters and scene items, and start or stop streaming, recording, the replay buffer, and the virtual camera.

By Falcon Ortiz. Built with Grok Bot.

Write tools default to a dry run. They return the exact obs-websocket request they would send and do not change OBS until `dry_run` is set to `false`. Stream service key fields are removed from every tool result.

Unofficial, not affiliated with the OBS Project.

## Quick start

```bash
git clone https://github.com/FalconOrtiz/obs-mcp-public.git obs-mcp
cd obs-mcp
cp .env.example .env   # fill in only what you use; never commit it
npm test
npm start              # stdio MCP server; needs OBS with obs-websocket enabled
```

## Requirements

- Node.js 22.18 or newer (global `WebSocket`, no runtime dependencies)
- OBS Studio 28 or newer, with the built-in WebSocket server enabled
- Default server URL `ws://127.0.0.1:4455`

## Enable obs-websocket

1. Open OBS Studio.
2. Go to **Tools > WebSocket Server Settings**.
3. Enable the WebSocket server.
4. Leave the port at `4455`, or note the port you set.
5. Set a server password if you want one. The MCP server reads it from `OBS_WS_PASSWORD`.

OBS 28 and later ship obs-websocket v5. No extra plugin is required.

## Install

This package has no dependencies. From the plugin directory:

```bash
node --experimental-strip-types src/index.ts
```

The process speaks MCP on stdin and stdout. Logs go to stderr.

## MCP configuration

The plugin root `mcp.json` follows the Agent Plugins schema. It launches the stdio server and passes the password variable through:

```json
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
  "mcpServers": {
    "obs": {
      "type": "stdio",
      "command": "node",
      "args": ["--experimental-strip-types", "${PLUGIN_ROOT}/src/index.ts"],
      "env": {
        "OBS_WS_PASSWORD": "${OBS_WS_PASSWORD}"
      }
    }
  }
}
```

A Cursor project config can point at the same entry file. Set the password in the environment (or in Cursor's env interpolation) and do not commit it:

```json
{
  "mcpServers": {
    "obs": {
      "type": "stdio",
      "command": "node",
      "args": ["--experimental-strip-types", "/path/to/obs-mcp/src/index.ts"],
      "env": {
        "OBS_WS_URL": "ws://127.0.0.1:4455",
        "OBS_WS_PASSWORD": "${env:OBS_WS_PASSWORD}"
      }
    }
  }
}
```

If a client leaves `${OBS_WS_PASSWORD}` unexpanded, the server treats that literal value as unset so it is not sent to OBS as a password.

| Variable | Default | Purpose |
| --- | --- | --- |
| `OBS_WS_URL` | `ws://127.0.0.1:4455` | obs-websocket URL (`ws:` or `wss:`) |
| `OBS_WS_PASSWORD` | unset | Server password, when OBS requires one |
| `OBS_WS_RETRY_ATTEMPTS` | `4` | Connection attempts |
| `OBS_WS_RETRY_BASE_MS` | `200` | First backoff delay; later delays double |
| `OBS_WS_RETRY_MAX_MS` | `2000` | Backoff cap |

## Tools

Read tools are listed first. Every write tool takes `dry_run` (boolean, default `true`) and, on a dry run, returns the obs-websocket request body it would send.

| Tool | Kind | obs-websocket requests |
| --- | --- | --- |
| `obs_status` | read | `GetVersion`, `GetStreamStatus`, `GetRecordStatus`, `GetStudioModeEnabled`, `GetCurrentProgramScene`, `GetCurrentPreviewScene`, `GetStats` |
| `obs_list_scenes` | read | `GetSceneList` |
| `obs_list_inputs` | read | `GetInputList` |
| `obs_get_scene_items` | read | `GetSceneItemList` |
| `obs_list_transitions` | read | `GetSceneTransitionList`, `GetCurrentSceneTransition` |
| `obs_set_current_scene` | write | `SetCurrentProgramScene` |
| `obs_set_preview_scene` | write | `SetCurrentPreviewScene` |
| `obs_set_studio_mode` | write | `SetStudioModeEnabled` |
| `obs_set_transition` | write | `SetCurrentSceneTransition`, `SetCurrentSceneTransitionDuration` |
| `obs_trigger_studio_transition` | write | `TriggerStudioModeTransition` |
| `obs_set_input_mute` | write | `SetInputMute` |
| `obs_set_input_volume` | write | `SetInputVolume` |
| `obs_set_scene_item_enabled` | write | `SetSceneItemEnabled` |
| `obs_set_source_filter_enabled` | write | `SetSourceFilterEnabled` |
| `obs_stream` | write | `StartStream`, `StopStream`, or `ToggleStream` |
| `obs_record` | write | `StartRecord`, `StopRecord`, `PauseRecord`, or `ResumeRecord` |
| `obs_replay_buffer` | write | `StartReplayBuffer`, `StopReplayBuffer`, or `SaveReplayBuffer` |
| `obs_virtualcam` | write | `StartVirtualCam`, `StopVirtualCam`, or `ToggleVirtualCam` |
| `obs_batch` | write | raw `RequestBatch` (opcode 8) |
| `obs_backup_scene_collection` | write | reads scenes, items, groups, and transitions, then writes a JSON file |
| `obs_recipe_scene_pack` | write | `CreateScene` for Starting, Live, BRB, and Ending |
| `obs_recipe_transitions` | write | Fade plus optional stinger settings, then Fade again |
| `obs_recipe_mic_chain` | write | noise suppression, gate, compressor, limiter |
| `obs_recipe_celebration` | write | Celebration scene, then a batch that holds and returns |
| `obs_set_stream_service` | write | `SetStreamServiceSettings` using `OBS_STREAM_KEY` |

Call `obs_backup_scene_collection` with `dry_run: false` and a `path` before changing scenes or scene items. Pass `overwrite: true` to replace an existing file.

## Recipes

`obs_recipe_scene_pack`, `obs_recipe_transitions`, `obs_recipe_mic_chain`, and `obs_recipe_celebration` default to dry-run. Setting `dry_run` to false requires `backup_path`. The server writes a scene-collection backup, then applies the recipe. Scenes and filters that already exist are skipped or updated instead of duplicated.

`obs_set_stream_service` reads the stream key only from `OBS_STREAM_KEY`. Do not pass the key as an argument. Dry-run output uses `[REDACTED]`. The ingest URL comes from the `server` argument or `OBS_STREAM_SERVER`.

| Variable | Purpose |
| --- | --- |
| `OBS_STREAM_SERVER` | Ingest URL when `server` is omitted |
| `OBS_STREAM_KEY` | Stream key. Never printed by a tool result |

## Chat bot

`packages/obs-core` is the shared obs-websocket client. `packages/obs-bot` is the chat bot.

A chat message is a `ChatEvent`: `platform` (`twitch`, `youtube`, `kick`, or `x`), `user`, `text`, `kind` (`message`, `mention`, `reply`, or `system`), and `ts`. Chat text is wrapped as untrusted data. Instruction-override attempts are flagged and cannot fire OBS actions.

Only privileged viewers can trigger the allow list: `!starting`, `!live`, `!brb`, and `!ending`. Those map to `SetCurrentProgramScene`. The model cannot add actions.

Replies and actions are rate limited per platform. Twitch replies default to 20 per 30 seconds. `bot.kill()` or a file passed as `killFile` stops new work and aborts an in-flight model call in under a second.

Every outbound message has `bot: true` and includes `I'm a bot.`

LLM settings are environment names only: `OBS_LLM_PROVIDER` (`mock` or `openai-compatible`), `OBS_LLM_API_KEY`, `OBS_LLM_MODEL`, and `OBS_LLM_BASE_URL`. No provider key is stored in the source.

## Twitch

`TwitchEventSubClient` connects to EventSub at `wss://eventsub.wss.twitch.tv/ws`. After `session_welcome` it posts `channel.chat.message` version `1` to `https://api.twitch.tv/helix/eventsub/subscriptions` with condition `broadcaster_user_id` and `user_id`. Notifications become `ChatEvent` values. `sendTwitchChat` posts to `https://api.twitch.tv/helix/chat/messages`.

Tests use a local WebSocket stand-in and `test/fixtures/twitch`. They do not call Twitch.

| Variable | Purpose |
| --- | --- |
| `TWITCH_CLIENT_ID` | Application client id, sent as `Client-Id` |
| `TWITCH_ACCESS_TOKEN` | User access token, sent as `Authorization: Bearer` |
| `TWITCH_BOT_USER_ID` | Bot user id. EventSub `user_id` and chat `sender_id` |
| `TWITCH_BROADCASTER_ID` | Channel id. EventSub `broadcaster_user_id` and chat `broadcaster_id` |

A literal `${TWITCH_ACCESS_TOKEN}` is treated as unset. The token is not copied into results or error text.

A moderator badge, a broadcaster badge, or a chatter whose id is the broadcaster sets `privileged`. A subscriber badge does not. The bot's own `chatter_user_id` is ignored. A repeated `message_id` is ignored. `session_reconnect` is followed using the URL exactly as Twitch sent it, and the client does not subscribe again. A socket that drops without that frame stays closed.

Outbound text must already contain `I'm a bot.` and must be at most 500 characters. The in-process send limit is 20 messages per 30 seconds. The 21st call does not reach the network.

Going live needs a Twitch application, a bot user, and a user access token with `user:read:chat` and `user:write:chat`. `TWITCH_BOT_USER_ID` must be the user inside that token, and that user must be allowed to speak in the broadcaster's room. WebSocket subscriptions use a user access token. An app access token is a different Twitch path and also needs `user:bot` on the bot plus `channel:bot` from the broadcaster, or moderator status.

## YouTube

`YouTubeLiveChat` polls `liveChatMessages.list` and posts with `liveChatMessages.insert`. `liveChatMessages.streamList` is a gRPC server stream with a quota cost of 5. It is not implemented. Polling is the fallback, and it waits for `pollingIntervalMillis` from each response before the next list call. `nextPageToken` is sent back as `pageToken`.

| Call | Quota units |
| --- | --- |
| `liveChatMessages.list` | 5 |
| `liveChatMessages.insert` | 20 |
| `liveChatMessages.streamList` | 5, not called |
| Default daily budget | 10,000 |

`youtubeQuotaPlan(5000)` reports 2,000 list calls per day, 3,600 list units per hour, and `10000 / 3600` hours of polling before that daily budget is spent on lists alone. A list call that would pass 10,000 units is not sent. An insert that would pass it throws before the request.

| Variable | Purpose |
| --- | --- |
| `YOUTUBE_ACCESS_TOKEN` | OAuth bearer token for the chat |
| `YOUTUBE_LIVE_CHAT_ID` | Live chat id used for list and insert |

Text events become `ChatEvent` values. The channel owner and chat moderators are privileged. Other snippet types, including `chatEndedEvent`, are skipped. Duplicate message ids are skipped. `offlineAt` stops the loop. Inserts must already contain `I'm a bot.` The local reply cap is 10 per 60 seconds.

Tests use `test/fixtures/youtube` and an injected `fetch`. They do not call Google.

Going live needs a Google Cloud project with the YouTube Data API v3 enabled, an OAuth consent screen, and a token that can read and write that live chat. The default quota is 10,000 units per day. A higher quota is a separate Google approval. At a 5 second poll, list calls alone use about 3,600 units per hour. Set both variables outside the repo.

## Kick

`KickWebhooks` checks `chat.message.sent` webhooks. The signature string is `Kick-Event-Message-Id`, `Kick-Event-Message-Timestamp`, and the raw body, joined with `.`, then RSA SHA-256 PKCS#1 v1.5 against `Kick-Event-Signature`. The public key is fetched from `https://api.kick.com/public/v1/public-key`. It is not stored in source. A timestamp more than five minutes off is rejected. A bad signature is rejected. A repeated message id is ignored. Moderator badges and the broadcaster are privileged.

This phase does not post chat to Kick.

Going live needs a Kick developer application, a public webhook URL, and a subscription to `chat.message.sent` version 1. The running process must be able to fetch the public-key endpoint so a rotated key still verifies.

## X

`readXMentions` calls `GET https://api.x.com/2/users/:id/mentions`. A post is a `reply` only when `in_reply_to_user_id` equals `X_USER_ID`. Other posts are mentions. Recent search (`X_LIVE_POST_ID`, `X_LIVE_HASHTAG`) adds `search` and `hashtag` events. None of them are privileged, so they cannot fire OBS scene commands.

`XDrafts` writes announce posts and replies as local JSON files under `X_DRAFT_DIR`. `publishXDraft` always throws. There is no call to `POST /2/tweets` and no environment flag that turns posting on.

### Token setup (OAuth 2.0 user context)

`X_USER_ACCESS_TOKEN` is the primary token. It is an OAuth 2.0 user-context token for the streamer's own account.

1. In the X Developer Console (https://console.x.com), create a Project and an App.
2. Under the app's User authentication settings, turn on OAuth 2.0. Choose a confidential client (Web App), set a callback URL, and request the scopes `tweet.read users.read follows.read offline.access`, plus `tweet.write` if you will post replies. **`follows.read` is required for the follow check**: without it X omits `connection_status` and every author is "unknown" (filtered out under `X_AUDIENCE_FILTER=followers`). A token minted before you added a scope must be re-authorized; adding the scope in the console does not upgrade old tokens.
3. Run the OAuth 2.0 Authorization Code with PKCE flow once, signed in as the streamer, to get an access token (and a refresh token, from `offline.access`). Access tokens expire after about 2 hours. A 401 means the token must be refreshed or generated again.
4. Store it on the PC in User scope. Never paste it in chat, and never commit it.
   - Preferred: a hidden prompt, so the value never reaches the screen or shell history:

     ```powershell
     $t = Read-Host "X user access token" -AsSecureString
     [Environment]::SetEnvironmentVariable('X_USER_ACCESS_TOKEN', [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($t)), 'User')
     Remove-Variable t
     ```

   - Or `setx X_USER_ACCESS_TOKEN <token>`. That writes the value into PowerShell history (PSReadLine), so clear that history afterwards.
5. Set `X_USER_ID` (the numeric account id) the same way, then open a new terminal.

`X_BEARER_TOKEN` is a read-only fallback. It is an app-only token, so it cannot call user-context endpoints or see user-context fields such as `connection_status` and `subscription`. It is used only when `X_USER_ACCESS_TOKEN` is unset.

| Variable | Purpose |
| --- | --- |
| `X_USER_ACCESS_TOKEN` | Primary. OAuth 2.0 user-context token, sent as `Authorization: Bearer` |
| `X_BEARER_TOKEN` | Read-only app-only fallback, used only when the user token is unset |
| `X_USER_ID` | Account whose mentions and followers are read |
| `X_DRAFT_DIR` | Directory for local draft files |
| `X_STREAM_CREDIT_CAP_USD` | Required. Per-stream USD spend cap (hard stop) |
| `X_CREDIT_CHECK_INTERVAL_MS` | Balance check interval, default 300000 |
| `X_LIVE_POST_ID`, `X_LIVE_HASHTAG` | Search sources. Set either one or both |
| `X_POLL_INTERVAL_MS` | Poll interval, default 25000 |
| `X_MAX_TICKS` | Stop after N polls |
| `X_MAX_RESULTS` | Per-call `max_results`, clamped to each endpoint's min and max |
| `X_MAX_READS_PER_STREAM` | Optional cap on unique posts read |
| `X_EXPAND_AUTHORS` | Default on. Looks up unknown authors once and caches them. Off shows `author_id` only |
| `X_AUDIENCE_FILTER` | `all` (default), `followers`, `subscribers`, `followers_or_subscribers` |
| `X_FOLLOWERS_MODE` | `lookup` (default): per-author follow check through `connection_status` on the new-author lookup, about $0.01 per unique new author, cached. `list`: opt-in full follower list, $0.01 per follower (about $5.55 for 555), refused if it would reach the cap |
| `X_FOLLOW_STATUS_TTL_MS` | Per-author follow-status cache TTL, default 21600000 (6 h) |
| `X_FOLLOWERS_TTL_MS` | Follower-list cache TTL in list mode, default 21600000 (6 h) |
| `X_STATE_FILE` | JSON file for `since_id` values, the author cache, and the follower set |

Run the feed on Windows with `scripts/run-x-live.ps1`. It loads these variables from User scope and prints only their names.

Reply drafts follow the X reply cap of 5 per 15 minutes. Draft text must include `I'm a bot.`

Auto-post is not available in this code. Turning it on takes a later change after the owner approves posting. Setting a variable cannot post.

## X live broadcast chat

When one of your broadcasts is running, its chat becomes the primary X source (`source: "live_chat"`); mentions and search stay as secondary sources. This needs a Livestream API whitelisted app and `broadcast.read` on `X_USER_ACCESS_TOKEN`. X documents chat history as available after the broadcast ends; real-time chat uses the X Activity API webhook (see docs/RESEARCH.md).

| Variable | Meaning |
|---|---|
| `X_BROADCAST_ID` | Fixed broadcast id; skips auto-detect |
| `X_LIVE_CHAT` | `auto` (default) or `off` |
| `X_SECONDARY_SOURCES` | `mentions`, `search`, `mentions,search` (default: both configured ones) or `none` |
| `X_BROADCAST_CHECK_INTERVAL_MS` | How often to look for a running broadcast (default 60000) |
| `X_BOT_TOKEN` | Bot token for chat send/mute/delete. Env only, never printed |
| `X_CHAT_WRITE` | Must be `1` to allow a non-dry-run write |

Write tools (`xBroadcastChatSend`, `xBroadcastChatMute`, `xBroadcastChatDelete`) default to dry_run and return a preview with the token redacted. Use env var names only, never values.

## X live chat in real time (webhook receiver)

`scripts/x-webhook.ts` is a zero-dependency HTTP receiver for X Activity API `broadcast.chat` deliveries. It answers X's CRC check, verifies the signature on every POST, and sends each message through the same pipeline as the poller (dedupe, audience filter, cap accounting), printing the same JSON feed lines on stdout.

```
node --experimental-strip-types scripts/x-webhook.ts
```

| Variable | Meaning |
|---|---|
| `X_CLIENT_SECRET` | App OAuth 2.0 client secret. Recommended: signs CRC and checks `x-twitter-webhooks-signature-oauth2` |
| `X_CONSUMER_SECRET` | App OAuth 1.0 consumer secret (API Secret Key). Legacy: checks `x-twitter-webhooks-signature`, signs CRC only if no client secret |
| `X_WEBHOOK_HOST` | Bind address, default `127.0.0.1` |
| `X_WEBHOOK_PORT` | Port, default `8787` |
| `X_WEBHOOK_PATH` | Path, default `/x/webhook` |

`X_USER_ACCESS_TOKEN`, `X_USER_ID` and `X_STREAM_CREDIT_CAP_USD` are still required. Set one of the two secrets at least.

It listens on localhost only. X must reach it over public HTTPS; how to expose it is your decision (for example a Cloudflare Tunnel or ngrok to `127.0.0.1:8787`, or a reverse proxy on a host you own). Nothing here deploys or opens a tunnel.

Subscription management, dry run by default (`--live` to call X, plus `--confirm` for create/delete):

```
node --experimental-strip-types scripts/x-activity-subscriptions.ts list
node --experimental-strip-types scripts/x-activity-subscriptions.ts create --webhook-id <id>
node --experimental-strip-types scripts/x-activity-subscriptions.ts delete --id <subscription_id>
```

Registering the webhook URL itself (`POST /2/webhooks`, app bearer) is a one-time owner step in the developer console or API; it triggers the first CRC. Use env var names only, never values.

## Agent read mode (free reads through Grok Bot)

`X_READ_MODE=agent` makes the bot do no X HTTP reads. A Grok Bot agent (Stream Chat Host) reads mentions and search with its built-in X tools and pipes the results in as JSON lines; `scripts/x-agent-feed.ts` runs them through the same dedupe, audience filter, cap and JSON feed. `X_READ_MODE=api` (default) keeps the HTTP poller. See [docs/SETUP.md](docs/SETUP.md).

| Variable | Meaning |
|---|---|
| `X_READ_MODE` | `api` (default) or `agent` |
| `X_AGENT_INPUT` | File of JSON lines; `-` or unset reads stdin |
| `X_REPLY_WRITE` | Must be `1` for a live reply post |
| `X_REPLY_AS` | `user` (default, `X_USER_ACCESS_TOKEN`) or `bot_account` (`X_BOT_USER_ACCESS_TOKEN`, a separate automated account's OAuth 2.0 user token with `tweet.write`) |
| `X_BOT_USER_ACCESS_TOKEN` | User token of the bot account, for `X_REPLY_AS=bot_account` |

An XChat bot token (`X_BOT_TOKEN`, `xcbot_…`) cannot post: the Bots API limits its scopes to `dm.read dm.write tweet.read users.read media.write` (plus broadcast moderation), and `POST /2/tweets` needs `tweet.write`. The input contract for Stream Chat Host is in [docs/AGENT_MODE.md](docs/AGENT_MODE.md).

`xReplyPost(postId, text)` posts a reply with `POST /2/tweets`. It is a dry run by default and returns an `approval_id`; a live post needs `X_REPLY_WRITE=1`, the owner's approval passed back as that `approval_id` (bound to the exact text and post), and a budget so its cost ($0.015, or $0.200 with a link) counts toward `X_STREAM_CREDIT_CAP_USD`.

X auto-mentions everyone in the thread. Pass `targetAuthorId` and `mentionedUserIds` (or an explicit `excludeReplyUserIds`) and the request sets `reply.exclude_reply_user_ids`, so the reply tags only the person it answers. X only lets an Automated bot account reply to posts that @mention it or that it wrote; tell viewers to tag the bot.

## Development

```bash
node --experimental-strip-types --test --test-reporter spec test/*.test.ts
```

Tests use an in-process fake obs-websocket server (`node:http` upgrade plus WebSocket frames). They do not need OBS.

## Limits

- JSON text frames only (`obswebsocket.json`). MessagePack is not implemented.
- RPC version 1. The client subscribes to no events (`EventSubscription::None`).
- One WebSocket connection, with request/response and `RequestBatch`.
- Connection attempts use exponential backoff. Authentication failure (close code 4009) is not retried. A session invalidated by OBS (close code 4011) is not reconnected.
- `GetStreamServiceSettings` is not a dedicated tool. If a batch response or backup contains `streamServiceSettings`, `key`, stream-key, password, secret, and token fields are replaced with `[REDACTED]` in the tool result and in the backup file. The value sent to OBS on a confirmed write is unchanged.
- Phase 1 does not create or delete scenes, inputs, or filters, and it does not manage profiles or scene collections inside OBS.
- The backup is a JSON snapshot for this server, not an OBS scene-collection export.
- `obs_batch` accepts at most 100 requests.

## Security

Write tools are dry runs by default, and secrets are read from environment variables only and redacted from every result. See [SECURITY.md](SECURITY.md) to report a vulnerability.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT. See [LICENSE](LICENSE).
