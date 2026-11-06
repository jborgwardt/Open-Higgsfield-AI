# Film Studio Drive token broker

The VPS runs `filmstudio-drive-token.service` every 20 minutes using
`filmstudio-drive-token.timer`. Its source is `scripts/refresh-drive-token.py`,
installed at `/opt/studio/refresh-drive-token.py` with mode `0700`.

The broker asks Incus `god` to refresh the existing Google credential in
`/root/grok-exec/secrets/gdrive/google_token.json` with **only**
`https://www.googleapis.com/auth/drive`. The refresh response must contain exactly
that scope, a usable Bearer token, and the expected owner is verified with Drive's
`about` endpoint. Google redirects are rejected. Broad refresh credentials and
client secrets remain inside `god`.

The short-lived access token passes through a captured local subprocess pipe.
Only `type`, `scope`, public `client_id`, and a token object containing
`access_token`, `token_type`, and `expiry` are written to
`/var/lib/docker/volumes/studio-data/_data/rclone/rclone.conf`. The config is mode
`0600`; its directory is `0700`. No tokens, provider response bodies, or exception
details are sent to stdout/stderr or journald.

Before replacement, the broker validates the candidate config and runs rclone's
read-only `about` command. It then writes atomically, fsyncs, and keeps the first
prior config at `/opt/studio/drive-broker-backups/rclone.conf.before-scoped-broker`
(mode `0600`). Renewal failures preserve the existing config and emit a sanitized
service error. If renewal stays broken past expiry, archiving fails safely and
local copies remain.

## Verification

- `python3 scripts/test-refresh-drive-token.py` uses synthetic credentials only.
  Tests cover rejected extra scope/wrong account/expired tokens, absence of broad
  credential fields, failed-probe preservation, atomic replacement, private modes,
  and backup-once behavior.
- `systemctl show filmstudio-drive-token.service -p Result -p ExecMainStatus`
- `systemctl list-timers filmstudio-drive-token.timer`
- Inspect config **field names only**, never print token values.
- `rclone --config /var/lib/docker/volumes/studio-data/_data/rclone/rclone.conf about gdrive: --json`

No studio restart is needed because each archive operation launches a fresh
rclone subprocess. The renewal interval leaves at least about 40 minutes of the
usual one-hour token lifetime for each new operation; archive transfers themselves
are capped at 30 minutes.

## Rollback

Stop and disable `filmstudio-drive-token.timer`, stop any running token service,
and restore the protected prior config atomically with mode `0600`. Do this only
when intentionally rolling back: that previous connection used rclone's shared
Google client and may still be rate-limited. Existing Drive backups and the
archive policy are not changed by the broker or its rollback.
