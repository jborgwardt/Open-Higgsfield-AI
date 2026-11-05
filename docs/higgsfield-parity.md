# Higgsfield parity

What Higgsfield (higgsfield.ai, November 2026) offers, what this studio does for each feature, which model it uses,
and what is still missing. Higgsfield's own pages were the main source: the home page, `/apps` (8 categories,
70+ apps), `/cinematic-video-generator` (Cinema Studio 4.0), `/camera-controls`, `/effects` and `/create/video`. Help-centre
articles and recent reviews filled in Popcorn, Lipsync Studio, Speak, Audio, Genjutsu and Click to Ad.

Legend: **✅ done** (verified end-to-end) · **🟡 partial** · **⏸ built, disabled** (unverified, hidden) · **❌ missing** ·
**↗ other agent** (characters agent / VPS post-production agent).

## How the tools work (server-driven)

Every one-click tool is defined once, on the server, in `engine/lib/tools.js`. The web **Tools** page
(`src/components/ToolsPage.js`) and the Apple app both render the same registry generically. That means a tool's
prompt template, model choice and limits can be fixed on the back end without shipping a new app.

- **Registry:** `GET /engine/api/tools` returns the list below. `GET /engine/api/tools?all=1` also returns disabled tools,
  each with `enabled: false`. `GET /engine/api/tools/:id` returns one tool.
- **Run:** `POST /engine/api/tools/:id/run` with body `{ "inputs": { key: value } }` (a flat body works too). It answers
  `{ jobId, job }`; poll `GET /engine/api/jobs/:jobId` until `status` is `done`, `error` or `cancelled`.
  A finished job has `url`, `assetId`, `kind` (`image`/`video`/`audio`), `posterUrl`, `duration` and `assets[]` (every output;
  Storyboard, Shots and Breakdown return several). Tools that write a script also return `text`.
- **Inputs:** `image` / `video` / `audio` values are engine asset ids or URLs. Upload files first with
  `POST /engine/api/upload?name=file.ext` (raw body); it returns `{ id, url }`. A `voice` value is an ElevenLabs voice id, or
  `google:<voice>` / `xai:<voice>`; options are pre-filled from `GET /sound`. A `character` value is an id from the characters
  agent's `GET /engine/api/characters`. The run resolves the character's reference photos and voice. If that API is not
  installed, the input is optional and the photo input is used instead. A `model` value is a catalog id; options are pre-filled.
  `modelKind` matches `GET /catalog` models whose `kinds[]` contains it.
- **Validation:** required inputs, number ranges, select values and toggles are checked server-side. Missing input → HTTP 400.
- **One tool per job, one best model per tool.** Only Cinema Studio exposes a model picker (Higgsfield also lets you pick
  per shot). Every other tool runs its best model and falls back to the next one only when that provider is not connected.
- **Real-person photos:** Gemini Omni refuses likenesses of real people. Tools that take a person's photo never pick it;
  they use Kling 3.0, Seedance 2.0 or Veo 3.1 (ApiMart), or a fal avatar / lip-sync model.
- **Adding or fixing a tool** is an edit to `engine/lib/tools.js` (and `engine/lib/presets.js` for preset libraries). Tools that are
  not verified ship with `enabled: false`.

Schema (stable contract with the Apple app):

```
[{ id, title, sfSymbol, category, description,
   inputs: [{ key, type: 'text'|'longtext'|'image'|'video'|'audio'|'select'|'number'|'toggle'|'character'|'voice'|'model',
              label, help, options: [{ value, label }], default, required, min, max, modelKind }],
   run: { method: 'POST', path: '/engine/api/tools/<id>/run' }, output: 'image'|'video'|'audio' }]
```

`image` inputs may carry `annotate: 'draw' | 'mask'`. A client may then offer a sketch canvas (Draw to Video) or a mask brush
(Inpaint: white = change). Clients that ignore it still work.

### Other new routes

| Route | What it does |
|---|---|
| `GET /engine/api/cinema/presets` | Cinema Studio libraries: cameras, lenses, focal lengths, apertures, 65 camera moves, genres, eras, grades, montage pacing, emotions, defaults |
| `GET /engine/api/catalog` | now includes `kinds[]` per model and tool-only models (upscale, avatar, lipsync, motion, video-edit, …) |
| `POST /engine/api/test/qwen` | free Qwen Token Plan key check (model list + task lookup) |

Studio generation (`POST /engine/api/generate`) accepts the new catalog models; see "Models added".

