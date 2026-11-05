# Post-production work — status (agent worktree `worktree-agent-a0f6f60d158ba00b1`)

Full benchmarks, API and build notes: `docs/post-production.md`.

## Done + verified (VPS, Debian ffmpeg 5.1 in `studio:pp-test`)
- `engine/lib/post.js`, `engine/lib/subtitles.js`, routes `/engine/api/post/*` (mounted from server.js), UI `src/components/PostPanel.js`
  (Library "Enhance · Subtitles" dialog + long-form "Finishing" section), Dockerfile stages (whisper.cpp v1.9.5 pinned commit,
  sha256-checked models: large-v3-turbo q8_0, Silero VAD v6.2.0, RNNoise std), `fonts-inter`, `libgomp1`.
- Unit tests: `node --test engine/test/*.test.js` → 26 pass.
- Whisper: turbo q8_0 + VAD = 20.2 s per 58.6 s audio (RTF 0.34); 5-min film transcribed in 72.4 s end-to-end.
- Enhance e2e (pp-bench-studio): soft subs, burned subs (Inter, checked visually), clean audio, two-pass loudness
  (−26.5→−16.0, −20.4→−16.1, −22.2→−16.0, −27.1→−16.3 LUFS; TP −1.4…−1.5), denoise (nlmeans), 16→24 fps interpolation,
  queue + cancel. UI dialog renders and starts jobs (browser check through an SSH tunnel, since stopped).
- Colour match (3-point levels) on 5 real courtroom clips: spread Ylow 10→3, Ymean 10.8→5.0, Yhigh 50→18, U 3.1→1.6, V 6.5→2.6.
- Fail-soft assembly: post prep / per-shot conform / finishMaster failures fall back to the plain path.

## In progress
- BUG: with VAD, whisper token times are on VAD's compressed timeline (segments are real time), and some segments
  have collapsed token times → words all at the segment start. Fix: map token span onto the segment in `parseWhisperJson`.
  `t_dtw` is −1 (DTW not computed — flash attention is ON by default in whisper-cli v1.9.5; pass `-nfa` with `-dtw`).
- e2e `longform` (L0 plain, L1 soft+colour+clean+smooth, L2 burn, L3 music+narration) running on VPS.
- Paid proofs still to run: P1 Topaz 720p→1080p (~$0.16), P2 ElevenLabs isolate (~134 credits), P3 long-form topaz+isolate (~$0.16 + ~267 credits).
- Merge latest `multi-provider-longform` (mixSoundtrack narration `apad` fix + characters) — keep both.

## Paid calls so far
- ElevenLabs audio isolation ×2 (40 s each, benchmark) ≈ 1,340 credits ≈ $0.29 (Creator plan rate). Called once from the Mac
  with the key in process env only (no file written). Further paid calls go through the VPS test container (`--env-file`).

## VPS test resources (remove when done)
- Containers: `pp-bench-studio` (127.0.0.1:4849, volume `pp-bench-data`). Throwaway `pp-bench-*` run with `--rm`.
- Images: `studio:pp-test`, `pp-bench:whisper`, `debian:bookworm-slim` (pulled).
- Volume: `pp-bench-data`. Files: `/root/pp-bench` (clips copied read-only from studio-data, models, bench scripts, token).
- Cleanup: `docker rm -f pp-bench-studio; docker rmi studio:pp-test pp-bench:whisper; docker volume rm pp-bench-data; rm -rf /root/pp-bench`

## How to resume
1. `git log` in this worktree; scripts used for benchmarks/e2e live in the session scratchpad and on the VPS in `/root/pp-bench/bench/`.
2. Sync: `rsync -az --delete --exclude node_modules --exclude .git ./ root@100.64.0.4:/root/pp-bench/src/`, then
   `cd /root/pp-bench/src && docker build -t studio:pp-test .` and recreate `pp-bench-studio`
   (`docker run -d --name pp-bench-studio -p 127.0.0.1:4849:4848 -v pp-bench-data:/data --env-file /opt/studio/.env -e ENGINE_TOKEN=$(cat /root/pp-bench/token) studio:pp-test`).
3. `/root/pp-bench/bench/e2e.sh enhance|transcribe|longform|paid|paid2|probe`.
