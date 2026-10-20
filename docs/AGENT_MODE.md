# Agent read mode contract (`X_READ_MODE=agent`)

In agent mode the bot makes no X HTTP reads. A Grok Bot agent (for example Stream Chat Host) reads X with its built-in tools and hands the posts to `scripts/x-agent-feed.ts`. The bot dedupes, applies the audience filter (the follow check is the only paid call), enforces `X_STREAM_CREDIT_CAP_USD`, and prints JSON feed lines.

## Input: one JSON post per line

Write to the bot's stdin, or append to the file named by `X_AGENT_INPUT`. UTF-8, one JSON object per line, `\n` separated.

```json
{"id":"1847000000000000001","text":"@streamer what game is next?","author_id":"123456","username":"viewer_one","created_at":"2026-10-18T19:00:00.000Z","conversation_id":"1847000000000000001","in_reply_to_user_id":"987654","source":"mention"}
```

| Field | Required | Notes |
|---|---|---|
| `id` | yes | Post id, digits only |
| `text` | yes | Post text |
| `author_id` | yes | Author's user id |
| `username` | no | Author handle without `@`. Without it the feed shows the id (or the follow lookup fills it) |
| `created_at` | yes | ISO 8601 |
| `conversation_id` | no | Lets `X_LIVE_POST_ID` mark replies in the live-post thread as `search` |
| `in_reply_to_user_id` | no | Equal to `X_USER_ID` means a reply to the streamer |
| `source` | yes for the contract | `mention`, `reply`, `search` or `hashtag`. Decides which since_id the post advances |

Also accepted for convenience: a raw tool page `{"data":[...],"includes":{"users":[...]}}` or an array of posts on one line. Lines that are not JSON are skipped with one warning. Posts missing a required field are skipped.

Map the tools like this:

| Grok Bot tool | `source` |
|---|---|
| `get_users_mentions` (id = `X_USER_ID`) | `mention`, or `reply` when `in_reply_to_user_id` is `X_USER_ID` |
| `search_posts_all` for `conversation_id:<live post>` | `search` |
| `search_posts_all` for `#<hashtag>` | `hashtag` |

Prefer `conversation_id:<live post id>` searches over `to:<handle>`: they return only the live thread and overlap less with mentions. A search hit whose `in_reply_to_user_id` is `X_USER_ID` (typical for `to:<handle>`) is labeled `reply`, whatever `source` says.

Posts written by the streamer (`author_id` equal to `X_USER_ID`) are dropped.

Free tool limits: 30 calls/min, 1000/day, max 25 results per call. One mentions call and one search call every 20–30 s stays well inside them.

## State file (`X_STATE_FILE`)

JSON, shared by the agent and the bot. Both may read it and write it.

```json
{"mentionsSinceId":"1847000000000000001","searchSinceId":"1847000000000000042","authors":{"123456":{"username":"viewer_one","badges":[],"followsYou":true,"checkedAt":1792350000000}}}
```

| Key | Who writes | Meaning |
|---|---|---|
| `mentionsSinceId` | bot and agent | Newest id fed with source `mention` or `reply`. Pass as `since_id` to `get_users_mentions` |
| `searchSinceId` | bot and agent | Newest id fed with source `search` or `hashtag`. Pass as `since_id` to `search_posts_all` |
| `recentIds` | bot only | The last 2000 ids fed, oldest first. Dedupe across runs |
| `authors`, `followers`, `liveChatSinceMs` | bot only | Caches. The agent should leave them as they are |

Rules:

- The bot writes atomically (temp file plus rename) with mode 0600, so a reader never sees half a file. The agent should do the same.
- On every save the bot keeps the **newer** since_id of its own and the one on disk, so either side may advance it. Neither side should move it backwards.
- Both since_ids advance for every post the bot receives, including ones dropped as duplicates, own posts, or filtered out.
- After a restart the bot skips ids at or below `max(mentionsSinceId, searchSinceId)` and any id in `recentIds`, so a re-sent page is not fed twice.
- The file holds ids and handles only, never tokens.

## Output

One JSON line per event on stdout: `{"platform":"x","source","user","text","time","post_id","badges","kind"}`. `kind: "system"` lines are warnings (cap reached, missing `follows.read`, a bad line).

## Paid calls in agent mode

- Follow check, only when `X_AUDIENCE_FILTER` is not `all`: `GET /2/users?ids=…&user.fields=connection_status`, about $0.010 per new author, cached `X_FOLLOW_STATUS_TTL_MS` (default 6 h). Needs `X_USER_ACCESS_TOKEN` with `follows.read`.
- Replies: `xReplyPost`, $0.015 each ($0.200 with a link), with owner approval. See SETUP.md.

The bot tracks this spend itself and stops paid calls at `X_STREAM_CREDIT_CAP_USD`.

## Encoding (Windows)

Input and output are UTF-8. In PowerShell, set the console encoding before piping, or emoji arrive as `????`:

```powershell
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$OutputEncoding = [Text.Encoding]::UTF8
Get-Content -Encoding UTF8 posts.jsonl | node --experimental-strip-types scripts/x-agent-feed.ts
```

Or skip the pipe: set `X_AGENT_INPUT` to the `.jsonl` path and the bot reads the file as UTF-8 itself.