## Parity matrix

"Verified" = one real generation was run on the default model and the output inspected (see Verification). "Offline" = the
request shape is unit-tested against the provider docs (`engine/test/parity.test.mjs`), and the tool reuses an
already-verified pipeline.

### Create (model hubs, Cinema Studio)

| Higgsfield feature | What it does there | Here | Model / provider | Status |
|---|---|---|---|---|
| Image model hub (Soul, Nano Banana Pro/2, Seedream 5, GPT Image 2.6, FLUX.2, Ideogram, Qwen-Image…) | Pick a model, prompt, refs | Image Studio + catalog | Nano Banana 2.1 / Pro (Gemini), GPT Image 2 / 2.6, Seedream 5.0 Pro, FLUX.2 Max (ApiMart), Grok Imagine Image, Qwen-Image 3.0 Pro / Wan 2.7 Image Pro (Qwen plan), FLUX (fal) | ✅ (Soul itself is proprietary; Soul ID → ↗ characters agent) |
| Video model hub (Seedance 2/2.5, Kling 3/4/O1, Veo 3.1, Wan 2.6–3.0, Grok, MiniMax, Sora 2) | Pick a model, text or start frame | Video Studio + catalog | Veo 3.1 Quality/Fast/Lite, Kling 3.0/V4/3.0 Omni/3.0 Turbo, Seedance 2.0/2.0 Fast/2.5, Wan 2.6/3.0, MiniMax H3, Hailuo 2.3 (ApiMart); Wan 3.0 (fal); HappyHorse 1.1 (Qwen plan); Grok Imagine; Gemini Omni | ✅ — no Sora 2 (no provider carries it) |
| Start & end frames / keyframes | First + last frame control | Every model with `caps.end` | Kling 3.0, Veo 3.1, Seedance 2.x, Wan 3.0, Kling Omni, MiniMax H3 | ✅ start+end · ❌ multi-keyframe (backlog) |
| Cinema Studio 4.0: camera body, lens, focal length, aperture | Virtual camera rig | Cinema Studio (web) + `cinema-shot` tool | Compiled server-side (`engine/lib/cinema.js`), any video/image model | ✅ Verified |
| Cinema Studio: up to 3 stacked camera moves (Camera Controls library: 65 moves — Crash Zoom, FPV Drone, Snorricam, Dolly Zoom, Bullet Time…) | Moves run in order | Same, all 65 moves with motion language video models follow | default Veo 3.1 Fast | ✅ Verified |
| Cinema Studio: genre, era regrade, colour grade, emotion | Scene-wide look | Same | prompt compiler | ✅ |
| Cinema Studio: Montage Pacing (Chaotic/Dynamic/Calm/Single) | Scene arrives cut | Pacing → prompt directive | — | 🟡 prompt-level only; true multi-shot cutting = Kling Omni `multi_shot` (backlog) |
| Cinema Studio: AI Cast, Locations, 50 references | Reusable actors / places | — | — | ↗ characters agent (reference routing) |
| Cinema Studio: native 4K, up to 1 min | — | 4K via Veo 3.1 / Kling Omni; 30 s via Seedance 2.5 / Kling V4; minutes via Long-form | — | 🟡 single generations cap at 15–30 s |
| Mr. Higgs / script-to-scene director | LLM breaks a script into shots | Long-form Studio director | Grok / Gemini / ApiMart LLMs | ✅ (existing) |
| Popcorn storyboards | Up to 8 consistent frames | `storyboard` tool | Nano Banana 2.1, previous frame fed forward | ✅ Verified |
| Shots / Zooms / Angles 2.0 / What's Next? | 9 shots, zoom ladder, angles, next beats from one image | `shots` tool (one tool, 4 sets) | Nano Banana 2.1 | ✅ Verified |
| Transitions | Seamless shot between two images | `transitions` tool | Kling 3.0 start + end frame | ✅ Offline |
| Draw to Video | Draw arrows/notes on a frame → video | `draw-to-video` (Gemini vision reads marks, NB cleans frame, Kling animates) + sketch canvas in the web UI | | ⏸ built, not verified |

### Effects & templates

