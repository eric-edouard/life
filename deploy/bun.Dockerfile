# Life and the voice server: one image of the repo, each service picks its command (compose.yaml).
FROM oven/bun:1.4.2-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git \
  && rm -rf /var/lib/apt/lists/*
# Both apps snapshot themselves with restic (apps/server/src/host/backup.ts, apps/voice/src/restic.ts).
COPY --from=restic/restic:0.18.1 /usr/bin/restic /usr/local/bin/restic

WORKDIR /app
ENV NODE_ENV=production
COPY . .
RUN bun install --frozen-lockfile --production --ignore-scripts && install -d -o bun -g bun /data
USER bun
