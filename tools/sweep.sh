#!/bin/bash
# sweep.sh: one screen of everything in flight, for the 5-minute velocity tick. Read only.
unset GITHUB_TOKEN GH_TOKEN
ST=${LIFE_TOOLS_STATE:-/private/tmp/life-tools}
echo "== machine: $(uptime | sed 's/.*load averages*: //')  free: $(df -h / | awk 'NR==2{print $4}')"
ps -Ao %cpu,etime,command -r | awk 'NR>1 && $1>150' | grep -vE "swift|xcodebuild|clang|bun|node|SWBBuild|swiftpm" | cut -c1-120 | sed 's/^/  hog? /' | head -3
echo "== heavy: locks $(ls -d "$ST"/check.lock* 2>/dev/null | xargs -n1 basename | tr '\n' ' ')"
ps -Ao pid,etime,command | grep "heavy.sh" | grep -v grep | awk '{$1=$1; print}' | sed -E 's#/[^ ]*/tools/##; s#^#  #' | cut -c1-140
echo "== conveyor (last 4)"; tail -4 "$ST/conveyor.log" | sed 's/^/  /'
pgrep -f "conveyor.sh" >/dev/null || echo "  !! conveyor loop not running"
echo "== open PRs"
cd ~/Work/life && gh pr list --state open --json number,title,mergeable,headRefOid,body,updatedAt --limit 40 |
  jq -r '.[] | [.number, .mergeable, ((.body|[split("\n")[]|select(startswith("Verdict: "))][0]) // "NO VERDICT"),
    .headRefOid, .updatedAt[11:16], .title[0:45]] | @tsv' |
  while IFS=$'\t' read -r n m v h u t; do
    b=""; [ -f "$ST/blocked/$n" ] && [ "$(cat "$ST/blocked/$n")" = "$h" ] && b=" HELD(failed train)"
    printf '  #%s %-11s %-22s upd %s%s  %s\n' "$n" "$m" "${v#Verdict: }" "$u" "$b" "$t"
  done
