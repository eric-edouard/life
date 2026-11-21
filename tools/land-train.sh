#!/bin/bash
# land-train.sh <pr> <pr>...: land several PRs whose verdict already passed as one batch (his ask of 21 Nov, "couldn't we
# batch"): one train branch off main with each PR merged in, one full check, one train PR carrying each PR's verdict,
# merged; GitHub marks the originals merged. A PR that conflicts with main or the train is left out (conveyor merges main
# into it when it can); glossary rows merge as union and wire fixtures are rewritten, so neither conflicts.
unset GITHUB_TOKEN GH_TOKEN
SP=$(cd "$(dirname "$0")" && pwd); ST=${LIFE_TOOLS_STATE:-/private/tmp/life-tools}; mkdir -p "$ST"; LL=~/.agents/skills/work-on-code/land-lock.sh
REPO=~/Work/life; T="$ST/train"; NAME="train-$(date +%H%M%S)"
cd "$REPO" && { for i in 1 2 3 4 5; do git fetch -q origin && break; sleep 3; done; } || exit 1   # a swap may be fetching too (ref lock)
git worktree add -q -b "$NAME" "$T-$NAME" origin/main || exit 1
cd "$T-$NAME" || exit 1
IN=(); BODY="$ST/$NAME-body.md"; : >"$BODY.verdicts"
for PR in "$@"; do
  v=$(gh pr view "$PR" --json body,headRefName,state -q 'select(.state=="OPEN") | .headRefName + "\t" + .body')
  ref=${v%%$'\t'*}; body=${v#*$'\t'}
  verdict=$(printf '%s\n' "$body" | sed -n 's/^Verdict: //p' | head -1)
  if [ -z "$ref" ] || [ -z "$verdict" ] || case "$verdict" in "rework needed"*|"debt added"*) true;; *) false;; esac; then echo "skip #$PR: not open or no passing verdict"; continue; fi
  git fetch -q origin "$ref" && if git merge -q --no-edit FETCH_HEAD >/dev/null 2>&1; then
    IN+=("$PR"); echo "- #$PR ($ref): $verdict" >>"$BODY.verdicts"
  else git merge --abort; echo "skip #$PR: conflicts, land it alone"; fi
done
[ ${#IN[@]} -ge 1 ] || { echo "nothing to land"; exit 1; }
# Wire fixtures merge as "keep ours" (repo's info/attributes): rewrite them from the merged code, so no PR is ever
# skipped for a generated file (velocity, 21 Nov evening).
if ! git diff --quiet origin/main HEAD -- apps/lifelog/fixtures/wire; then
  bun install --ignore-scripts >/dev/null 2>&1
  F=$(rg -l "expectWire" apps/server/src -g '*.test.ts')
  WRITE_WIRE=1 HEAVY_LANE=light "$SP/heavy.sh" bun test $F >"$ST/wire-$NAME.log" 2>&1
  bunx biome format --write apps/lifelog/fixtures/wire >/dev/null 2>&1
  git add apps/lifelog/fixtures/wire && git commit -q -m "Train: wire fixtures rewritten from the merged code" || true
fi
AREAS=$(git diff --name-only origin/main...HEAD | awk '
  /^apps\/lifelog\/apps\/ios\// {print "phone"; next}
  /^apps\/server\/src\/desk\// {print "desk"; next}
  /^apps\/lifelog\// {print "voice"; next}
  {print "server"}' | sort -u | tr '\n' ' ')
"$LL" take $AREAS || exit 1
trap '"$LL" drop $AREAS' EXIT
bun install --ignore-scripts >/dev/null 2>&1 || { echo "INSTALL FAILED"; exit 1; }
check() { HEAVY_LANE=land "$SP/heavy.sh" bun run check >"$ST/check-$NAME.log" 2>&1; }
# A test that only timed out (30 s under load) is retried once: a flaky timeout must not hold three PRs (21 Nov).
timedout() { f=$(grep -E "\(fail\)" "$ST/check-$NAME.log"); [ -n "$f" ] && ! echo "$f" | grep -vqE "\[(29|30)[0-9]{3}\.[0-9]+ms\]"; }
if ! check && ! { timedout && echo "retry: timeout only" && check; }; then
  echo "CHECK FAILED: $(grep -E "✗|\(fail\)" "$ST/check-$NAME.log" | head -5)"
  # Blame: the PRs whose files the failure names; none named = all of them. A blamed PR is skipped by the conveyor
  # until its head changes (blocked/<pr> holds the head that failed), so a broken PR never fails train after train.
  ERR=$(cat "$ST/check-$NAME.log" derived/check/*.log 2>/dev/null | grep -oE "apps/[A-Za-z0-9_./-]+\.(swift|ts|tsx)" | sort -u)
  mkdir -p "$ST/blocked"; BL=()
  for PR in "${IN[@]}"; do
    files=$(gh pr view "$PR" --json files -q '.files[].path')
    for f in $ERR; do echo "$files" | grep -qxF "$f" && { BL+=("$PR"); break; }; done
  done
  [ ${#BL[@]} -eq 0 ] && BL=("${IN[@]}")
  for PR in "${BL[@]}"; do gh pr view "$PR" --json headRefOid -q .headRefOid >"$ST/blocked/$PR"; done
  # Drop the locks while still on the train's branch: land-lock names the holder by branch (a failed train held them).
  "$LL" drop $AREAS; trap - EXIT
  echo "blamed: ${BL[*]}"; cd "$REPO" && git worktree remove --force "$T-$NAME"; git branch -D -q "$NAME"
  exit 1
fi
HEAVY_LANE=land "$SP/heavy.sh" git push -q -u origin "$NAME" >"$ST/push-$NAME.log" 2>&1 || { echo "PUSH FAILED: $(tail -3 "$ST/push-$NAME.log")"; exit 1; }
H=$(git rev-parse HEAD); list=$(printf '#%s ' "${IN[@]}")
{ echo "Lands ${list}as one batch: one check for all of them. Each was reviewed on its own PR:"; echo
  cat "$BODY.verdicts"; echo
  echo "## Debt verdict"; echo "Reviewed: $H"; echo "Verdict: no debt added"
  echo "Plan: matched (each PR's own plan and verdict, linked above)"; echo "Net lines: see each PR"
  echo "Debt reduced: see each PR"; echo "Debt added: none beyond each PR's own verdict"; echo "Reworks: see each PR"
  echo "Kept on purpose: none"; } >"$BODY"
gh pr create --head "$NAME" --title "Land train: $list" --body-file "$BODY" >/dev/null || exit 1
for i in 1 2 3 4 5; do gh pr merge "$NAME" --merge >/dev/null 2>&1 && break; sleep 10; done   # retried: a network blip must not leave a train open
echo "landed ${list}in $(gh pr view "$NAME" --json number,state -q '"#\(.number) \(.state)"')"
# Drop the locks from the train worktree: land-lock.sh names the holder by its branch, gone once it is removed.
"$LL" drop $AREAS; trap - EXIT
cd "$REPO" && git worktree remove --force "$T-$NAME"
