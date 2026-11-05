# Film Studio Apple app — status

Branch: `worktree-agent-af6591f241381a635` (based on `multi-provider-longform`). Scope: `apple/`, native
sign-in in `engine/lib/oidc.js` + auth part of `engine/server.js`, `engine/lib/appconfig.js` + its routes, `~/OTA`.

## Done + verified
- Engine: native sign-in (`/engine/auth/native` → `filmstudio://auth?session=…&state=…`, one-time handoff,
  no browser cookie, Bearer sessions, logout ends Bearer session, same-site `next`); `/app/config`, `/app/version`,
  `/app/log`. `node --test apple/scripts/test-*.mjs` → 15/15 pass.
- FilmStudioKit: `cd apple/FilmStudioKit && swift test` → 42/42 pass (incl. main's characters response shape).
- App builds: iOS Simulator + macOS.
- UI walkthroughs (`apple/scripts/ui-screenshots.sh`):
  - local engine + contract mock: iPhone tests 1–4 pass, iPad tests 1–4 pass;
  - VPS test container (via SSH tunnel, access-code mode, free `local` models only, guarded): test1 (Create + Library)
    and test4 (server-driven config) pass; test2 rendered 4/4 shots but the **engine's** master assembly fails in the
    Docker image (ffmpeg 5.1: "Error reinitializing filters … stream #0:1"; works with ffmpeg 9 on the Mac).
- Mac sections captured (`apple/scripts/mac-screenshots.sh`).
- OTA files installed into ~/OTA (`ExportOptions-FilmStudio.plist`, `rebuild-film-studio.sh`, `dist/film-studio.html`, card on `dist/index.html`).

## Not verified
- Real Pocket ID passkey sign-in (only the fake-IdP engine tests + unit tests). test5 (simulator sign-in via fake IdP) written, not run.
- Camera capture (no camera in the simulator); PhotosPicker/drag & drop uploads (upload path covered by tests/API).

## Next
1. `~/OTA/rebuild-film-studio.sh` (FILMSTUDIO_SRC=<worktree>/apple) → FilmStudio.ipa + FilmStudio-mac.zip (running).
2. Final report.

## How to resume
- `cd apple && xcodegen` (project is generated, not committed).
- Local engine for UI tests: `ENGINE_PORT=4961 ENGINE_DATA=$(mktemp -d) LLM_BASE_URL=http://127.0.0.1:9/v1 node engine/server.js`
  (+ `node apple/scripts/contract-mock.mjs 4962 http://127.0.0.1:4961` and `node apple/scripts/seed-characters.mjs`).
- `apple/scripts/ui-screenshots.sh <sim-udid> <prefix> <server> [test1,test2,…] [code-file]`
- Simulators created: "FilmStudio iPhone" 76037ADE-ECDA-4A89-B620-F101DF0C5C11, "FilmStudio iPad" 7C093F48-BFA8-44BD-9231-2C6A249B4415.

## Test infrastructure
- Mac local engines/mocks (4961–4964): stopped.
- VPS `studio-test-app` container, `studio-test-app` volume, `studio:app` image tag, `/opt/studio-test/app*`, SSH tunnel: **removed**.
