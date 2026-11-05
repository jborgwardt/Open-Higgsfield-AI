# Director / editing / screening: status

Branch `worktree-agent-ac5f0664b252af2fb` (based on `multi-provider-longform` @ 4cbc353). Not pushed.

## Done and verified
- **Mixer bug fix** (1b2af58): the master was cut off where the last narration line ended (sidechaincompress
  ends with its sidechain). Reproduced against the original code (3.3 s instead of 5.5 s) and fixed. Validated
  on ffmpeg 9 and bookworm ffmpeg 5.1.9.
- **Editing for rhythm** (0532827): per-shot `editIn`/`editLength`; assemble conforms only that window; the
  master stores `cuts` (timecodes); narration lines never overlap; the AI score follows per-shot `score` cues
  (enters and exits on cuts, unscored shots are silent); `omit`. Verified locally end to end on
  `local/animatic`: 16 shots, 102 s of renders cut to a 58.4 s master, with every segment the planned length.
- **Writers' room director** (e635ea8): three passes (concepts + pick + beat sheet → shot list → critique +
  rewrite), genre craft notes, lines kept verbatim, robust JSON. No automatic director: the user picks one,
  and planning without one fails with "Choose a director first". `GET/POST /directors` lists every chat
  model per provider: Claude CLI (subscription), Gemini, Grok, ApiMart, Qwen, Venice, local, and "No AI
  (split)". Claude backend: `claude -p --output-format json`, no tools, scrubbed env, timeout, concurrency 1.
  Verified locally with Claude (opus) and Gemini (gemini-3.8-flash).
- **Screening** (f450b9d): Gemini Files API upload + one generateContent call → `p.screening`;
  `POST /productions/:id/screen`, `POST /productions/:id/screen/apply` (re-cuts and cuts → re-assemble).
  Calibrated on the real failed master: 5/10, "uniform 8 s clips, dead air after punchlines, score drone
  fights the deadpan". The re-cut loop ran on real footage (63.7 s → 53.3 s, then re-screened).
- **UI** (a89927b): director picker (Long-form and Providers), genre, writers' room card, cut info per shot,
  screening card with re-cut buttons. Also fixes scene blocks collapsing to 0 px. Checked in the browser pane
  against a local build.

- **VPS image** `studio:director` built from this worktree (/opt/studio-test/director). The pinned CLI 2.1.318
  runs (323 MB native binary) with config in /data/claude, and `/status` reports "installed, not signed in".
  ffmpeg 5.1.9. In container `studio-test-director`: `/directors` lists Gemini 18, Qwen 12, Venice 140 and
  ApiMart 191 chat models; planning without a director returns 400 "Choose a director first"; the Gemini
  writers' room planned the bipolar trial (11 shots, 50.4 s cut from 66 s of renders, 7/7 lines kept).

  Then in the same container: animatic render → trimmed assembly (master 50.52 s for a 50.40 s cut list) →
  auto-screen (gemini-3.8-flash). The test container, volume, image and /opt/studio-test/director are removed.
- **Delete fix** (10999d9): deleted productions no longer come back (deleteProduction now awaits pause).

## Not verified
- The Claude CLI inside the container with a real CLAUDE_CODE_OAUTH_TOKEN (the token is not set yet). Locally
  the same backend ran 3 Opus plans on the signed-in Mac CLI.
- The Claude CLI in the container needs `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`); not set yet.
- The Qwen director run was interrupted by the move to VPS testing (concept + shot passes had completed).
- Grok director: untested (no xAI login locally).

## Next steps (for the integrator)
1. Run `claude setup-token` once and add `CLAUDE_CODE_OAUTH_TOKEN=…` to /opt/studio/.env, then pick
   "Claude (your subscription)" as the director.
2. Merge and deploy. The image grows by about 323 MB (the Claude Code native binary).

## How to re-test on the VPS
- `rsync -az --exclude node_modules --exclude .git --exclude engine-data --exclude dist --exclude .claude ./ root@100.64.0.4:/opt/studio-test/director/`
- `docker build -t studio:director . && docker run -d --name studio-test-director -p 127.0.0.1:4963:4848 -v studio-test-director:/data --env-file /opt/studio/.env studio:director`
- Drive it with `docker exec -i studio-test-director node --input-type=module - < script.mjs`, using the bearer
  token from /data/settings.json (the engine listens on 0.0.0.0, so even loopback needs the access code).
- Remove: `docker rm -f studio-test-director; docker volume rm studio-test-director; docker rmi studio:director; rm -rf /opt/studio-test/director`

## Costs so far
- No video or image generation. Narration in tests used the free Mac voice; Lyria was never called.
- Gemini API: 3 director plans (gemini-3.8-flash, one on the VPS) and 6 screenings (about 11–12k input tokens each). Well
  under $0.50 in total.
- Claude: 3 Opus plans + about 4 tiny CLI probes, on the Claude subscription (no API billing).
- Qwen Token Plan: 1 partial plan. Model-list calls (free) for Gemini/Qwen/Venice.
