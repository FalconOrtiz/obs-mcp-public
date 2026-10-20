# Setup guide

This guide is written so a Grok Bot agent can walk a new streamer through it one step at a time. Each step ends with a **Check** the agent can confirm before moving on. It takes about 10 minutes.

Rules for whoever runs this guide:

- Never ask the streamer to paste a token, secret or password into chat. Values go straight into environment variables on their own computer.
- Use variable names only in messages, notes and screenshots.
- Nothing posts to X until the streamer approves each reply.

## Step 0. What costs money

| What | Who | Cost |
|---|---|---|
| Reading mentions, search, posts, users | Grok Bot's built-in X tools | Free (30 calls/min, 1000/day, max 25 results per call) |
| Writing reply text | Grok Bot | The streamer's Grok Bot plan |
| Follow check ("does this viewer follow me?") | This bot, official X API | About $0.010 per new viewer, cached 6 h |
| Posting a reply | This bot, official `POST /2/tweets` | $0.015 per reply, $0.200 if it contains a link |

`X_STREAM_CREDIT_CAP_USD` caps the paid part per stream. **Check:** the streamer has picked a cap (for example 5).

## Step 1. Create the X developer app

1. Go to console.x.com and sign in with the **streamer's main account**.
2. Create a Project, then an App inside it.
3. Add a small amount of pay-per-use credit (Billing).

**Check:** the App shows in the console.

## Step 2. Turn on OAuth 2.0 and pick scopes

1. Open the App's **User authentication settings**.
2. Turn on OAuth 2.0. App type: **Web App** (confidential client).
3. Callback URL: one you control. For a local tool, `http://127.0.0.1:8080/callback`.
4. Scopes:
   - `tweet.read`, `users.read`: basic reads.
   - `follows.read`: **required for the follow check.** Without it X does not send `connection_status`, every viewer counts as "unknown", and the followers filter drops everyone.
   - `tweet.write`: needed to post replies.
   - `offline.access`: gives a refresh token so the login lasts.
5. Save. Copy the **Client ID** and **Client Secret** straight into a password manager.

**Check:** all five scopes are ticked.

## Step 3. Get the streamer's user token

Run the OAuth 2.0 authorization flow with PKCE once (any OAuth helper, or the console's tooling), signed in as the streamer. Keep the **access token** and **refresh token**.

If a scope was added after a token was issued, authorize again. Old tokens do not gain new scopes.

**Check:** the streamer has the access token in a password manager, not in chat.

## Step 4. Decide who posts the replies

| Option | How | Notes |
|---|---|---|
| A. The streamer's own account (default) | `X_REPLY_AS=user`, uses `X_USER_ACCESS_TOKEN` | Simplest. Replies appear as the streamer |
| B. A separate bot account (for example `@yourname_bot`) | `X_REPLY_AS=bot_account`, uses `X_BOT_USER_ACCESS_TOKEN` | Create a normal X account for the bot, mark it **Automated** in its profile settings (managed by the streamer's account), then run Step 3 again signed in as the bot, with `tweet.read users.read tweet.write offline.access` |

Not possible: posting with an XChat bot token (`X_BOT_TOKEN`, starts with `xcbot_`). The Bots API only issues those with `dm.read dm.write tweet.read users.read media.write` (plus `broadcast.read`/`broadcast.write` for live chat moderation), and `POST /2/tweets` needs `tweet.write`. That token is only for broadcast chat moderation.

**Check:** the streamer chose A or B, and for B the bot account shows the Automated label.

## Step 5. Connect OBS

1. OBS Studio 28 or newer: **Tools > WebSocket Server Settings**.
2. Tick **Enable WebSocket server**. Keep port `4455`.
3. Click **Generate Password** (or set one) and keep it for the next step.

**Check:** the dialog shows the server enabled.

## Step 6. Set the environment variables

Windows, User scope. For secrets, use a hidden prompt so the value is never shown or saved in history:

```powershell
function Set-Secret($name) {
  $s = Read-Host -AsSecureString $name
  $plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))
  [Environment]::SetEnvironmentVariable($name, $plain, 'User')
}
Set-Secret 'X_USER_ACCESS_TOKEN'
Set-Secret 'OBS_WS_PASSWORD'
# Option B only:
# Set-Secret 'X_BOT_USER_ACCESS_TOKEN'
setx X_USER_ID "<streamer numeric user id>"
setx X_STREAM_CREDIT_CAP_USD "5"
setx X_READ_MODE "agent"
setx X_AUDIENCE_FILTER "all"
setx X_STATE_FILE "%USERPROFILE%\obs-bot\x-state.json"
```

macOS/Linux: put `export NAME=...` lines in a file only you can read (`chmod 600`) and `source` it.

| Variable | When | Meaning |
|---|---|---|
| `X_READ_MODE` | always | `agent` (free reads through Grok Bot) or `api` (the bot reads X itself, paid) |
| `X_USER_ID` | always | Streamer's numeric id, so replies to them are labeled `reply` |
| `X_STREAM_CREDIT_CAP_USD` | always | Paid spend limit per stream |
| `X_STATE_FILE` | recommended | Dedupe, since_ids and the viewer cache across restarts |
| `X_AUDIENCE_FILTER` | optional | `all` (no paid calls), `followers`, `subscribers`, `followers_or_subscribers` |
| `X_USER_ACCESS_TOKEN` | follow check, replies (A), `api` mode | Streamer's user token |
| `X_REPLY_AS` | replies | `user` (default) or `bot_account` |
| `X_BOT_USER_ACCESS_TOKEN` | replies (B) | Bot account's user token with `tweet.write` |
| `X_REPLY_WRITE` | replies | Set to `1` only when ready to post approved replies |
| `OBS_WS_URL` | optional | Default `ws://127.0.0.1:4455` |
| `OBS_WS_PASSWORD` | if set in OBS | The OBS WebSocket password |

Open a new terminal afterwards so the variables load.

**Check:** `scripts/run-x-live.ps1` (or a quick `Get-ChildItem Env:X_*`) lists the names as set. It never prints values.

## Step 7. Run it

The Grok Bot agent reads X with its tools and feeds the bot one JSON post per line. The full contract is in [AGENT_MODE.md](AGENT_MODE.md).

```
node --experimental-strip-types scripts/x-agent-feed.ts
```

It reads stdin, or the file in `X_AGENT_INPUT`. It prints one JSON line per chat event.

**Check:** feed one sample line from AGENT_MODE.md; one feed line comes back.

## Step 8. Replies (optional)

1. Grok Bot writes the reply text.
2. `xReplyPost(postId, text)` returns a **dry run**: the exact request, the cost, and an `approval_id`.
3. The streamer approves that exact reply.
4. The agent calls it again with `dryRun: false` and that `approval_id`. It posts only if `X_REPLY_WRITE=1` and the cost fits under the cap.

Changing a single character needs a new approval. Pass `targetAuthorId` and `mentionedUserIds` so the reply sets `exclude_reply_user_ids` and tags only the person it answers. An Automated bot account can only reply to posts that @mention it or that it wrote, so ask viewers to tag the bot. Follow X's automation rules: label bot accounts, no unsolicited mass replies.

**Check:** a dry run shows `Bearer [REDACTED]` and a cost.

## Limits

- Free agent reads: 30 calls/min, 1000/day, max 25 results per call.
- Live broadcast chat is not in the free tools. It needs the Livestream API (app whitelisting) and the webhook receiver (see README).
- A missing `follows.read` shows as a one-time warning, and viewers are treated as unknown.
- Prices can change; the console is the source of truth. The cap protects either way.