| Higgsfield feature | Here | Model | Status |
|---|---|---|---|
| Effects (45+ VFX: Bullet Time, Earth Zoom, Melting, Particles…) | `effects` tool — 53 VFX + 12 trending templates (On Fire, Mukbang, Cloud Surf, Idol, Behind the Scenes, ASMR Host…) with tuned prompts | Kling 3.0 (ApiMart) | ✅ Verified |
| Shorts / viral presets ("hundreds") | Same tool | Kling 3.0 | 🟡 65 presets, not hundreds |
| Genjutsu (rebuild part of a clip; trend motion library) | `video-edit` | Wan 2.7 VideoEdit | 🟡 edit ✅; no community motion library |
| Games & Characters, Extras (Game Dump, Nano Strike, Nano Theft, Simlife, Plushies, 3D Figure, Mugshot, Signboard, Paint App, Japanese Show, Glitter Sticker, Outfit Vending…) | `photo-styles` tool, 16 styles | Nano Banana 2.1 | ✅ Verified |
| Mixed Media / style transfer for video | `restyle` (16 looks or a style frame) | Wan 2.7 VideoEdit (ApiMart) | ✅ Verified |

### Ads & products

| Higgsfield feature | Here | Model | Status |
|---|---|---|---|
| Click to Ad / UGC Factory / UGC Builder / Marketing Studio | `click-to-ad`: product URL (Open Graph) or photo → LLM hook line → keyframe → presenter speaks the line | NB 2.1 keyframe + Veo 3.1 Fast (native audio) | ✅ Verified |
| Ad apps (Bullet Time White/Scene/Splash, Billboard, Truck, Giant Product, Volcano, Fridge, Packshot, Macro, Magic Button, Kick Ad, Graffiti, Chameleon, ASMR Add-On, Poster) | `product-scenes`, 16 scenes: keyframe composed with the product, then animated | NB 2.1 + Kling 3.0 | ✅ Offline (same pipeline as Click to Ad) |
| Product Placement | `product-placement` | NB 2.1 | ✅ Offline |

### Image tools

| Higgsfield feature | Here | Model | Status |
|---|---|---|---|
| Edit / Banana edit / multi-reference | `image-edit` | NB 2.1 (Seedream 5.0 Pro if Gemini is not connected) | ✅ Verified |
| Inpaint | `inpaint` + mask brush in the web UI | FLUX.1 Pro Fill (fal) | ✅ Verified |
| Expand image | `expand` | Bria Expand (fal) | ✅ Verified |
| Relight | `relight` (direction, colour, strength) | NB 2.1 | ✅ Verified |
| Skin Enhancer | `skin-enhancer` | NB 2.1 | ✅ Offline |
| Colour grading | `color-grade` (stills) | NB 2.1 | ✅ Offline · video grading ↗ VPS agent |
| Background Remover | `bg-remove` | Bria RMBG 2.0 (fal) | ✅ Verified (also via the web UI) |
| Breakdown | `breakdown` → PNG layers | Seedream 5.0 Layerize (fal) | ✅ Verified |
| Upscale (image) | `image-upscale` 2× / 4× | Topaz Wonder 3.5 (fal) | ✅ Verified |
| GPT Image 2.6 GIFs + vector SVG, Ideogram Vector | `vector-gif` | GPT Image 2.6 (ApiMart) | ✅ Verified |

### Face & identity

| Higgsfield feature | Here | Model | Status |
|---|---|---|---|
| Face Swap (photo) | `face-swap` | NB 2.1 | ✅ Verified (prompt fixed after the first run swapped the wrong way) |
| Character Swap 2.0 | `character-swap` | NB 2.1 | ✅ Offline |
| Headshot Generator | `headshot` (6 styles) | NB 2.1 | ✅ Offline |
| Outfit Swap / AI Stylist | `try-on` (1 garment → Google VTO; 2–3 pieces → NB) | Google Virtual Try-On (fal) | ✅ Verified |
| Soul ID / AI Influencer / Commercial Faces | — | — | ↗ characters agent |

### Video tools

| Higgsfield feature | Here | Model | Status |
|---|---|---|---|
| Edit video | `video-edit` | Wan 2.7 VideoEdit (ApiMart) | ✅ model + request verified via Mixed Media; an instruction edit was not run separately |
| Recast + Video Face Swap | one tool, `recast` (person / object / background) | PixVerse Swap (fal) | ✅ Verified (see VPS runs). Kling 3.0 Omni edit failed to replace the person and is no longer used |
| Motion Control | `motion-control` | Kling 3.0 Motion Control (ApiMart) | ✅ Verified |
| Video Extender | `extend` (joined into one file) | Grok Imagine Extend (fal); native Veo 3.1 extension for ApiMart Veo clips in Long-form | ✅ Verified |
| Video Upscaler | `video-upscale` | SeedVR2 (fal) | ✅ Verified · CPU upscale/interpolation ↗ VPS agent |
| Video Background Remover | `video-bg-remove` | Bria VRMBG 3.0 (fal) | ✅ Verified |

