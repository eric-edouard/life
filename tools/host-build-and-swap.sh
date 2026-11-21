#!/bin/zsh
SP=$(cd "$(dirname "$0")" && pwd); ST=${LIFE_TOOLS_STATE:-/private/tmp/life-tools}; mkdir -p "$ST"
APP="/Applications/Lifelog Host.app"; OLD="/Applications/Lifelog Host-previous.app"
DB="$HOME/Library/Application Support/lifelog/archive.sqlite"
migs() { sqlite3 -readonly "$DB" "select count(*) from __drizzle_migrations" 2>/dev/null || echo 0; }
health() { [ "$(curl -s -m 10 -o /dev/null -w %{http_code} http://127.0.0.1:47613/health)" = 200 ]; }
cd ~/Work/life && git pull -q --ff-only origin main || { echo PULL_FAILED; exit 1; }
bun install >/dev/null 2>&1 || { echo INSTALL_FAILED; exit 1; }
rm -rf $ST/host-build && mkdir -p $ST/host-build
HEAVY_LANE=release $SP/heavy.sh bun run host:app $ST/host-build >$ST/host-build.log 2>&1 || { echo BUILD_FAILED; exit 1; }
NEW="$ST/host-build/Lifelog Host.app"
codesign --verify --deep --strict "$NEW" || { echo BUILD_BAD; exit 1; }
for h in lifelog-server lifelog-quiet cloudflared; do [ -x "$NEW/Contents/Helpers/$h" ] || { echo "MISSING $h"; exit 1; }; done
before=$(migs)
rollback() {
  echo "$1: rolling back"
  osascript -e 'quit app "Lifelog Host"'; sleep 8; pkill -f "$APP/Contents/Helpers/"
  rm -rf "$APP" && mv "$OLD" "$APP" && open "$APP"; exit 1
}
osascript -e 'quit app "Lifelog Host"'; sleep 8; pkill -f "$APP/Contents/Helpers/"; sleep 2
rm -rf "$OLD" && mv "$APP" "$OLD"
ditto "$NEW" "$APP" && open "$APP"
up=0; for i in {1..24}; do sleep 5; health && { up=$((i*5)); break; }; done
[ $up = 0 ] && rollback "SERVER DID NOT ANSWER"
pid=$(pgrep -f "$APP/Contents/Helpers/lifelog-server"); restarts=0
for i in {1..18}; do
  sleep 5; p=$(pgrep -f "$APP/Contents/Helpers/lifelog-server")
  [ "$p" != "$pid" ] && { restarts=$((restarts+1)); pid=$p; }
done
[ $restarts -ge 2 ] && rollback "SERVER CRASH-LOOP ($restarts restarts)"
health || rollback "SERVER NOT HEALTHY AFTER 90 s"
after=$(migs); [ "$after" -lt "$before" ] && rollback "MIGRATIONS WENT BACK ($before -> $after)"
echo "HOST_SWAP_OK after ${up}s; migrations $before -> $after"
