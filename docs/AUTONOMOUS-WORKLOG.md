# Film Studio — autonomous work log (Claude)

Started 2026-11-06 ~06:45Z. Justin authorized 24–48 h autonomous work. Handoff: `/Users/justinborgwardt/Documents/Codex/2026-11-05/ca-6/outputs/CLAUDE-HANDOFF.md` (read it after any context reset).

## Rules (from Justin)
- Priority: (1) finished movie on his actual iPhone → (2) download/save/Share/Drive flow verified end-to-end → (3) iPhone/iPad design & usability via focused QA → (4) ship through OTA + SignTools + Feather (bump version/build).
- Keep Settings footer **“AI-designed in the claws of Claude.”** (`apple/FilmStudio/Settings/SettingsView.swift`).
- No paid generation spend. Don't regenerate/upscale/replace the finished movie. Preserve `music-videos/`, archives, backups, Drive originals (don't rename `media/a_960be31d6a0a.mp4` in Drive archive).
- Test devices: **iPhone 15 Pro Max sim F5EFECAA** and **iPad Pro 13" M4 sim 6922A83C** only; one owner per device; keep Mac load low (shut other sims). Physical: iPhone waldgeist 00008130-00094C1A2661001C, iPad Endbahnhof 00008132-001621A83C21801C (often unreachable).
- Don't compete with Justin for his screen/transfers; coordinate device tests. Updates ≤5 bullets. Gather approvals together.
- Engine tests run on the VPS only (`/opt/studio-test/omni-src`, `env -i … node --test engine/test/*.test.mjs engine/test/*.test.js`). Deploy only when no production is rendering; tag `studio:rollback-prev`. NOTE: handoff says runtime source is now `/opt/studio/src` and image `studio:storage-20261106` — check the current deploy procedure (`/opt/studio/run.sh`) before deploying.

## Checklist
- [x] Mac load: shut 4 duplicate sims (kept 15 Pro Max, iPad Pro M4; Apple TV sim not ours, left alone). Closed old 4968 test tunnel.
- [x] (1) Movie: verified SHA-256 4e8f4e03…5704; copied to iCloud Drive `FINISHED FILM - The Road on Side B.mp4` — iCloud reports uploaded. Photos import blocked (Photos AppleEvents time out; Photos control denied). **Waiting on Justin: Files → iCloud Drive → tap → Share → Save Video.** Not verified on phone yet.
- [x] (2) iOS export: background URLSession (survives app switch/lock), 6 resumable retries, cached finished file reused by Photos/Files/Share, files named after the film. **Verified on iPhone 15 Pro Max sim with the 147 MB master**: backgrounded mid-download → completed by nsurlsessiond; SHA-256 matches; Photos got a 155.375 s video; Files got 146,802,253 bytes; Share sheet instant, named. Physical phone not yet verified.
- [x] (2) Server stream leak fixed (pipeline), ETag/Last-Modified/If-Range for resume; test proves 18→0 leaked fds. Deployed 07:2xZ as studio:streamfix-20261106 (rollback = studio:rollback-prev = old 15d46a93). Live: 0 fds after 8 aborts; resume 206.
- [x] (2) Concurrency: 3 simultaneous full master downloads all 200/exact (~1 s each on loopback); sessions are per sign-in, no single-login limit (createSession never revokes others).
- [x] (2) Finished-film Drive link: engine `filmUrl` (live: file/d/1C_XYDKavmOPQPvtFbEkWprwQVuo6cVxc) + app 'Open Finished Film in Google Drive' / 'Open Project Folder'.
- [x] (3) QA round 1 (2 workers, one per sim) → 37 findings. Fixed + verified on sims: tribute visible above tab bar; phone keeps tabs in landscape (viewer survives rotation); film page Save to Photos/Files/Share row; Re-assemble demoted + confirm; Save to Photos primary in viewer, no prominent paid Upscale on films; aligned bar; landscape viewer layout; iPad share popover anchored to button; Make a Film → Films list when films exist; m:ss lengths; short director label; video loading/failed overlay; composer keyboard dismiss; Library film search + success toasts; readable shot rows.
- [ ] (3b) Remaining low items: iPad portrait sidebar width, Library grid trailing margin/placeholders, context-menu thumbnails, New Film sheet polish, model picker size on iPad, 'Done 9/11' wording, Settings copy (ChatGPT 'connect on Mac' when connected), unmute master by default (unverified).
- [x] (4a) Shipped 1.0.2 (12) at ~07:45Z: OTA + Feather (version fixed to 1.0.2; script now sets version) + SignTools 343636bd-9d01-4670-ad29-599feae66065 (signed, verified) + Mac /Applications. Phone install = Justin's tap.
- [x] (4b) 1.0.3 (13) = QA fixes (shipping now).

## Progress notes
- 06:45Z handoff read; main HEAD f2e4931 (check `git log`).

- QA notes found while testing (to fix in step 3): Home "Make a Film" card opens a blank New Film sheet even when films exist; film header shows "2.589511 min" (format); Director row shows raw "codex"; master viewer's primary orange button is "Upscale" (paid) instead of export; player area black until tapped/loaded.