### Speak & audio

| Higgsfield feature | Here | Model | Status |
|---|---|---|---|
| Speak / talking avatar | `talking-avatar`: photo or saved character + script in an ElevenLabs voice (clones first) or own audio | OmniHuman v2 (fal) + ElevenLabs | ✅ Verified |
| Lipsync Studio | `lipsync`: clip + script/voice or audio | sync-3 (fal) | ✅ Verified |
| Higgsfield Audio: TTS | `tts` | ElevenLabs (cloned + stock voices) | ✅ Verified |
| Higgsfield Audio: sound effects | `sfx` (text) and `video-sfx` (synced to a clip) | ElevenLabs SFX; Mirelo SFX 2.0 (fal) | ✅ Verified |
| Higgsfield Audio: music | `music` | Eleven Music | ✅ Verified |
| Higgsfield Audio: voice swap | Long-form voice changer (existing) | ElevenLabs speech-to-speech | 🟡 not exposed as a tool |
| Higgsfield Audio: translate + lip-sync | `dub` | VEED Dubbing (fal) | ⏸ built, not verified |
| Subtitles | — | — | ↗ VPS agent |

### Not covered

| Higgsfield feature | Status |
|---|---|
| Mangaka (manga / webtoon from a story) | ❌ backlog — storyboard + Photo Styles is a partial stand-in |
| Playable (mobile game from a prompt) | ❌ out of scope |
| Supercomputer agent, Higgsfield MCP for Claude | 🟡 the engine API and tool registry are client-agnostic; no MCP server |
| Virality Predictor, AI Meme Generator | ❌ backlog (low value) |
| Community feed, contests, team plans, Unlimited queue | n/a |

## Models added to the catalog

Studio models (Image / Video / Cinema pickers, `POST /generate`, Long-form):

| Catalog id | Provider | Notes |
|---|---|---|
| `apimart/gpt-image-2.6-flare`, `apimart/gpt-image-2.6-sunburst`, `apimart/gpt-image-2` | ApiMart | up to 8 refs; 2.6 adds mask edits (`mask`) and `format: svg / gif` |
| `apimart/seedream-5-0-pro` | ApiMart | 2K, up to 8 refs |
| `apimart/flux-2-max` | ApiMart | 4 MP, up to 7 refs |
| `qwen/qwen-image-3.0-pro`, `qwen/wan2.7-image-pro` | Qwen Token Plan | sync image API; refs 3 / 4 |
| `apimart/kling-v3-omni` | ApiMart | audio, start + end frame, up to 4 reference images, 720p/1080p/4K |
| `apimart/veo3.1-lite` | ApiMart | cheapest Veo 3.1, 8 s |
| `apimart/MiniMax-H3`, `apimart/MiniMax-Hailuo-2.3`, `apimart/kling-3.0-turbo`, `apimart/seedance-2.0-fast` | ApiMart | |
| `fal/wan-3.0` | fal | one entry → `alibaba/wan-3.0/{text,image,reference}-to-video`; up to 10 identity references ("Image 1…"), ref clips/voices. Reference-to-video verified (VPS run) |
| `qwen/happyhorse-1.1` | Qwen Token Plan | one entry → `happyhorse-1.1-{t2v,i2v,r2v}`; r2v = up to 9 identity references ("[Image N]"). t2v, i2v and r2v verified (VPS runs) |
| existing `apimart/seedance-2.0` / `-2.5` | ApiMart | now accept reference images / clips / audio when there is no start frame |
| existing ApiMart Veo 3.1 Fast / Quality | ApiMart | Long-form "extend" now uses the native remix extension for Veo clips ApiMart rendered |

Request inputs `videos` / `audios` (reference clips / voices) on `generate()` are hosted on fal's CDN, because ApiMart and fal
need public URLs for those. `POST /generate` itself is unchanged.

