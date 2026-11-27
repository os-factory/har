# 07 — Hosted portal (`har hq`)

Connecting the CLI to a hosted portal and syncing evidence to it, after local Mission Control.

- **PRT-1** MUST — Browser login captures the token on a loopback callback and rejects a callback whose state does not match; credentials are stored in a file with mode 0600.
- **PRT-2** MUST — The CLI holds one org connection at a time: switching org replaces the connection and clears its attached repositories, a same-org reconnect keeps them, and disconnect removes the connection, its repositories and the legacy credentials file.
- **PRT-3** MUST — Only repositories attached to the active connection sync to the portal; `HAR_PORTAL_URL` together with `HAR_PORTAL_TOKEN` overrides the connection for the run, and either one alone configures no portal.
- **PRT-4** MUST — A repository syncs to local Mission Control before the portal, and still syncs to the portal when Mission Control fails; a portal 503 is retried, and a 401 rotates the ingest token once through the refresh token and retries, otherwise the 401 is surfaced.
- **PRT-5** MUST — Portal sync is incremental on a watermark per repository and portal org: it sends what is newer than the watermark and advances it to the newest item sent; `--full` ignores the watermark but still advances it; a dry run or an unreadable telemetry channel does not advance it.
- **PRT-6** MUST — Tokens are redacted from every list and show payload.
- **PRT-7** MUST — Usage sent to the portal is Mission Control's attributed rows unchanged (no re-harvest, no repricing); every row of a changed session is sent, never split across requests.
