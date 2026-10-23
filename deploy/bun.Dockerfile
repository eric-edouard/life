# Life and the voice server: one image of the repo, each service picks its command (compose.yaml).
FROM oven/bun:1.4.2-slim
# git for the data repo and the forge's clones, mbsync (isync) for mail over IMAP.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git isync \
  && rm -rf /var/lib/apt/lists/*
# Both apps snapshot themselves with restic (apps/server/src/host/backup.ts, apps/voice/src/restic.ts).
COPY --from=restic/restic:0.19.1 /usr/bin/restic /usr/local/bin/restic
# gog for Google Tasks, its keys in a file under HOME (the data volume), not a desktop keyring.
ADD --checksum=sha256:d53cf89f0c2a2338211212e380b3efcacadd4e27e500cb8e7ed2cd82a739da2e \
  https://github.com/steipete/gogcli/releases/download/v0.46.0/gogcli_0.46.0_linux_amd64.tar.gz /tmp/gog.tgz
RUN tar -xzf /tmp/gog.tgz -C /usr/local/bin ./gog && rm /tmp/gog.tgz
ENV GOG_KEYRING_BACKEND=file

WORKDIR /app
ENV NODE_ENV=production
COPY . .
RUN bun install --frozen-lockfile --production --ignore-scripts && install -d -o bun -g bun /data
USER bun
