FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg fonts-noto-cjk ca-certificates chromium && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
COPY package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY server ./server
COPY public ./public
COPY scripts ./scripts
RUN mkdir -p /data && chown node:node /data
USER node
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4310 DATA_DIR=/data PLATFORM_CHROMIUM_PATH=/usr/bin/chromium
HEALTHCHECK --interval=20s --timeout=5s --start-period=15s CMD node -e "fetch('http://127.0.0.1:4310/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/app.mjs"]
