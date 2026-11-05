# Post-production on the server

`engine/lib/post.js` (+ the pure `engine/lib/subtitles.js`) finishes clips and long-form masters on the
VPS CPU (12 × EPYC 7763 vCPU, no GPU) and uses a cloud provider only where the CPU can't reach the same
quality. Only steps that measured clearly better on the server ship; everything else is listed under
[Rejected](#rejected). Everything is reachable through the engine API, so the web UI and the Apple app
use the same pipeline. A long-form assembly never fails because of post-production: a failing step
falls back to the plain clip / plain master and is noted in the production log.

| Feature | Runs on | Default |
|---|---|---|
| Subtitles + transcripts: whisper.cpp large-v3-turbo q8_0 + Silero VAD, DTW word times → SRT, WebVTT, JSON | CPU | off |
| …as a soft MP4 track (`mov_text`: Safari, QuickTime, AVPlayer; the web player gets the WebVTT) or burned in (libass, Inter) | CPU | — |
| Two-pass loudness: −16 LUFS integrated, −1.5 dBTP, linear gain; mix kept as float PCM until the one final AAC encode | CPU | **always, for masters** |
| Colour & exposure matching between the shots of a scene (3-point levels + chroma cast) | CPU | off |
| Motion-compensated interpolation of clips below 23 fps to 24 fps (Wan 2.2 renders 16 fps) | CPU | **auto** (only < 23 fps clips) |
| Dialogue noise removal (RNNoise) — for noisy recordings only | CPU | off |
| Voice isolation | ElevenLabs `/v1/audio-isolation` | off |
| Denoise grainy / low-light footage (nlmeans) — Enhance only | CPU | off |
| AI upscale | fal.ai Topaz (Proteus) | off |

## Build

The Dockerfile has two extra build stages; both are pinned:

* **whisper** — clones `ggml-org/whisper.cpp` tag `v1.9.5`, verifies the commit (`d1be6fd…`), builds a
  static `whisper-cli` with the plain ggml CPU backend (AVX2/FMA/F16C on amd64, NEON on arm64).
* **models** — downloads from pinned Hugging Face / GitHub revisions and checks sha256:
  `ggml-large-v3-turbo-q8_0.bin` (874 MB), `ggml-silero-v6.2.0.bin` (0.9 MB) and RNNoise `std.rnnn`
  (0.3 MB, Xiph RNNoise's own model, BSD-3-Clause) from `richardpl/arnndn-models`.

The runtime stage adds `libgomp1` and `fonts-inter` (9.6 MB) to the existing Debian ffmpeg 5.1, which
already has libass, zimg, arnndn, loudnorm, minterpolate and nlmeans — no second ffmpeg. The model layer
sits before `COPY engine`, so code changes rebuild in seconds (72 s with the web build). Layers added:
876 MB models + 3.3 MB whisper-cli + 10 MB packages ≈ **+0.9 GB**. For a smaller image:
`--build-arg WHISPER_MODEL=ggml-small-q8_0.bin --build-arg WHISPER_MODEL_SHA256=49c8fb02b65e6049d5fa6c04f81f53b867b5ec9540406812c643f177317f779f`
(3× faster, weaker on accents and non-English).

```bash
docker build -t studio .                                  # same command as before
docker run --rm --entrypoint whisper-cli studio -h        # sanity check
```

Local (non-Docker) engine: `brew install whisper-cpp` and point `WHISPER_BIN`, `WHISPER_MODEL`,
`WHISPER_VAD_MODEL`, `RNNOISE_DIR` at your files; without them `GET /engine/api/post/capabilities`
reports the features as unavailable and everything else keeps working.

### Tuning (environment)

| Variable | Default | Meaning |
|---|---|---|
| `POST_THREADS` | cores − max(2, cores/4) → 9 on 12 cores | threads for one heavy step (whisper, x264, filters) |
| `POST_WORKERS` | 1 | heavy steps running at once (others queue; cloud waits don't hold a slot) |
| `POST_NICE` | 10 | priority of every spawned tool (started through `nice`, so all its threads inherit it) |
| `POST_X264_PRESET` | `medium` | encoder preset for enhance / burn-in passes (1.35× realtime at 1080p vs 0.82× for `slow`) |
| `WHISPER_MODEL`, `WHISPER_VAD_MODEL`, `WHISPER_DTW`, `WHISPER_VAD=0` | image paths | model overrides; the DTW preset follows the model file name |
| `SUBTITLE_FONT` | `Inter` | burned-in caption font (fontconfig family) |

## API

All under `/engine/api`, same auth as the rest of the engine.

| Method | Path | Body / result |
|---|---|---|
| GET | `/post/capabilities` | `{ whisper, whisperModel, vad, rnnoise, falUpscale, elevenIsolation, pool, options, pricing }` |
| POST | `/post/estimate` | `{ assetId, ...options }` → `{ usd, elevenCredits, notes, info:{width,height,fps,duration,hasAudio} }` |
| POST | `/post/enhance` | `{ assetId, ...options }` → job |
| POST | `/post/transcribe` | `{ assetId, language?, translate?, vad? }` → job |
| GET | `/post/jobs/:id` | `{ id, kind, status: queued·running·done·error·cancelled, message, progress 0–1, timings, estimate, assetId, url, posterUrl, width, height, duration, loudnessBefore, loudness, transcript }` |
| POST | `/post/jobs/:id/cancel` | stops a queued or running job |
| GET | `/post/jobs?assetId=` | recent jobs for a source or result |
| GET | `/post/transcripts/:assetId` | `{ language, model, vttUrl, srtUrl, jsonUrl, cues, words, text, segments[], words[] }` |

Enhance options (all optional; unknown values fall back to the default):

| Option | Values | Default |
|---|---|---|
| `subtitles` | `off` · `soft` · `burn` | `off` |
| `language` | `auto` or ISO 639-1 (`en`, `de`, …) | `auto` |
| `translate` | subtitles in English | `false` |
| `vad` | `false` also transcribes sung lyrics (Silero classes singing as non-speech) | `true` |
| `subtitleStyle` | `clean` (white, outline) · `box` (dark plate) | `clean` |
| `audio` | `off` · `clean` (RNNoise) · `isolate` (ElevenLabs) | `off` |
| `loudness` | two-pass −16 LUFS | `true` |
| `denoise` | nlmeans; skipped when upscaling (Topaz denoises) | `false` |
| `smoothMotion` | `off` · `auto` (only clips below 23 fps → 24) | `off` |
| `upscale` | `off` · `1080p` · `1440p` · `2160p` (short side, never shrinks) — Topaz on fal.ai | `off` |

The result is a new library video (`source: "enhanced"`, `parentId` = the original) with its transcript
stored alongside (`GET /post/transcripts/<new id>`). When nothing touches the picture the video stream is
copied, not re-encoded.

Long-form briefs (`PATCH /productions/:id`) take `subtitles` (`off`/`soft`/`burn`), `subtitleLanguage`,
`translateSubtitles`, `subtitleStyle`, `audioCleanup` (`off`/`clean`/`isolate`), `colorMatch`,
`smoothMotion` (`auto`/`off`) and `upscale` (`off`/`topaz`, for clips smaller than the master frame). The
master then carries `master.subtitles` (`vttUrl`, `srtUrl`, `jsonUrl`, `language`, `mode`, `cues`),
`master.loudness` (`I`, `LRA`, `TP` measured on the result) and `master.post` (step timings). Topaz
upscales and ElevenLabs isolations are cached per clip, so re-assembling costs nothing extra.

## Benchmarks

VPS, Debian ffmpeg 5.1 (the image's), 9 threads, `nice 10`, test material: five real generated clips from
the studio library (Gemini Omni 1080p ×4, Veo 3.1 Fast 720p, all courtroom dialogue) and an 18.5 s
1080×1920 phone clip (low light, music with singing).

### Subtitles — whisper.cpp v1.9.5

58.6 s of mixed dialogue (6 clips), wall time:

| Model | beam 5 | + flash-attn | Notes |
|---|---|---|---|
| small q8_0 | 12.1 s | 11.4 s | good on clear dialogue, weaker otherwise |
| medium q5_0 | 36.7 s | 36.1 s | |
| large-v3-turbo q5_0 | 45.8 s | 77.2 s | q5 dequant is slow on Zen 3 |
| **large-v3-turbo q8_0** | **36.4 s** | 34.9 s | **≈ f16 accuracy, fastest large model** |
| large-v3-turbo f16 | 39.9 s | 82.5 s | |
| turbo q5_0, OpenBLAS build | 103.6 s | | rejected |
| turbo q5_0, greedy | 45.9 s | | decoding isn't the bottleneck |
| **turbo q8_0 + Silero VAD + DTW (shipped)** | **20.2 s** | | **RTF 0.34**; VAD also removed the trailing “you” hallucination |

So a 5-minute film transcribes in ≈ 1.7 min and a 10-minute film in ≈ 3.5 min on 9 threads (see the
end-to-end numbers below for the measured 5-minute run). JFK sample transcribed verbatim. VAD drops
sung lyrics (the phone clip is music + singing: 0 segments with VAD at any threshold, 3 without), hence
the `vad: false` option.

### Dialogue cleanup — 40 s of courtroom dialogue + noise at 5 dB SNR

SI-SDR (dB, vs the clean track) and whisper WER vs the clean transcript. Input: 4.96 dB, WER 10.3 % (hiss
+ 50 Hz hum) / 12.1 % (rumble + crowd band):

| Chain | hiss+hum | rumble+crowd | clean speech in (damage) | music in (damage) | WER |
|---|---|---|---|---|---|
| afftdn nr=12 | 5.69 | 5.17 | 41.5 | 28.4 | 0 / 0 % |
| RNNoise cb | 7.46 | 6.60 | 6.9 | 8.3 | 0 / 6.9 % |
| RNNoise bd | 8.06 | 7.06 | 5.3 | 2.2 | 0 / 8.6 % |
| RNNoise std | 9.58 | 7.14 | 10.3 | 3.4 | 0 / 0 % |
| **RNNoise std, mix 0.85 (shipped `clean`)** | **10.06** | **7.98** | **11.9** | 6.1 | 0 / 0 % |
| + 70 Hz high-pass | 4.83 | 4.00 | 5.7 | −0.9 | — |
| EQ + de-esser + compressor “dialogue” preset | 2.29 | 1.75 | — | — | 0 / 0 % |
| ElevenLabs isolation | (resynthesised: waveform correlation 0.07, SI-SDR meaningless) | | | | transcript intact |

Any denoiser removes ambience from already-clean generated audio, so dialogue cleanup is opt-in and
meant for noisy recordings. The EQ/compression preset was dropped: it measurably changes the sound
and its benefit can't be shown.

### Loudness

Two-pass `loudnorm` (measure → linear gain) instead of one pass in dynamic mode; see the end-to-end
results for measured masters.

### Colour matching — the five courtroom clips (one scene)

Spread across shots (max − min) of luma 10th percentile / mean / 90th percentile and chroma means:

| | Y low | Y mean | Y high | U | V |
|---|---|---|---|---|---|
| before | 10.0 | 10.8 | 50.0 | 3.1 | 6.5 |
| single linear gain (first version) | 15.0 | 3.8 | 26.0 | 1.6 | 2.6 |
| **3-point levels (shipped)** | **3.0** | **5.0** | **18.0** | **1.6** | **2.6** |

Analysis takes ≈ 0.8 s per clip (cached on the asset); the correction is one `lutyuv` in the conform
pass (no extra encode). Corrections are partial (70 %) and capped, and only shots in the same scene are
matched.

### Picture (1080p unless noted)

| Test | Result | Verdict |
|---|---|---|
| Upscale 540p→1080p, vs original: bicubic / Lanczos / spline36 | SSIM 0.9855 / 0.9855 / 0.9855, PSNR 41.7 / 41.9 / 41.8 | Lanczos already used by conform; nothing to add |
| + CAS 0.35 / CAS 0.6 / unsharp | SSIM 0.9800 / 0.9799 / 0.9838 | sharpening lowers fidelity → rejected |
| 720p→1080p: Lanczos / + CAS | SSIM 0.9886 / 0.9830 | same |
| Real-ESRGAN animevideov3 ×2 (ncnn on lavapipe, CPU) | 59 s per 540p frame (≈ 3 h per 8 s clip); x4plus didn't finish one frame in 180 s | rejected → Topaz on fal |
| Interpolation 16→24, 720p: duplicate / blend / minterpolate mci | SSIM 0.960 / 0.965 / 0.979; 1.8 s / 1.8 s / 35 s per 4 s | **shipped (`auto`, < 23 fps only)** |
| 12→24, 720p | SSIM 0.940 / 0.957 / 0.984 | |
| handheld phone 16→24 (540×960) | dup 0.976 vs mci 0.983; worst frame 0.856 vs 0.902; 27.8 s per 6 s | mci better even on its worst frame |
| minterpolate at 1080p | 76 s per 4 s (0.05× realtime) | why it runs before scaling, on the clip's own size |
| RIFE v4.6 (ncnn on lavapipe, CPU) | 13 s per 720p in-between frame (≈ 14 min per 8 s clip) | rejected |
| Denoise, clean + synthetic grain (SSIM 0.823): hqdn3d light / medium / strong | 0.843 / 0.876 / 0.922, ~6.5 s per 4 s | weak |
| atadenoise / vaguedenoiser | 0.830 / 0.928 | weak |
| **nlmeans s=2.5 p=5 r=7 (shipped)** / nlmeans p=7 r=9 | **0.986** (PSNR 35.9→45.2) / 0.980; 52 s / 84 s per 4 s | opt-in: on clean footage it costs detail (SSIM 0.993) |
| Deflicker on synthetic 1–2 % flicker | luma jitter 10.6 → 1.7 (original 0.24); clean SSIM 0.99995 | not shipped: also flattens deliberate light changes (fades, flashes), no real flickering clip to validate |
| x264 1080p 8 s: slow / medium (CRF 17) | 9.8 s / 5.9 s | post passes use medium |

## Rejected

* CPU upscaling (any scaler, with or without sharpening) — no fidelity gain over the Lanczos conform.
* Real-ESRGAN and RIFE on the CPU (ncnn + lavapipe) — minutes per frame.
* OpenBLAS whisper build (2.3× slower), flash attention (slower for q5/f16), q5 quantisation (slower than q8 on Zen 3).
* EQ / de-esser / compressor “dialogue” preset and high-pass filtering — lower fidelity, no measurable benefit.
* Deflicker, hqdn3d/atadenoise/vaguedenoiser — see above.
* Interpolation to 30/60 fps — soap-opera look on film content; only sub-23 fps sources are interpolated.

END_TO_END
