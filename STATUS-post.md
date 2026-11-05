# Post-production work — status (agent worktree `worktree-agent-a0f6f60d158ba00b1`)

Full benchmarks, API and build notes: `docs/post-production.md`.

## Done + verified (VPS, Debian ffmpeg 5.1 in `studio:pp-test`)
- `engine/lib/post.js`, `engine/lib/subtitles.js`, routes `/engine/api/post/*` (mounted from server.js), UI `src/components/PostPanel.js`
  (Library "Enhance · Subtitles" dialog + long-form "Finishing" section), Dockerfile stages (whisper.cpp v1.9.5 pinned commit,
  sha256-checked models: large-v3-turbo q8_0, Silero VAD v6.2.0, RNNoise std), `fonts-inter`, `libgomp1`.
- Unit tests: `node --test engine/test/*.test.js` → 26 pass at that point (55 after the merge).
- Whisper: turbo q8_0 + VAD = 20.2 s per 58.6 s audio (RTF 0.34); 5-min film transcribed in 72.4 s end-to-end.
- Enhance e2e (pp-bench-studio): soft subs, burned subs (Inter, checked visually), clean audio, two-pass loudness
  (−26.5→−16.0, −20.4→−16.1, −22.2→−16.0, −27.1→−16.3 LUFS; TP −1.4…−1.5), denoise (nlmeans), 16→24 fps interpolation,
  queue + cancel. UI dialog renders and starts jobs (browser check through an SSH tunnel, since stopped).
- Colour match (3-point levels) on 5 real courtroom clips: spread Ylow 10→3, Ymean 10.8→5.0, Yhigh 50→18, U 3.1→1.6, V 6.5→2.6.
- Fail-soft assembly: post prep / per-shot conform / finishMaster failures fall back to the plain path.

- Fixed + verified: VAD word timing (290 words → 262 distinct starts, 53 cues on the 5-min film), cues clamped to the
  picture, `queued` job state, DTW opt-in. Merged `multi-provider-longform` (characters, narration apad/tail) — 55 tests pass.
- Long-form e2e (6 shots, 48 s, 1080p): plain 40.8 s; soft subs+colour+clean+smooth 142 s; burn 73 s;
  music+narration 136 s → 48.08 s master, −16.0 LUFS / −1.5 dBTP, 9 cues.

## Paid proofs (done, verified)
- P1 Topaz 720p→1080p (8 s Veo clip): 1920×1080, sound kept, 47 s; visibly finer detail than Lanczos (labelled crop compared).
- P2 ElevenLabs isolation + soft subs (8 s Gemini clip): −26.4→−16.0 LUFS, mov_text track, transcript intact.
- P3 long-form 2 shots, `upscale: topaz` + `audioCleanup: isolate` + soft subs: 15.96 s 1080p master, −15.9 LUFS,
  subtitle track; re-assembly reused cached derivatives (no new cloud calls).
- Verdict: both paid paths stay off by default; isolation not shown better than local `clean` (documented).

## Paid calls (total)
- ElevenLabs audio isolation ×2 (40 s each, benchmark) ≈ 1,340 credits ≈ $0.29 — called once from the Mac with the key
  in process env only (no file written).
- P1 fal Topaz 8 s 720p→1080p ≈ $0.16.
- P2 ElevenLabs isolation 8 s ≈ 95–135 credits.
- P3 fal Topaz 8 s ≈ $0.16 + ElevenLabs isolation 2 clips (~16 s) ≈ 190–270 credits.
- Measured ElevenLabs rate ≈ 715 credits/min (1,240 credits for 104 s across P2/P3 and checks).

## Tests
- `node --test engine/test/*.test.js engine/test/*.test.mjs` → 55 pass, 0 fail.

## VPS test resources — removed
- `pp-bench-studio` container, `studio:pp-test` + `pp-bench:whisper` images, `pp-bench-data` volume, `/root/pp-bench`.
- `debian:bookworm-slim` left in place (shared base image). `studio`, `studio:latest`, `/opt/studio` untouched.
  An unrelated `studio-test-parity` container (image `studio:parity`) was present and left alone.

## Known issue (not fixed here)
- Conformed segments keep audio overhang → ~85 ms concat gaps and non-integer master fps (see docs).

## How to resume (VPS resources above were removed; rebuild them first)
1. `git log` in this worktree; scripts used for benchmarks/e2e live in the session scratchpad and on the VPS in `/root/pp-bench/bench/`.
2. Sync: `rsync -az --delete --exclude node_modules --exclude .git ./ root@100.64.0.4:/root/pp-bench/src/`, then
   `cd /root/pp-bench/src && docker build -t studio:pp-test .` and recreate `pp-bench-studio`
   (`docker run -d --name pp-bench-studio -p 127.0.0.1:4849:4848 -v pp-bench-data:/data --env-file /opt/studio/.env -e ENGINE_TOKEN=$(cat /root/pp-bench/token) studio:pp-test`).
3. `/root/pp-bench/bench/e2e.sh enhance|transcribe|longform|paid|paid2|probe`.
