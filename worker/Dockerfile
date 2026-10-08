# The export worker: Node plus the system ffmpeg. Build from the repo root:
#   docker build -f worker/Dockerfile -t reelcraft-export-worker .
# Runtime env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, NODE_ENV=production.
FROM node:24-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg fontconfig \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production FFMPEG_PATH=/usr/bin/ffmpeg
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY tsconfig.json ./
COPY src/lib ./src/lib
COPY worker ./worker
CMD ["npx", "tsx", "worker/index.ts"]
