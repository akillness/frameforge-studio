# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS knowledge-package
# The filtered source context is read-only and never copied into image layers.
RUN --mount=type=bind,source=.,target=/source,readonly node /source/scripts/knowledge.mjs package --root /source --output /knowledge-package

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg fonts-noto-cjk ca-certificates chromium && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
COPY package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY server ./server
COPY public ./public
COPY scripts ./scripts
COPY harness/manifest.json ./harness/manifest.json
COPY harness/versions ./harness/versions
COPY --from=knowledge-package /knowledge-package/ ./
RUN node scripts/version-harness.mjs verify
RUN mkdir -p /data && chown node:node /data
USER node
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4310 DATA_DIR=/data PLATFORM_CHROMIUM_PATH=/usr/bin/chromium FRAMEFORGE_KNOWLEDGE_MODE=packaged
HEALTHCHECK --interval=20s --timeout=5s --start-period=15s CMD node -e "fetch('http://127.0.0.1:4310/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/app.mjs"]
