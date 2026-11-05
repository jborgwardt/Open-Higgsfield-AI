# Film Studio Apple app — status

Branch: `worktree-agent-af6591f241381a635` (based on `multi-provider-longform`). Scope: `apple/`, native
sign-in in `engine/lib/oidc.js` + auth part of `engine/server.js`, `engine/lib/appconfig.js` + its routes, `~/OTA`.

## Done + verified
- Engine: native sign-in (`/engine/auth/native` → `filmstudio://auth?session=…&state=…`, one-time handoff,
  no browser cookie, Bearer sessions, logout ends Bearer session, same-site `next`). `node --test apple/scripts/test-*.mjs` → 15/15 pass.
- Engine: `/engine/api/app/config` (GET/PATCH, merge patch, tabs by id, reset), `/app/version` (open),
  `/app/log` (POST/GET/DELETE ring buffer 2000). Tested in the same suite.
- FilmStudioKit (Swift package): `cd apple/FilmStudioKit && swift test` → 41/41 pass.
- App builds: iOS Simulator + macOS (`xcodebuild … -scheme FilmStudio / FilmStudioMac`).
- UI walkthroughs (XCUITest, `apple/scripts/ui-screenshots.sh`) against a local engine + contract mock:
  iPhone 17 Pro sim tests 1–4 pass; iPad Pro 13" sim tests 1–4 pass. Screenshots in `apple/screenshots/`.
  Mac sections captured with `apple/scripts/mac-screenshots.sh` (Debug `-snapshotAfter` hook).
- Server-driven config verified live (test4): tab → web, feature off, default changed, notice shown on foreground.
- OTA files installed into ~/OTA (`ExportOptions-FilmStudio.plist`, `rebuild-film-studio.sh`, `dist/film-studio.html`, card on `dist/index.html`).

## In progress / next
1. Coordinator: test against a VPS test engine instead of the Mac (see below), incl. test5 (native sign-in) if OIDC can be pointed at a fake IdP there — otherwise test5 stays Mac-only.
2. Run `~/OTA/rebuild-film-studio.sh` (FILMSTUDIO_SRC=<worktree>/apple) for FilmStudio.ipa + FilmStudio-mac.zip.
3. Final report.

## How to resume
- `cd apple && xcodegen` (project is generated, not committed).
- Local engine for UI tests: `ENGINE_PORT=4961 ENGINE_DATA=$(mktemp -d) LLM_BASE_URL=http://127.0.0.1:9/v1 node engine/server.js`
  (+ `node apple/scripts/contract-mock.mjs 4962 http://127.0.0.1:4961` and `node apple/scripts/seed-characters.mjs` for Characters/Tools).
- `apple/scripts/ui-screenshots.sh <sim-udid> <prefix> <server> [test1,test2,…]`
- Simulators created for this work: "FilmStudio iPhone" 76037ADE-ECDA-4A89-B620-F101DF0C5C11, "FilmStudio iPad" 7C093F48-BFA8-44BD-9231-2C6A249B4415 (`xcrun simctl delete <udid>` to remove).

## Test infrastructure started (remove when done)
- Mac: local engines/mocks on 4961/4962/4963/4964 — being stopped per coordinator.
- VPS: `studio-test-app` container (127.0.0.1:4964), volume `studio-test-app`, dir `/opt/studio-test/app/`; Mac SSH tunnel `ssh -N -L 4964:127.0.0.1:4964 root@100.64.0.4`.
  Remove: `docker rm -f studio-test-app && docker volume rm studio-test-app && rm -rf /opt/studio-test/app`; kill the tunnel.
