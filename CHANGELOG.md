# Changelog

## 0.1.0 (2026-10-20)

First public release.

- MCP server for OBS Studio over obs-websocket v5: scenes, inputs, audio, filters, scene items, streaming, recording, replay buffer and virtual camera. Writes are dry runs by default; stream keys are redacted.
- Recipes: scene packs with backup, transitions, mic chains, celebration batches, and stream service setup.
- Chat bot core: allow-listed commands, untrusted-input wrapping, rate limits and a kill switch.
- Chat adapters: Twitch EventSub and Send Chat, YouTube live chat polling, Kick webhooks, X mentions and search, X live broadcast chat, and an X Activity API webhook receiver.
- X replies through `POST /2/tweets` with per-reply approval, a spend cap, and `exclude_reply_user_ids` so a bot reply tags only the person it answers.
