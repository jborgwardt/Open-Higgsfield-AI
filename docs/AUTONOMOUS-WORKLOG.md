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
- [ ] (2) Trace iOS download→save lifecycle (`MediaFiles.swift`, `MediaViewer.swift`, Library exports, FilmStudioKit client); fix stuck "Downloading"; Save to Photos / Files / Share with 147 MB master.
- [ ] (2) Server: `serveFile` stream cleanup leak (destroy read stream on close/abort, handle errors) + regression test (aborted/full/range).
- [ ] (2) Concurrency/session check: simultaneous downloads from two devices/sessions.
- [ ] (2) Distinct **Open/Download Finished Film** Drive action (master), separate from **Open Project Folder**.
- [ ] (3) QA workers: iPhone 15 Pro Max + iPad Pro M4 — compact readability, export controls, busy/progress/cancel/retry, navigation, long-press, iPad popovers/landscape.
- [ ] (4) Bump version/build, OTA staged rebuild, SignTools upload, Feather source, report one install link.

## Progress notes
- 06:45Z handoff read; main HEAD f2e4931 (check `git log`).