Tool-only models (`kind` = tool modelKind, listed in `GET /catalog`, not in the studio pickers), in `engine/lib/toolmodels.js`:
Topaz Wonder / SeedVR2 (image upscale), Topaz Proteus / SeedVR2 (video upscale), OmniHuman v2 / Kling AI Avatar / MiniMax H3
lip-sync / VEED Fabric (avatar), sync-3 / VEED Lipsync (lip-sync), VEED Dubbing, Kling 3.0 / 2.6 Motion Control,
Kling 3.0 Omni / Wan 2.7 VideoEdit / Kling 4.0 / Kling O3 edit, PixVerse Swap, Grok / FLUX 3 extend, Bria RMBG / VRMBG /
VEED video BG removal, Bria Expand / FLUX.2 outpaint, FLUX Fill / GPT Image 2.6 inpaint, Finegrain eraser, Bria relight,
Google VTO, Seedream Layerize, Mirelo SFX, ElevenLabs SFX / Music, Lyria 3.5. Tools use the first model in their list.
The rest are fallbacks used when that provider is not connected.

New providers / provider features: `engine/lib/providers/qwen.js` (Qwen Cloud Token Plan, key `QWEN_API_KEY` / settings `qwenKey`,
base URL `QWEN_BASE`, Providers card with a free Test); fal CDN upload (`falUpload`); ApiMart generic task runner, image API,
motion control, video edit and Veo remix; ElevenLabs sound effects and music.

## Verification

- **Offline:** `node --test engine/test/parity.test.mjs` runs 20 tests and makes no network calls. It checks the request bodies against
  docs.apimart.ai and fal's OpenAPI schemas (ApiMart video/image/motion/edit, Qwen HappyHorse t2v/i2v/r2v and images,
  fal Wan 3.0) and the registry contract served to the Apple app. It also runs nine tools end-to-end with every provider
  call stubbed: background removal, talking avatar from audio and from a script, motion control, Recast, product scenes,
  extend, transitions and inpaint. All 20 pass with Homebrew ffmpeg 9 and inside the bookworm image (ffmpeg 5.1.9) that
  production uses. The bookworm run also covers the `apad` and `alphamerge` filter graphs.
- **Real runs** on a local engine (`ENGINE_PORT=4953`, keys only in the process environment). Each output was downloaded and
  inspected (frames, duration, alpha, dimensions):

| Tool / model | Result | Cost |
|---|---|---|
| Background Remover (Bria RMBG), twice: once over the API, once through the web Tools page | RGBA PNG, clean hair edge | $0.036 |
| Upscale Image (Topaz Wonder 3.5, 2×) / SeedVR2 | 1280 → 2560 px | ≈$0.07 |
| Edit Image on Seedream 5.0 Pro (ApiMart) | "mustard sweater" applied, identity kept, 2048² | $0.056 |
| Face Swap (NB 2.1) | 1st run swapped the wrong way → prompt fixed → 2nd run correct | ≈$0.13 |
| Photo Styles "3D Figure", Relight (golden hour from left) | both on-brief | ≈$0.13 |
| Storyboard (2 frames), Shots (coverage ×2) | same woman, wardrobe and light across frames | ≈$0.27 |
| Inpaint (FLUX Fill, painted mask) | necklace added only inside the mask | ≈$0.08 |
| Expand (Bria, → 16:9) | 2275×1280, seamless | $0.04 |
| Breakdown (Seedream Layerize) | 7 layers: bottle, label, "GLOW" text… | $0.034 |
| Try-on (Google VTO) | red leather jacket on the person | $0.075 |
| Vector & GIF (GPT Image 2.6, SVG) | valid 7.7 KB SVG, 22 shapes, sanitised | $0.094 |
| Talking Avatar: VEED Fabric 480p (3.3 s), OmniHuman v2 (4 s, audio padded) | natural lip-sync | ≈$0.26 + $0.42 |
| Lipsync (sync-3) on the avatar clip with a new ElevenLabs line | new mouth shapes, 3.1 s | ≈$0.42 |
| Extend (Grok on fal, +3 s) | seamless continuation, joined 7.0 s file | ≈$0.15 |
| Motion Control (Kling 3.0 Motion Control, ApiMart, pro) | man performs the woman's talking performance, 1440², 4 s | $0.52 |
| Effects "Particles" (Kling 3.0 i2v, 5 s) | dissolves into particles, identity kept | ≈$0.35 |
| Mixed Media "Watercolor" (Wan 2.7 VideoEdit via a fal-hosted clip) | watercolor restyle, motion kept, 960², audio kept | $0.378 |
| Video Swap (PixVerse, person) | swap applied, 1280², audio kept | $0.05 |
| Add Sound Effects (Mirelo SFX 2.0), Sound Effects (ElevenLabs) | synced audio track / 2 s mp3 | $0.03 + credits |
| Cinema Studio via the web UI (Veo 3.1 Lite, Dolly In → Crane Up, Noir) | 1080p, 7.85 s, audio; Lite follows the stacked moves only loosely | $0.067 |
| Recast on Kling 3.0 Omni edit | **failed the quality bar**: clip re-rendered, person not replaced → Recast moved to PixVerse Swap | ≈$0.32 |
| Qwen-Image 3.0 Pro, Wan 2.7 Image Pro edit (Qwen plan) | perfect sign text; green raincoat with identity kept | plan credits |

