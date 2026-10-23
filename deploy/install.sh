#!/usr/bin/env bash
# Prepares a fresh Ubuntu 24.04 box for Life (docs/use/server.md), as root, from a checkout at /opt/life:
# Docker, Tailscale (SSH on the tailnet), a firewall that takes nothing from outside the tailnet, the data and
# secrets folders, Life's address (LIFE_ORIGIN, else asked), then the first `up` once every env file is filled in, and
# the code that opens Life's setup page. Safe to run again.
set -euo pipefail
REPO=$(cd "$(dirname "$0")/.." && pwd)
ETC=/etc/life
DATA=/srv/life

if ! command -v docker >/dev/null; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    >/etc/apt/sources.list.d/docker.list
  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi

if ! command -v tailscale >/dev/null; then
  curl -fsSL https://tailscale.com/install.sh | sh
fi
# Prints a sign-in link the first time (or takes TS_AUTHKEY); the box then answers SSH on the tailnet.
tailscale status >/dev/null 2>&1 || tailscale up --ssh --hostname "${TS_HOSTNAME:-life}" ${TS_AUTHKEY:+--authkey "$TS_AUTHKEY"}

# Nothing from outside the tailnet: cloudflared only dials out. Docker publishes no port (compose.yaml).
ufw default deny incoming
ufw default allow outgoing
ufw allow in on tailscale0
ufw allow 41641/udp
ufw --force enable

# The data (the containers run as uid 1000, `bun`) and the secrets, 0600, outside the repo: what the services
# share and the voice server's and the tunnel's own in /etc/life, Life's keys in its state folder, where `bun life headless` reads them.
install -d -m 0700 -o 1000 -g 1000 "$DATA/life" "$DATA/life/state" "$DATA/voice"
install -d -m 0700 "$ETC"
for name in shared identity voice tunnel; do
  [ -e "$ETC/$name.env" ] || install -m 0600 "$REPO/deploy/env/$name.env.example" "$ETC/$name.env"
done
LIFE_KEYS="$DATA/life/state/secrets.env"
[ -e "$LIFE_KEYS" ] || install -m 0600 -o 1000 -g 1000 "$REPO/deploy/env/life.env.example" "$LIFE_KEYS"

missing=$(grep -lE '^[A-Z_]+=$' "$ETC"/*.env "$LIFE_KEYS" || true)
if [ -n "$missing" ]; then
  echo "Fill in these files, then run this again: $missing"
  exit 1
fi
COMPOSE=(docker compose -f "$REPO/deploy/compose.yaml")
"${COMPOSE[@]}" build
if [ ! -e "$DATA/life/state/settings.json" ]; then
  [ -n "${LIFE_ORIGIN:-}" ] || read -rp "Life's address (https://life.example.com): " LIFE_ORIGIN
  "${COMPOSE[@]}" run --rm --no-deps life bun apps/server/src/host/cli.ts settings set \
    "{\"connector\":{\"origin\":\"$LIFE_ORIGIN\",\"tunnel\":\"cloudflare\"}}" >/dev/null
fi
"${COMPOSE[@]}" up -d
"${COMPOSE[@]}" exec -T life bun apps/server/src/host/cli.ts pair
