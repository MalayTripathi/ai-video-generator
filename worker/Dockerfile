# The export worker: Node plus the system ffmpeg. Build from the repo root:
#   docker build -f worker/Dockerfile -t reelcraft-export-worker .
# Runtime env, validated at boot (src/lib/config/env.ts, worker scope): APP_ENV=production
# (or preview), NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SPEND_CAP_ENABLED,
# SPEND_CAP_MONTHLY_USD. NODE_ENV only tunes Node; it does not decide the environment.
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
CMD ["npx", "tsx", "--conditions=react-server", "worker/index.ts"]
