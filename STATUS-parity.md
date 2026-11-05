# STATUS — Higgsfield parity (tools agent)

Branch `worktree-agent-a734409577ed58939` (based on `multi-provider-longform`). Full write-up: `docs/higgsfield-parity.md`.

## Done + verified (real run, output inspected)

Run on a local Mac engine before the switch to VPS-only testing:
- Tools registry `GET /engine/api/tools` (37 enabled, 2 disabled) and `POST /engine/api/tools/:id/run` → `/jobs/:id`
- Web Tools page and Cinema Studio engine mode (screenshots in `~/.playwright-mcp/higgsfield-parity/`)
- Background Remover (Bria; also via the web UI), Upscale Image (Topaz 2×), Inpaint (FLUX Fill + generated mask),
  Expand (Bria 16:9), Relight, Photo Styles (3D Figure), Storyboard (2 frames), Shots (2), Face Swap (after a prompt fix),
  Breakdown (7 layers), Try-on (Google VTO), Vector SVG (GPT Image 2.6), Edit Image (Seedream path)
- Talking Avatar (OmniHuman v2, plus VEED Fabric earlier), Lipsync (sync-3), Extend (Grok), Motion Control (Kling 3.0),
  Effects (Kling 3.0, "Particles"), Mixed Media (Wan 2.7 VideoEdit), Video Swap (PixVerse), Video SFX (Mirelo), SFX (ElevenLabs)
- Cinema Studio video through the web UI (Veo 3.1 Lite, 1080p, 7.85 s; camera-move adherence on Lite is partial)
- Qwen Token Plan images: Qwen-Image 3.0 Pro, Wan 2.7 Image Pro (both entitled)
- Offline: `node --test engine/test/parity.test.mjs` → 20/20, also inside the bookworm ffmpeg 5.1.9 image

## Changed after testing
- Recast on Kling 3.0 Omni did NOT swap the person → Recast merged with Video Swap on PixVerse Swap (`recast`, modes
  person/object/background); `video-face-swap` removed. Edit Video moved to Wan 2.7 VideoEdit.

## Verified on the VPS test container (studio-test-parity)
- `recast` (PixVerse Swap, person): the man replaces the woman in her talking clip, same performance/background/audio — ✅
- `click-to-ad` (LLM hook → NB keyframe → Veo 3.1 Fast): 9:16 UGC ad, product label legible, spoken line with audio — ✅
- `fal/wan-3.0` reference-to-video, 480p 2 s: same woman walks in a park and waves, with audio — ✅
- `qwen/happyhorse-1.1` t2v / i2v / r2v, 480P 3 s, on the Token Plan: all on-prompt, identity kept, with audio — ✅
- `video-upscale` (SeedVR2 2×, 480² → 960²): sharper detail, no flicker — ✅
- `video-bg-remove` (Bria VRMBG, green): clean key on every frame, audio kept — ✅
- `music` (Eleven Music, 10 s): stereo mp3, real musical content (waveform + spectrogram; not checked by ear) — ✅

Every output was probed and inspected (frame strips, volumedetect). Nothing failed, so no tool or model was disabled.
The container was not rebuilt for the final inspection: an rsync dry-run showed the code on the VPS matched this branch
(only the two docs differed).

## Tests
`node --test engine/test/*.test.mjs` → 20/20 on the Mac and inside `studio:parity` (bookworm, ffmpeg 5.1.9).

## Still disabled (backlog)
- `draw-to-video`, `dub` — built, never run for real (see docs/higgsfield-parity.md backlog 1–2).

## VPS test resources
Removed: container `studio-test-parity`, volume `studio-test-parity`, image `studio:parity`, dir `/opt/studio-test/parity`.
Left on the VPS for Justin to decide: `/opt/studio-test/parity-fx` (fixtures + frame strips) and `/opt/studio-test/parity.env`
(holds a FAL_KEY copy, mode 600) — both created by the earlier session and not in the cleanup list.

## Paid calls (estimates; ApiMart from its /v1/usage endpoint)
| Call | Cost |
|---|---|
| ApiMart: Seedream 5.0 Pro edit | $0.056 |
| ApiMart: Wan 2.7 VideoEdit (3 s, 720p) | $0.378 |
| ApiMart: Kling 3.0 Motion Control (4 s, pro) | $0.521 |
| ApiMart: Kling 3.0 Omni edit (Recast attempt, 4 s) | ≈$0.32 |
| ApiMart: Kling 3.0 i2v (Effects, 5 s) | ≈$0.35 (check /v1/usage) |
| ApiMart: GPT Image 2.6 SVG | $0.094 |
| ApiMart: Veo 3.1 Lite (Cinema, 8 s) | $0.067 |
| fal: FLUX schnell ×5 (test inputs) | ≈$0.015 |
| fal: Bria RMBG ×2 | $0.036 |
| fal: SeedVR2 image, Topaz Wonder 2× | ≈$0.07 |
| fal: VEED Fabric 3.3 s, OmniHuman v2 4 s | ≈$0.26 + $0.42 |
| fal: sync-3 3.1 s, Grok extend 3 s | ≈$0.42 + $0.15 |
| fal: PixVerse Swap, Mirelo SFX 3 s | $0.05 + $0.03 |
| fal: FLUX Fill, Bria Expand, Seedream Layerize, Google VTO | ≈$0.08 + $0.04 + $0.034 + $0.075 |
| Gemini: Nano Banana 2.1 ×9 (face swap ×2, 3D figure, relight, storyboard ×2, shots ×2, click-to-ad keyframe) | ≈$0.60 |
| VPS: fal PixVerse Swap (Recast) | ≈$0.05 |
| VPS: ApiMart Veo 3.1 Fast 8 s (Click to Ad) | not itemised by ApiMart (≈$0.15 est.) |
| VPS: fal Wan 3.0 r2v 480p 2 s | ≈$0.10 |
| VPS: fal SeedVR2 video 2 s, Bria VRMBG 2 s | ≈$0.04 + $0.10 |
| ElevenLabs TTS/SFX/Music, Qwen plan images + HappyHorse ×3 | subscription credits |
| Final session (inspection, tests, docs) | $0 — reused the outputs already rendered |
| **Total** | **≈ $4.4** |
