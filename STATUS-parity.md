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

## Not yet verified (next, on the VPS test container)
1. `recast` with a different person (PixVerse person mode), ≈$0.05
2. `click-to-ad` (NB keyframe + Veo 3.1 Fast ≈ $0.20) — the run was stopped before Veo was submitted
3. fal Wan 3.0 reference-to-video, 480p 2 s (≈$0.10)
4. Qwen HappyHorse t2v / i2v / r2v, 3 s 480P (plan credits)
5. Upscale Video (SeedVR2 small clip ≈$0.04), Video BG Remover (Bria 2 s ≈$0.10), Music (Eleven Music, credits)
Anything that fails → `enabled: false` in `engine/lib/tools.js` + note in the parity doc.

## How to resume (VPS test, no keys on the Mac)
```
rsync -a --delete --exclude node_modules --exclude .git --exclude engine-data --exclude dist ./ root@100.64.0.4:/opt/studio-test/parity/
ssh root@100.64.0.4 'cd /opt/studio-test/parity && docker build -t studio:parity . && docker rm -f studio-test-parity; docker run -d --name studio-test-parity -p 127.0.0.1:4962:4848 -e ENGINE_HOST=0.0.0.0 -v studio-test-parity:/data --env-file /opt/studio/.env studio:parity'
```
Drive it with `docker exec studio-test-parity node -e '…fetch("http://127.0.0.1:4848/engine/api/…")…'`. Loopback inside the
container needs the maintenance Bearer token from `/data/settings.json` (`accessToken`) when the engine isn't bound to loopback.

## Test containers on the VPS (remove when done)
- container `studio-test-parity`, volume `studio-test-parity`, image `studio:parity`, dir `/opt/studio-test/parity`
  → `ssh root@100.64.0.4 'docker rm -f studio-test-parity; docker volume rm studio-test-parity; docker rmi studio:parity; rm -rf /opt/studio-test/parity'`

## Paid calls so far (estimates; ApiMart from its /v1/usage endpoint)
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
| ElevenLabs TTS/SFX, Qwen plan images | subscription credits |
| **Total** | **≈ $4.0** |
