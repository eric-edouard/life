# syntax=docker/dockerfile:1
# The push relay, `life-push` on Fly: lifelog's `push-relay.ts`, which holds the app's APNs key, so a user's own server
# never does (SECURITY.md, "What leaves the Mac"). Built from the repo root, which is where Life's modules are:
# `fly deploy -a life-push --remote-only --config apps/lifelog/apps/server/push-relay/fly.toml .`

FROM oven/bun:1 AS build
WORKDIR /src

# What the entry point reads, and nothing else: its two modules, and the two of Life's core they import (the clock, and
# the push schema, its only dependency being zod).
COPY apps/lifelog/apps/server/src/apns-request.ts apps/lifelog/apps/server/src/push-relay.ts apps/lifelog/apps/server/src/
COPY apps/server/src/core/clock.ts apps/server/src/core/push.ts apps/server/src/core/

# `@life/server/src/core/*` as the code names it, and the one package installed.
RUN mkdir -p node_modules/@life \
    && ln -s /src/apps/server node_modules/@life/server \
    && bun add zod@4.6.7

RUN bun build apps/lifelog/apps/server/src/push-relay.ts --target=bun --outfile /app/push-relay.js

FROM oven/bun:1
COPY --from=build /app/push-relay.js /app/push-relay.js
EXPOSE 8080
CMD ["bun", "/app/push-relay.js"]
