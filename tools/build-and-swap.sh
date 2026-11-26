#!/bin/zsh
# Build Life.app from main, verify, wait until no agent turn is open, swap with rollback.
: ${LIFE_SIGN_IDENTITY:=8FAFA5E5A85BE2903317DB3CB253478D856C37EE}
SP=$(cd "$(dirname "$0")" && pwd); S=${LIFE_TOOLS_STATE:-/private/tmp/life-tools}; mkdir -p "$S"
cd ~/Work/life && for i in 1 2 3 4 5; do git pull -q --ff-only origin main && break; sleep 15; done || { echo PULL_FAILED; exit 1; }
bun install >/dev/null 2>&1 || { echo INSTALL_FAILED; exit 1; }
rm -rf $S/life-build && mkdir -p $S/life-build
HEAVY_LANE=release LIFE_SIGN_IDENTITY=$LIFE_SIGN_IDENTITY $SP/heavy.sh bun scripts/app.ts $S/life-build > $S/build.log 2>&1
codesign --verify --deep --strict $S/life-build/Life.app || { echo BUILD_BAD; exit 1; }
D="$HOME/Library/Application Support/Life/state/desk/desk.sqlite"
# Wait (2 min at most) only for turns really running: begun, not ended, of an active agent, started within the hour.
# An older open turn is a leftover of a killed run; the desk closes it at its start.
Q="select count(*) from turn t join agent a on a.id=t.agent_id where t.ended_at is null and t.begun_at is not null and a.status='active' and t.started_at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 hour')"
for i in {1..12}; do n=$(sqlite3 "$D" "$Q"); [ "$n" = "0" ] && break; sleep 10; done
[ "$n" = "0" ] || echo "swapping anyway after 2 min: $n turn(s) still running"
echo "open turns: $n"
zsh $SP/swap-life.sh $S/life-build/Life.app 2>&1 | tail -1
sleep 20; pgrep -fl "Life.app/Contents/Helpers/life" | awk '{print $1,$3}'
git log --oneline -1
