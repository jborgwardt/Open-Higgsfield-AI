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

## In progress / not verified
- Docker image build with the pinned Claude Code CLI (2.1.318) has not been built yet. The VPS test is next.
- The Claude CLI in the container needs `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`); not set yet.
- The Qwen director run was interrupted by the move to VPS testing (concept + shot passes had completed).
- Grok director: untested (no xAI login locally).

## Next steps
1. VPS: `rsync` the worktree to `/opt/studio-test/director/`, then `docker build -t studio:director .`, then run
   `studio-test-director` on 127.0.0.1:4963 with `--env-file /opt/studio/.env` and volume
   `studio-test-director:/data`. Check `/status` (claude: installed, not signed in), `/directors`, a Gemini
   plan, an animatic render + assemble + screen.
2. Remove the test container, volume and `/opt/studio-test/director` when done.

## How to resume
- Test container: `ssh root@100.64.0.4 'docker exec studio-test-director node -e "..."'` against
  http://127.0.0.1:4848 inside the container (loopback needs no auth).
- Remove: `ssh root@100.64.0.4 'docker rm -f studio-test-director; docker volume rm studio-test-director; docker rmi studio:director; rm -rf /opt/studio-test/director'`

## Costs so far
- No video or image generation. Narration in tests used the free Mac voice; Lyria was never called.
- Gemini API: 2 director plans (gemini-3.8-flash) and 5 screenings (about 11–12k input tokens each). Well
  under $0.50 in total.
- Claude: 3 Opus plans + about 4 tiny CLI probes, on the Claude subscription (no API billing).
- Qwen Token Plan: 1 partial plan. Model-list calls (free) for Gemini/Qwen/Venice.