- **Real runs on the VPS test container** (`studio-test-parity`, built from this branch, keys via `--env-file` only,
  removed afterwards). Each output was probed with ffprobe and checked frame by frame (4-frame strips); audio was checked
  with `volumedetect`, and the music track with a waveform and spectrogram:

| Tool / model | Result | Cost |
|---|---|---|
| Recast (PixVerse Swap, person) | the man replaces the woman in her talking clip; same performance, background and audio | ≈$0.05 |
| Click to Ad (LLM hook → NB 2.1 keyframe → Veo 3.1 Fast, 9:16) | UGC ad, product label legible, spoken line with audio, 7.9 s | NB in Gemini row + Veo 3.1 Fast (not itemised by ApiMart) |
| Wan 3.0 reference-to-video (fal), 480p, 2 s, one reference photo | 854×480, 2.02 s, audio; same woman (hair, cardigan, earrings) walks in a park, turns and waves | ≈$0.10 |
| HappyHorse 1.1 t2v (Qwen plan), 480P, 3 s | 848×480, 3.16 s, audio; red kite over a green hill, on-prompt | plan credits |
| HappyHorse 1.1 i2v (Qwen plan), 480P, 3 s | 640×640 (keeps the square start frame), audio; she smiles and tilts her head, identity kept | plan credits |
| HappyHorse 1.1 r2v (Qwen plan), 480P, 3 s, one reference photo | 848×480, audio; same woman walks down a park path and waves | plan credits |
| Upscale Video (SeedVR2, 2×) on a 2 s 480² clip | 960², 2 s, audio kept; visibly sharper lashes, iris and skin texture, no flicker across frames | ≈$0.04 |
| Video Background Remover (Bria VRMBG 3.0, green) on the same clip | clean green key around hair and shoulders on every frame, audio kept | ≈$0.10 |
| Music (Eleven Music, 10 s, instrumental "warm lo-fi piano loop") | 10.0 s stereo mp3, −18 dB mean; repeating 2.5 s phrase with note onsets and broadband texture (checked by waveform and spectrogram, not by ear) | ElevenLabs credits |

All three HappyHorse runs were billed to the Token Plan key, which confirms the plan is entitled to HappyHorse. HappyHorse is
the only video model the plan includes.


## Backlog (ranked)

1. **Draw to Video** — built (`draw-to-video`, `enabled: false`), including the web sketch canvas. Needs one verified run:
   check that Gemini reads the arrows and that Nano Banana removes the marks cleanly. Then set `enabled: true`.
2. **Translate & Dub** — built (`dub`, VEED Dubbing, `enabled: false`). Needs one verified run on a clip with speech (≈$0.11 per input second).
3. **Montage pacing as real multi-shot** — map Cinema Studio's Dynamic/Chaotic pacing to Kling 3.0 Omni `multi_shot` /
   `multi_prompt` (up to 6 shots in one render) instead of a prompt directive.
4. **Multi-keyframe video** — Kling 4.0 edit `middle_image_urls` (up to 8) for Higgsfield-style keyframe timelines.
5. **Genjutsu motion library** — a server-side list of trend motion clips (dances, transitions) to use as motion-control /
   reference-video presets.
6. **Voice changer as a tool** — expose the long-form ElevenLabs speech-to-speech swap (`/shots/:sid/voice-swap`) as a
   standalone `voice-swap` tool for any clip.
7. **More presets** — Higgsfield ships hundreds of Shorts presets; ours are 65 effects + 16 photo styles + 16 ad scenes
   (data-only additions in `engine/lib/presets.js`).
8. **Mangaka** — comic/manga pages from a story (storyboard + panel layout + lettering with GPT Image 2.6).
9. **Virality predictor / meme generator** — LLM-only, low value.
10. **Sora 2** — not offered by any connected provider.
