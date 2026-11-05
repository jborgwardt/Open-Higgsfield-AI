# Film Studio acceptance checklist

Owner: integration session. Updated 2026-11-05.

## Milestone 1: usable build for feedback

**Delivered build:** app commit `256a958` (branch `multi-provider-longform`).
**Installers:**
- Built 17:41–17:42 from the clean `256a958` tree.
- Install page: https://ota.heil.haus:8443/film-studio.html. The page, IPA, manifest and Mac zip all return 200.
- Both the IPA and the Mac binary contain post-QA strings ("Showing your last Home", "Wrong access code").

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
- Fix (`f21a119`, source only): activate the app before sign-in, show "Waiting for the Pocket ID passkey window…" and add a Cancel button.
- Not yet in the installer: the user is in the live Mac session, which runs from the OTA build folder.

### Open / needs a human
- **Audio audibility:** the file has an AAC track, but the simulator's player shows muted and I can't hear it. Check by ear on the phone.
- **Mac:** the build launches and the dark sign-in screen renders. Signed-in Mac screens are not verified, because automation can't type into the access-code field (a password field). Needs one manual sign-in.
- **Passkey sign-in to films.heil.haus on the physical phone:** only you can do this.
- **Polish:**
  - The progress pill disappears on completion with no "ready" toast.
  - The Generate button stays enabled while a job runs.
  - A system "Library" title flashes during the tab switch on the 15 Pro Max.
  - Library tiles load slowly on iPad (QA-12).
  - The Settings, New Film and film-detail screens are still grouped iOS forms (design gap).

## Milestone 2: long-form 5–10 min
Not started in this pass.
