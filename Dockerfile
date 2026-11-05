# Studio server: web app + engine (providers, long-form films, media, post-production) in one container.
# Build:  docker build -t studio .
# Run:    docker run -d -p 4848:4848 -v studio-data:/data --name studio studio
# Then open http://<server>:4848 and sign in with the access code (set ENGINE_TOKEN, or read accessToken from /data/settings.json;
# the log only shows its first 4 characters).
# Post-production (subtitles, dialogue cleanup, mastering, picture) runs on the CPU: see docs/post-production.md.

FROM node:22-bookworm-slim AS web
WORKDIR /app
RUN npm install --no-save --no-audit --no-fund vite@^5.4.0 @tailwindcss/vite@^4.1.18 tailwindcss@^4.1.18
COPY index.html vite.config.mjs tailwind.config.js ./
COPY public ./public
COPY src ./src
RUN npx vite build

# whisper.cpp (server-side subtitles). Pinned release + commit; static binary, plain ggml CPU backend
# (OpenBLAS benchmarked 2.3× slower on the EPYC host). amd64 targets AVX2/FMA/F16C (x86-64-v3), arm64 uses NEON.
FROM debian:bookworm-slim AS whisper
ARG WHISPER_VERSION=v1.9.5
ARG WHISPER_COMMIT=d1be6fde11ac6e0407606b4e42fe72d34add8037
ARG TARGETARCH
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential cmake git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN git -c advice.detachedHead=false clone --depth 1 --branch "${WHISPER_VERSION}" https://github.com/ggml-org/whisper.cpp /src \
 && test "$(git -C /src rev-parse HEAD)" = "${WHISPER_COMMIT}"
WORKDIR /src
RUN if [ "${TARGETARCH}" = "arm64" ]; then CPU="-DGGML_NATIVE=OFF"; \
    else CPU="-DGGML_NATIVE=OFF -DGGML_AVX=ON -DGGML_AVX2=ON -DGGML_FMA=ON -DGGML_F16C=ON -DGGML_BMI2=ON"; fi \
 && cmake -B build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DWHISPER_BUILD_TESTS=OFF \
      -DWHISPER_SDL2=OFF -DWHISPER_CURL=OFF ${CPU} \
 && cmake --build build -j"$(nproc)" --target whisper-cli \
 && install -D -m 755 build/bin/whisper-cli /out/usr/local/bin/whisper-cli \
 && install -D -m 644 LICENSE /out/opt/post/licenses/whisper.cpp.LICENSE

# Models, fetched from pinned revisions and checked against sha256:
#   whisper large-v3-turbo q8_0 (874 MB; fastest large model on the host, ≈ f16 accuracy — see docs/post-production.md)
#   Silero VAD v6.2.0 (skips music/silence: fewer hallucinations, ~2× faster)
#   RNNoise std.rnnn for ffmpeg's arnndn (Xiph RNNoise's own model, BSD-3-Clause; best of 6 models benchmarked)
# Smaller image: --build-arg WHISPER_MODEL=ggml-small-q8_0.bin --build-arg WHISPER_MODEL_SHA256=49c8fb02…
FROM debian:bookworm-slim AS models
ARG HF_WHISPER_REV=5359861c739e955e79d9a303bcbc70fb988958b1
ARG HF_VAD_REV=9ffd54a1e1ee413ddf265af9913beaf518d1639b
ARG RNN_REV=0fda24c46d78f0207d820bb970fbe85c1971b39c
ARG WHISPER_MODEL=ggml-large-v3-turbo-q8_0.bin
ARG WHISPER_MODEL_SHA256=317eb69c11673c9de1e1f0d459b253999804ec71ac4c23c17ecf5fbe24e259a1
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /out/opt/post/models
RUN curl -fsSL --retry 3 -o "${WHISPER_MODEL}" "https://huggingface.co/ggerganov/whisper.cpp/resolve/${HF_WHISPER_REV}/${WHISPER_MODEL}" \
 && curl -fsSL --retry 3 -o ggml-silero-v6.2.0.bin "https://huggingface.co/ggml-org/whisper-vad/resolve/${HF_VAD_REV}/ggml-silero-v6.2.0.bin" \
 && mkdir rnnoise \
 && curl -fsSL --retry 3 -o rnnoise/std.rnnn "https://raw.githubusercontent.com/richardpl/arnndn-models/${RNN_REV}/std.rnnn" \
 && printf '%s  %s\n' \
      "${WHISPER_MODEL_SHA256}" "${WHISPER_MODEL}" \
      2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987 ggml-silero-v6.2.0.bin \
      6b8943dc4a9b6b24425873992a44f29c0577503276456af46a8854774faeb294 rnnoise/std.rnnn \
    | sha256sum -c -

FROM node:22-bookworm-slim
# ffmpeg 5.1 (Debian) has libass, zimg, arnndn, loudnorm, minterpolate, nlmeans — everything post.js uses.
# libgomp1: whisper.cpp's OpenMP threads. fonts-inter: burned-in subtitle font (DejaVu stays as fallback).
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg espeak-ng ca-certificates tini libgomp1 fonts-inter \
 && rm -rf /var/lib/apt/lists/*
# Models first (big, rarely change) so code edits don't invalidate this layer.
COPY --from=models /out/ /
COPY --from=whisper /out/ /
# Claude as a long-form director on your Claude subscription (Claude Code CLI, headless `claude -p`).
# Auth: run `claude setup-token` once on any machine and set CLAUDE_CODE_OAUTH_TOKEN for the container.
# CLI state lives on the data volume. Pinned; the in-app updater is off.
RUN npm install -g --no-audit --no-fund @anthropic-ai/claude-code@2.1.318 && npm cache clean --force
ENV CLAUDE_CONFIG_DIR=/data/claude \
    DISABLE_AUTOUPDATER=1
WORKDIR /app
COPY engine ./engine
COPY --from=web /app/dist ./dist
ARG WHISPER_MODEL=ggml-large-v3-turbo-q8_0.bin
ENV ENGINE_HOST=0.0.0.0 \
    ENGINE_PORT=4848 \
    ENGINE_DATA=/data \
    NODE_ENV=production \
    POST_MODELS=/opt/post/models \
    WHISPER_MODEL=/opt/post/models/${WHISPER_MODEL}
VOLUME /data
EXPOSE 4848
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:4848/engine/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "engine/server.js"]
