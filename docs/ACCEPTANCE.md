# Film Studio acceptance checklist

Owner: integration session. Updated 2026-11-05.

## Milestone 1: usable build for feedback

**Delivered build (current):** app commit `c70102a`, published 18:21 EST. It includes:
- the Save-to-Photos crash fix and playback audio session (`256a958`)
- the Mac sign-in fix: app activation, waiting text, Cancel (`f21a119`)
- the per-film director fix (`f721105`, test `ccedab5`)

**Installers:**
- https://ota.heil.haus:8443/film-studio.html: page, IPA, manifest and Mac zip all return 200. The Mac app's signature verifies.
- Built in an isolated staging folder, `~/OTA/build/filmstudio-stage-20261105-182120`. Earlier builds are kept.
- Version is 1.0.0 (1) on every build so far. The build number isn't bumped, so the version can't tell builds apart: identify builds by publish time and commit.

**Installed on physical devices** (via devicectl, over the existing copy, so app data is kept):
- waldgeist, iPhone 15 Pro Max (iPhone16,2), UDID 00008130-00094C1A2661001C: Film Studio 1.0.0 (1) installed from the c70102a IPA.
- Endbahnhof, iPad Pro 13" M4 (iPad16,6), UDID 00008132-001621A83C21801C: Film Studio 1.0.0 (1) installed from the c70102a IPA.
- Not yet verified on the devices: passkey sign-in, and an audio check by ear. Justin has to do both.

**Backend:** live engine redeployed by the ship pass. Its engine tests passed 98/98, and films.heil.haus returned 200.

### Real-provider walkthrough in the native app against the VPS

Test engine: `studio-test-qa`, a throwaway container on the VPS reached through a tunnel. It holds a Grok access token only, with no refresh token, so the live login can't be affected.

| Step | iPhone 17 Pro sim | iPhone 15 Pro Max sim (iOS 27) | iPad Pro 13" M4 sim (iOS 27) |
|---|---|---|---|
| Sign in (access code) | pass | pass | pass |
| Home: still images, film-reel hero, gold accent | pass | pass | n/a (opens on Create) |
| Pick Grok Imagine Video 1.5, prompt, Generate | pass (asset `a_ebd753d34ceb`, 8.04 s, h264 + AAC) | — (no new generation) | — |
| Progress: Generating view, then pill on Home (1% → 10%) | pass | — | — |
| Open result from Library | pass | pass | pass |
| Play / pause / seek −10 s / replay | pass | pass | pass |
| Save to Photos | **crashed**, then fixed in `256a958` and passes; file in Photos is 2,866,650 bytes with video + audio | pass ("Saved to Photos" shown, file present) | pass ("Saved to Photos") |
| Share / export (share sheet shows the mp4, 2.9 MB) | pass | pass | pass (popover anchored top-left, not at Share) |
| Films list → film detail (QA-05), director shows "No AI (split my script)" (QA-02) | — | pass | — |
| Sidebar layout, readable selected row (QA-13) | n/a | n/a | pass |

### Fixed in this pass
- QA-01 to QA-08: blockers and majors, fixed by the fix agent (`b15c30f`, `0ccc4e0`, `455d533`, `5db5290`).
- Save to Photos crash (EXC_BREAKPOINT: a main-actor closure ran on the Photos queue): `256a958`.
- Full players use a `.playback` audio session, so sound plays with the silent switch on: `256a958`.
- UI-test false failures fixed: progress pill timing, filter IDs, plan wait.

### Mac sign-in (reported frozen)
- Cause: the passkey window only appears once Film Studio is the active app. Launched in the background, the first attempt waited about 90 s with only a spinner.
- Logs: the second attempt worked (passkey 17:47:16, signed in 17:47:19).
- Fix (`f21a119`): activate the app before sign-in, show "Waiting for the Pocket ID passkey window…" and add a Cancel button. It's in the published installers (since the 17:54 build, and in the current c70102a build).

