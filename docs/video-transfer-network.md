# Film Studio public video transfer

## Incident and evidence (2026-11-06)

The phone reported repeated save timeouts and very slow browser playback. Host sampling showed 45 GiB available memory, 84–94% idle CPU, no memory/I/O pressure, and no recent kernel out-of-memory events. The 146,802,253-byte finished master served directly from the engine in 0.693 seconds, with correct byte ranges and MP4 fast-start metadata.

Eight native-app failures in the reviewed 90-minute window used HTTP/3 for `/engine/media/a_960be31d6a0a.mp4`. Caddy logged downstream `writing: timeout: no recent network activity`; the first correlated within 2.26 seconds of the phone's first recorded save error. This narrows the failure to the client-facing transfer path but does not by itself establish whether QUIC, the network, or client behavior initiated each disconnect.

## Scoped mitigation

Only `films.heil.haus` now returns `Alt-Svc: clear`. This invalidates advertised alternatives for this origin under [RFC 7838 section 3](https://www.rfc-editor.org/rfc/rfc7838.html#section-3). It does not disable HTTP/3 globally, terminate existing transfers, change TLS, or relax authentication. Existing client connections may need to be closed/reopened.

The persistent source is CPM `proxy_hosts` row 72, metadata field `custom_pre_handlers_json`, containing:

```json
[{"handler":"headers","response":{"deferred":true,"set":{"Alt-Svc":["clear"]}}}]
```

The corresponding HTTPS route was updated through Caddy's local admin API using an ETag and a fresh host match. All other routes were verified unchanged. Do not hardcode the observed route array index for future changes.

Prior metadata, prior/current route snapshots, and a guarded rollback script are stored privately on the VPS in `/opt/studio/film-h3-mitigation-20261106T063210Z/`. Follow that directory's README if reverting. A CPM-generated configuration preserves the setting because it is stored in the manager's database.

## Verification

- Public Film Studio health: HTTP/2 200 with `Alt-Svc: clear`.
- Unauthenticated master: still 401, with `Alt-Svc: clear`.
- Unrelated `vault.heil.haus`: still advertises HTTP/3.
- Engine Range request: correct 206 and byte count.
- **Actual public transfer:** Caddy access log at `2026-11-06T06:32:33.803Z`, native FilmStudio GET, HTTP/2, 200, all **146,802,253 bytes in 2.997362747 seconds** (about 49 MB/s). This was a network transfer, not a local cache hit.
- Native Mac Save completed. Result SHA-256: `4e8f4e03793007b807ce39c6698d5bce867390899387e75841020d9d8b165704`, identical to the original master.
- The phone's current connection has not been independently retested. The Mac result verifies the deployed path, not every mobile network.
