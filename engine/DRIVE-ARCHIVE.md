# Google Drive backups

Film Studio uses the studio server's existing Google Drive rclone connection. The Apple/web apps only change policy and request backups; they never receive Drive OAuth tokens. Archives are private Drive folders, not public sharing links.

## Server setup

The default executable is `rclone` on PATH, the config is `${ENGINE_DATA}/rclone/rclone.conf`, and the remote is `gdrive`. Overrides are `ENGINE_ARCHIVE_RCLONE`, `ENGINE_ARCHIVE_RCLONE_CONFIG`, and `ENGINE_ARCHIVE_REMOTE`. Remote names must contain only letters, digits, `_`, or `-`.

The Dockerfile copies the static executable from the official `rclone/rclone:1.75.2` image, pinned to multi-platform manifest digest `sha256:2687085f718d3c628f7fdfb77c52a1d344332aed543110bb88088f2c70d43eb5`. The Docker Hub Registry digest and the SHA256 of its manifest response were independently checked on 2026-11-06; the index includes Linux amd64 and arm64. A build-time assertion checks `rclone v1.75.2`. See the [official Docker installation documentation](https://rclone.org/install/#docker-installation) and [versioned image Dockerfile](https://github.com/rclone/rclone/blob/v1.75.2/Dockerfile).

Provision only the desired Drive remote's existing configuration into the persistent data volume at `/data/rclone/rclone.conf`. Do this through a local file copy or a config parser that writes the selected remote directly to a mode-0600 file; never print token fields or paste them into app settings, logs, or shell command arguments. Keep the configuration directory mode 0700. Rclone needs directory write access to atomically refresh its tokens; a single read-only config-file bind mount will not work for renewal. Do not bake credentials into an image. The existing `studio-data:/data` volume preserves credentials and archive history across container replacement. Read-only `rclone --config /data/rclone/rclone.conf about gdrive: --json` verifies current authentication before enabling backups.

The discovered VPS remote authenticated successfully on 2026-11-06, but uses rclone's shared Google OAuth client. rclone warns that this client is being retired during 2026. Migrate to an owned Google OAuth client before that connection is withdrawn. This is separate from the app's backup policy and must not silently broaden account access.

## Policy and data

Defaults: disabled, upload immediately, retain local finished videos for 48 hours after their first checksum-verified backup. Opening/downloading/restoring a local video restarts its retention clock. Upload delay choices are 0, 24, or 48 hours; local retention choices are 24, 48, or `null` (keep local).

Each completed production has a stable `Film Studio/<sanitized-title>--<production-id>/` folder with `project.json` and `media/`. The manifest contains the production plan, brief, soundtrack references, cast metadata, asset metadata, and uploaded-file hashes. All referenced media are included. Standalone generated videos, including masters no longer referenced by a project, receive `Film Studio/Videos/<name>--<asset-id>/` folders with video metadata. Uploaded originals are not treated as generated standalone output.

Transfers run serially with bounded buffers. Rclone handles retries and skips identical content. The engine verifies Drive size and MD5 against the local streaming MD5 before recording success. Scheduled runs skip unchanged verified project snapshots; manual backup rechecks/copies their files to repair missing remote data. Queue/status and verified locations persist in `${ENGINE_DATA}/archive/state.json`. Interrupted uploads are retried after restart. Corrupt state disables backup/cleanup without overwriting its history or stopping ordinary local media serving.

Cleanup is deliberately limited to verified **finished masters and unreferenced standalone generated videos**. Source clips, character photos, uploaded audio, thumbnails, project records, and conform/post-production caches remain local. A master referenced by another project or a character is protected. No cleanup runs during active generation, planning, assembly, screening, post-processing, or restore. The remote checksum, local checksum, current project revision, retention age, and activity guard are checked again before eviction. A failed backup or verification never deletes the local media.

An archived video's existing authenticated `/engine/media/<file>` URL still works. The server restores it to a temporary local file, verifies size/checksum, then atomically renames it before serving the request. Concurrent restores for the same asset share one transfer. HTTP Range and HEAD remain supported. Before mutating API requests start jobs, referenced archived assets are restored; the original source clips and references remain available throughout.

## API

All routes use normal Film Studio authentication:

- `GET /engine/api/archive/status` (`?fresh=1` forces connection check)
- `PATCH /engine/api/archive/settings` accepts `{enabled, uploadDelayHours, removeLocalAfterHours}`
- `POST /engine/api/archive/run` manually backs up eligible completed projects/videos
- `GET /engine/api/productions/:id/archive`
- `POST /engine/api/productions/:id/archive`
- `POST /engine/api/productions/:id/restore`

Status/settings return `{provider, configured, connected, rootFolder, folderUrl, policy, busy, stats, lastRunAt, lastError}`. Stats contain `projects`, `videos`, `verifiedBytes`, `localBytesFreed`, and `pending`. Manual run returns this status plus `queued`. A manual request while another backup is busy returns HTTP 409 instead of silently discarding it.

Project status returns `{id, status, title, folderUrl, error, verifiedAt, localOffloaded}` (some fields are absent before the first backup). Status is `not_archived`, `uploading`, `verified`, or `error`; a project changed since its last snapshot is reported `not_archived`. Project POST also returns `queued` and `busy`. Restore returns `{restored:true, projectId}`.

Private folder links use an actual Drive directory ID from a one-level parent directory listing. `rclone lsjson <directory> --stat` returns a synthetic root-directory object without an ID, so it is used only for media-file checksum verification. No folder is created by a status query, and the implementation never calls `rclone link`.

## Verification

Run on an isolated VPS checkout with temporary fixture data:

```sh
node --test engine/test/archive.test.mjs engine/test/archive-routes.test.mjs
```

Tests use a fake Drive adapter/process, not real credentials or uploads. They cover retained originals, corrupt/offline backups, active/shared assets, restart/restore and retention, changed snapshots, missing remote repair, path traversal/symlinks, metadata secrets, busy conflicts, corrupt history, auth rejection, and restored Range/HEAD downloads.

Official reference: [rclone Drive](https://rclone.org/drive/), [copyto](https://rclone.org/commands/rclone_copyto/), and [lsjson](https://rclone.org/commands/rclone_lsjson/). Native Google Drive uploads can alternatively use [resumable uploads](https://developers.google.com/workspace/drive/api/guides/manage-uploads); this implementation reuses the already authenticated server rclone connection.
