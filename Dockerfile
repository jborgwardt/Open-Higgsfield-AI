# Studio server: web app + engine (providers, long-form films, media) in one container.
# Build:  docker build -t studio .
# Run:    docker run -d -p 4848:4848 -v studio-data:/data --name studio studio
# Then open http://<server>:4848 and sign in with the access code from `docker logs studio`.

FROM node:22-bookworm-slim AS web
WORKDIR /app
RUN npm install --no-save --no-audit --no-fund vite@^5.4.0 @tailwindcss/vite@^4.1.18 tailwindcss@^4.1.18
COPY index.html vite.config.mjs tailwind.config.js ./
COPY public ./public
COPY src ./src
RUN npx vite build

FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg espeak-ng ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY engine ./engine
COPY --from=web /app/dist ./dist
ENV ENGINE_HOST=0.0.0.0 \
    ENGINE_PORT=4848 \
    ENGINE_DATA=/data \
    NODE_ENV=production
VOLUME /data
EXPOSE 4848
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:4848/engine/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "engine/server.js"]
