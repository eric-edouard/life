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
for i in {1..90}; do n=$(sqlite3 "$D" "select count(*) from turn where ended_at is null"); [ "$n" = "0" ] && break; sleep 10; done
echo "open turns: $n"
zsh $SP/swap-life.sh $S/life-build/Life.app 2>&1 | tail -1
sleep 20; pgrep -fl "Life.app/Contents/Helpers/life" | awk '{print $1,$3}'
git log --oneline -1