### Ship pass (UI suites on the 5db5290 build, before the app-only fixes)
- Live engine is on 5db5290: 98/98 engine tests passed, the site returns 200, /feed has previews. The backend is identical to HEAD.
- iPhone suite: 16/18 passed. The 2 failures were test harness problems (Photos picker still open; a field scrolled under the nav bar). A rerun got past both points.
- iPad suite: 12/18 passed. Most failures came from the harness and simulator state (landscape left over from test15; there is no "Close" button on the iPad composer). Launching the app by hand in landscape works.
- test12 Offline and test13 Unauthorized don't actually exercise their paths, because the stored session skips them. That's a gap in the tests.
- The orange/gold accent is intended: Justin approved the gold/violet palette. The New Film sheet is already protected from accidental dismissal (interactiveDismissDisabled when edited).
- VPS test engine, volumes, images, tunnel and the copied fal key were all removed at 18:15. Only studio:latest remains.

### Open / needs a human
- **Audio audibility:** the file has an AAC track, but the simulator's player shows muted and I can't hear it. Check by ear on the phone.
- **Mac:** Justin signed in with his passkey and used the app (17:47). The long-form trial was then created from the signed-in Mac app.
- **Passkey sign-in to films.heil.haus on the physical phone:** only you can do this.
- **Polish:**
  - The progress pill disappears on completion with no "ready" toast.
  - The Generate button stays enabled while a job runs.
  - A system "Library" title flashes during the tab switch on the 15 Pro Max.
  - Library tiles load slowly on iPad (QA-12).
  - The Settings, New Film and film-detail screens are still grouped iOS forms (design gap).

## Milestone 2: long-form 5–10 min
Not started in this pass.

## Milestone 2: long-form capability (scope corrected 2026-11-05)

Justin's correction: the 5–10 minute requirement means the app must be *capable* of long-form films. About 5 minutes is the first target and 10 can come later. It does **not** mean producing a full film now, and it does not block delivery.

**Paused trial production:** `prod_73c31fc2ebf8` "The Great Pancake Heist", on the live server.
- Created from the Mac app with Gemini as director for this film only, Grok Imagine Video 1.5 for every shot (free), and ElevenLabs narration.
- Paused through the API at about 23:25Z: 4 shots done, 74 pending. Plan, keyframes and assets are kept. Don't resume it unless Justin asks.

**Bounded capability checks (these are not a completed real 5-minute film):**

| Capability | Evidence | Status |
|---|---|---|
| Long duration planning | The director planned 78 shots, 551.5 s (about 9.2 min) of edit length, from a short premise | pass |
| Per-film director from the app | Fixed in f721105, tested in ccedab5. Before the fix, the app forced a studio-wide director choice | fixed |
| Model routing at scale | All 78 shots resolve to xai/grok-imagine-video-1.5, so the run spends nothing | pass |
| Pause/resume mid-render | Through the Mac app on live: paused and resumed, no shot lost or submitted twice; the paused state was kept | pass |
| Multi-clip sequencing and assembly | QA film: 4 shots rendered, assembled into a 32 s master and played in the app (UI test07, test engine) | pass (short) |
| Export | A single clip was exported (Photos + share sheet) on 3 devices | pass |
| Exporting a full film master | Not exercised | open |
| Real 5-minute master: audio continuity, loudness over its length | Not produced, by design | open (optional later) |

## Install routes (2026-11-05 18:55)

- **Signed OTA:** https://ota.heil.haus:8443/film-studio.html, Apple Development wildcard profile (team F2M8XJL997). The profile covers both devices and expires 2027-08-30.
- **SignTools:** sign.heil.haus app `b46658af-d098-4534-9163-b2ab20d75baa`, "FilmStudio-1.0.0-c70102a (Film Studio).ipa", profile justin_dev, original bundle ID com.borgwardt.filmstudio. Signed by the self-hosted builder at 18:51. Install page: https://sign.heil.haus/apps/b46658af-d098-4534-9163-b2ab20d75baa/install (basic auth).
- **Feather source:** https://ota.heil.haus:8443/feather-source.json (AltStore-format repo). It lists Film Studio 1.0.0 (1) with the same IPA. `~/OTA/rebuild-film-studio.sh` (and the isolated `~/OTA/rebuild-film-studio-staged.sh`) now keep its size and date in step with the published IPA.
- **Feather on the devices:**
  - waldgeist (iPhone): Feather 2.9.0 (thewonderofyou.Feather) is installed. Whether the source has been added, and which certificate Feather signs with, is NOT verified.
  - Endbahnhof (iPad): Feather is not installed.
- **Installed now (devicectl):** Film Studio 1.0.0 (1) from c70102a on both devices.
