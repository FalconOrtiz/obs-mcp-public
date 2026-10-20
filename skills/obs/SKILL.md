---
name: obs
description: Control a local OBS Studio instance through the obs-mcp server (obs-websocket v5). Use when switching scenes, muting inputs, changing volume, or starting and stopping stream, record, replay buffer, or virtual camera. Write tools default to dry_run.
---

# OBS

Use the `obs` MCP server. Confirm OBS is running and the WebSocket server is enabled under Tools > WebSocket Server Settings. The default URL is `ws://127.0.0.1:4455`. The password is `OBS_WS_PASSWORD`.

Read first: `obs_status`, `obs_list_scenes`, `obs_list_inputs`, `obs_get_scene_items`, `obs_list_transitions`.

Every write tool defaults `dry_run` to true and returns the obs-websocket request it would send. Set `dry_run` to false only after the user confirms that change. Before scene or scene-item edits, call `obs_backup_scene_collection` with `dry_run` false and a `path`.

Do not ask for, repeat, or store a stream key. `streamServiceSettings` key fields are redacted in tool results. To point OBS at an ingest, call `obs_set_stream_service`. The key is read from `OBS_STREAM_KEY` and is not a tool argument.

Scene recipes (`obs_recipe_scene_pack`, `obs_recipe_transitions`, `obs_recipe_mic_chain`, `obs_recipe_celebration`) back up the scene collection before they apply. Leave `dry_run` true until the user confirms, then pass `backup_path`.

The chat bot in `packages/obs-bot` is a library, not an MCP tool. It only runs the four scene commands above, and only for a privileged viewer whose message was not flagged as an instruction override. It always says it is a bot.

The Twitch adapter stays offline until the owner sets `TWITCH_CLIENT_ID`, `TWITCH_ACCESS_TOKEN`, `TWITCH_BOT_USER_ID`, and `TWITCH_BROADCASTER_ID`. Do not invent those values or ask the viewer for a token.

The YouTube adapter polls `liveChatMessages.list` only. It does not open `streamList`. It stays offline until the owner sets `YOUTUBE_ACCESS_TOKEN` and `YOUTUBE_LIVE_CHAT_ID`.

Kick events count only after the webhook signature verifies. Do not paste a Kick public key into the repo. X announce posts and replies are local drafts. Do not post them. `publishXDraft` is supposed to refuse.
