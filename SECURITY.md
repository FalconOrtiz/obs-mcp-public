# Security policy

## Reporting a vulnerability

Please report security issues privately through GitHub: **Security > Report a vulnerability** on this repository (GitHub Security Advisories). Do not open a public issue for a vulnerability. You should get a first reply within 7 days.

## Supported versions

Only the latest release on `main` gets security fixes.

## Design rules

- Secrets (obs-websocket password, stream keys, Twitch, YouTube, Kick and X tokens, client secrets) are read from environment variables only. They are never accepted as tool arguments, and they are redacted as `[REDACTED]` in tool results, previews, errors and backups.
- Every write tool is a dry run by default. It returns the exact request and changes nothing until `dry_run` is `false`, and the platform's write flag (for example `X_REPLY_WRITE=1` or `X_CHAT_WRITE=1`) is set.
- X replies need a per-reply `approval_id` bound to the exact text, post and excluded users, plus a spend cap (`X_STREAM_CREDIT_CAP_USD`).
- Chat text is treated as untrusted data. Only allow-listed commands from privileged users can change OBS.
- Never commit `.env` files, tokens, or captured chat logs. CI runs gitleaks on every push.
