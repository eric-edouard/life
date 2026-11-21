#!/bin/zsh
# Gated swap: keep the previous app, roll back if the helpers don't come up or crash-loop in the first 90 s.
NEW=$1
LOG="$HOME/Library/Application Support/Life/state/log/$(date -u +%Y-%m-%d).jsonl"
rollback() {
  echo "$1: rolling back"
  osascript -e 'quit app "Life"'; sleep 8; pkill -f "/Applications/Life.app/Contents/Helpers/life"
  rm -rf /Applications/Life.app && mv /Applications/Life-previous.app /Applications/Life.app && open /Applications/Life.app
  exit 1
}
osascript -e 'quit app "Life"'; sleep 8
pkill -f "/Applications/Life.app/Contents/Helpers/life" ; sleep 2
rm -rf /Applications/Life-previous.app && mv /Applications/Life.app /Applications/Life-previous.app
START=$(date -u +%Y-%m-%dT%H:%M:%S)
ditto "$NEW" /Applications/Life.app && open /Applications/Life.app
up=0
for i in {1..24}; do
  sleep 5; ok=0
  for h in archive watch desk; do pgrep -f "Life.app/Contents/Helpers/life $h" >/dev/null && ok=$((ok+1)); done
  [ $ok = 3 ] && { up=$((i*5)); break; }
done
[ $up = 0 ] && rollback "HELPERS DID NOT START"
sleep 90
crashes=$(grep -h '"step":"crash"' "$LOG" 2>/dev/null | python3 -c "import sys,json;s='$START';print(sum(1 for l in sys.stdin if json.loads(l)['at'][:19]>=s))")
[ "$crashes" -ge 3 ] && rollback "HELPERS CRASH-LOOP ($crashes crashes)"
echo "SWAP_OK after ${up}s, no crash loop in 90 s"
exit 0
