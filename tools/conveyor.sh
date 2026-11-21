#!/bin/bash
# conveyor.sh: one pass of the landing conveyor (velocity, 21 Nov evening). Every PR with a passing verdict lands with no
# one asking: server-only PRs in one train, then phone PRs in one train (one app build), then the swaps. A PR that
# conflicts with main gets main merged in automatically when that merge is clean, and rides the next pass.
# Run in a loop: `while :; do conveyor.sh; sleep 120; done`. One pass at a time (conveyor.lock).
unset GITHUB_TOKEN GH_TOKEN
SP=$(cd "$(dirname "$0")" && pwd); ST=${LIFE_TOOLS_STATE:-/private/tmp/life-tools}; mkdir -p "$ST"; REPO=~/Work/life; LOG="$ST/conveyor.log"
mkdir "$ST/conveyor.lock" 2>/dev/null || exit 0
trap 'rmdir "$ST/conveyor.lock"' EXIT
pgrep -f "land-train.sh|land.sh " >/dev/null && exit 0   # a landing is under way; its PRs are still open
say() { echo "$(date +%H:%M:%S) $*" | tee -a "$LOG"; }
cd "$REPO" && git fetch -q origin

# Ready: open, not a draft, not a trial, a passing verdict in the body.
gh pr list --state open --json number,title,isDraft,mergeable,headRefName,headRefOid,body,files --limit 50 >"$ST/conveyor-prs.json" || exit 1
jq -r '.[] | select(.isDraft|not) | select(.title|test("^(Trial|Land train)";"i")|not)
  | (.body|[split("\n")[]|select(startswith("Verdict: "))][0] // "") as $v
  | select($v != "" and ($v|test("^Verdict: (rework needed|debt added)")|not))
  | [.number, .mergeable, .headRefName,
     (if any(.files[].path; startswith("apps/lifelog/apps/ios/")) then "phone" else "server" end),
     (if any(.files[].path; startswith("apps/lifelog/")) then "voice" else "-" end)] | @tsv' \
  "$ST/conveyor-prs.json" >"$ST/conveyor-ready.tsv"

SERVER=(); PHONE=(); VOICE=0
while IFS=$'\t' read -r n m ref kind voice; do
  [ -z "$n" ] && continue
  # A PR blamed for a failed train waits until its head changes.
  [ -f "$ST/blocked/$n" ] && [ "$(cat "$ST/blocked/$n")" = "$(jq -r --argjson n "$n" '.[]|select(.number==$n)|.headRefOid' "$ST/conveyor-prs.json")" ] && continue
  if [ "$m" = CONFLICTING ]; then
    # Merge main into the PR branch when that merge is clean (glossary as union, wire fixtures kept; the train rewrites them).
    W="$ST/remerge-$n"; [ -d "$W" ] && continue   # a remerge of this PR is still pushing
    if git worktree add -q --detach "$W" "origin/$ref" 2>/dev/null && (cd "$W" && git merge -q --no-edit origin/main >/dev/null 2>&1); then
      # The push runs the full check: in the background, never in front of the trains.
      ( (cd "$W" && bun install --ignore-scripts >/dev/null 2>&1 && "$SP/heavy.sh" git push -q origin "HEAD:$ref" >"$ST/remerge-$n.log" 2>&1) \
          && say "#$n: merged main in, pushed; lands next pass" || say "#$n: merged main in, push failed (remerge-$n.log)"
        git worktree remove --force "$W" 2>/dev/null ) </dev/null >/dev/null 2>&1 &
    else
      (cd "$W" 2>/dev/null && git merge --abort 2>/dev/null); say "#$n: real conflict with main, needs its helper"
      git worktree remove --force "$W" 2>/dev/null
    fi
    continue
  fi
  [ "$m" = MERGEABLE ] || continue
  if [ "$kind" = phone ]; then PHONE+=("$n"); else SERVER+=("$n"); [ "$voice" = voice ] && VOICE=1; fi
done <"$ST/conveyor-ready.tsv"

# One train for everything ready: one check instead of a server check and a phone check (velocity, 21 Nov).
ALL=("${SERVER[@]}" "${PHONE[@]}")
if [ ${#ALL[@]} -gt 0 ]; then
  say "train: ${ALL[*]}"; out=$("$SP/land-train.sh" "${ALL[@]}" 2>&1 | tail -4); say "$out"
  if [ ${#SERVER[@]} -gt 0 ] && echo "$out" | grep -q "MERGED"; then
    ( say "swap Life.app: $("$SP/build-and-swap.sh" 2>&1 | grep -E "SWAP|BAD|FAILED" | tail -1)"
      [ "$VOICE" = 1 ] && say "swap Lifelog Host: $("$SP/host-build-and-swap.sh" 2>&1 | tail -1)" ) </dev/null >/dev/null 2>&1 &
  fi
fi
# After any landing: remove the worktrees and branches of merged or closed PRs (his rule of 21 Nov).
grep -q "MERGED" <(tail -3 "$LOG") && S=~/.agents/skills/work-on-code/worktree-sweep.sh && [ -f "$S" ] && bash "$S" "$REPO" | while read -r l; do say "$l"; done
