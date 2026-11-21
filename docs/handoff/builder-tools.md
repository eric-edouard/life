# Builder tools

The scripts the phone builder relied on, as they stood on 21 Nov 2026. To restore one, copy its block to a file in a scratchpad, replace `$TOOLS` with that scratchpad's path, and `chmod +x` it.

## heavy.sh

```bash
#!/bin/bash
# heavy.sh <cmd...>: run a heavy local job (check, tests, tsc, xcodebuild, simulator), Mac-wide, one at a time.
# First come, first served: a job takes a slot only when no older job is still waiting.
# It starts under 1-minute load 60. One slot plus the land, light and release lanes: his cap of 21 Nov (a saturated Mac
# times tests out and reruns them).
# HEAVY_LANE=land: the landing push of the branch holding the landing lock; its own lane, no load wait, one at a time.
# HEAVY_LANE=light: a job under a minute (one test file, one tsc): its own lane, no load wait, one at a time.
# The locks are shared by every session's builders.
D=$TOOLS
Q="$D/queue"; mkdir -p "$Q"
# Swift and Xcode compile on every core, so they are never light, even with a test filter.
case "${HEAVY_LANE:-} $*" in "light swift "*|light*"swift test"*|light*"swift build"*|light*xcodebuild*) HEAVY_LANE="" ;; esac
L=""
if [ -n "${HEAVY_LANE:-}" ]; then
  until mkdir "$D/check.lock.${HEAVY_LANE}" 2>/dev/null; do sleep 5; done
  L="$D/check.lock.${HEAVY_LANE}"
else
  me="$Q/$(date +%s).$$"; : >"$me"
  trap 'rm -f "$me"' EXIT
  until [ -n "$L" ]; do
    first=""
    for f in $(ls "$Q" | sort -n); do
      kill -0 "${f##*.}" 2>/dev/null && { first="$Q/$f"; break; } || rm -f "$Q/$f"
    done
    if [ "$first" = "$me" ]; then
      load=$(sysctl -n vm.loadavg | awk '{print int($2)}')
      [ "$load" -lt 60 ] && mkdir "$D/check.lock" 2>/dev/null && L="$D/check.lock"
    fi
    [ -n "$L" ] || sleep 10
  done
  rm -f "$me"
fi
trap 'rmdir "$L"' EXIT
# Xcode's compile cache is keyed by content, so it is shared safely (his "do build cache now", 21 Nov). Never a shared
# .build folder: a reused test build reads another worktree's files through #filePath. HEAVY_NO_CACHE=1 skips it.
[ -n "${HEAVY_NO_CACHE:-}" ] || export XCODE_XCCONFIG_FILE="$D/compile-cache.xcconfig"
# Swift builds run once per branch, on its landing push (his yes of 21 Nov); every other push skips them.
[ "${HEAVY_LANE:-}" = land ] || export LIFE_CHECK_SWIFT=at-landing
"$@"
```

## land.sh

```bash
#!/bin/bash
# land.sh <worktree> <pr> <verdict file>: work-on-code step 6. Take the landing lock, merge main once, run the full
# check (Swift included) in the land lane, push, write the verdict ("Reviewed:" = the pushed head), merge, drop the lock.
unset GITHUB_TOKEN GH_TOKEN  # a shell from before the key rotation holds the old one; gh's own login works
WT="$1"; PR="$2"; V="$3"; SP=$(dirname "$0"); LL=~/.agents/skills/work-on-code/land-lock.sh
cd "$WT" || exit 1
git fetch -q
# The landing lock's areas (work-on-code): phone, desk, server, voice, by the files the PR changes.
AREAS=$(git diff --name-only origin/main...HEAD | awk '
  /^apps\/lifelog\/apps\/ios\// {print "phone"; next}
  /^apps\/server\/src\/desk\// {print "desk"; next}
  /^apps\/lifelog\// {print "voice"; next}
  {print "server"}' | sort -u | tr '\n' ' ')
"$LL" take $AREAS || exit 1
trap '"$LL" drop $AREAS' EXIT
echo "areas: $AREAS"
if ! git merge-base --is-ancestor origin/main HEAD; then
  git merge --no-edit origin/main >/dev/null 2>&1 || { echo "CONFLICT merging main"; git merge --abort; exit 1; }
fi
bun install --ignore-scripts >/dev/null 2>&1 || { echo "INSTALL FAILED"; exit 1; }  # main may bring a new dependency
# The full check, Swift included, always runs here: pushes outside the land lane skip Swift (LIFE_CHECK_SWIFT=at-landing),
# so a tree they recorded as passed has never built. Run before the push, whose hook then finds this tree passed.
HEAVY_LANE=land "$SP/heavy.sh" bun run check > "$SP/check-$PR.log" 2>&1 || { echo "CHECK FAILED: $(grep -E "error|fail|✗" "$SP/check-$PR.log" | grep -v " 0 fail" | head -5)"; exit 1; }
if [ "$(git rev-parse HEAD)" != "$(git ls-remote origin "$(git branch --show-current)" | cut -f1)" ]; then
  HEAVY_LANE=land "$SP/heavy.sh" git push > "$SP/push-$PR.log" 2>&1 || { echo "PUSH FAILED (gate): $(grep -E "error|fail|✗" "$SP/push-$PR.log" | grep -v " 0 fail" | head -5)"; exit 1; }
fi
H=$(git rev-parse HEAD)
B="$SP/pr$PR-body.md"
gh pr view "$PR" --json body -q .body | sed '/^## Debt verdict/,$d' > "$B"
sed "s/^Reviewed: .*/Reviewed: $H/" "$V" >> "$B"
gh pr edit "$PR" --body-file "$B" >/dev/null || exit 1
gh pr merge "$PR" --merge 2>&1 | tail -1
echo "state $(gh pr view "$PR" --json state -q .state) head $H"
```

## land-train.sh

```bash
#!/bin/bash
# land-train.sh <pr> <pr>...: land several PRs whose verdict already passed as one batch (his ask of 21 Nov, "couldn't we
# batch"): one train branch off main with each PR merged in, one full check, one train PR carrying each PR's verdict,
# merged; GitHub marks the originals merged. A PR that conflicts with main or the train is left out, to land alone.
unset GITHUB_TOKEN GH_TOKEN
SP=$(dirname "$0"); LL=~/.agents/skills/work-on-code/land-lock.sh
REPO=~/Work/life; T="$SP/train"; NAME="train-$(date +%H%M%S)"
cd "$REPO" && git fetch -q origin || exit 1
git worktree add -q -b "$NAME" "$T-$NAME" origin/main || exit 1
cd "$T-$NAME" || exit 1
IN=(); BODY="$SP/$NAME-body.md"; : >"$BODY.verdicts"
for PR in "$@"; do
  v=$(gh pr view "$PR" --json body,headRefName,state -q 'select(.state=="OPEN") | .headRefName + "\t" + .body')
  ref=${v%%$'\t'*}; body=${v#*$'\t'}
  verdict=$(printf '%s\n' "$body" | sed -n 's/^Verdict: //p' | head -1)
  if [ -z "$ref" ] || [ -z "$verdict" ] || [ "$verdict" = "rework needed" ]; then echo "skip #$PR: not open or no passing verdict"; continue; fi
  git fetch -q origin "$ref" && if git merge -q --no-edit FETCH_HEAD >/dev/null 2>&1; then
    IN+=("$PR"); echo "- #$PR ($ref): $verdict" >>"$BODY.verdicts"
  else git merge --abort; echo "skip #$PR: conflicts, land it alone"; fi
done
[ ${#IN[@]} -ge 1 ] || { echo "nothing to land"; exit 1; }
AREAS=$(git diff --name-only origin/main...HEAD | awk '
  /^apps\/lifelog\/apps\/ios\// {print "phone"; next}
  /^apps\/server\/src\/desk\// {print "desk"; next}
  /^apps\/lifelog\// {print "voice"; next}
  {print "server"}' | sort -u | tr '\n' ' ')
"$LL" take $AREAS || exit 1
trap '"$LL" drop $AREAS' EXIT
bun install --ignore-scripts >/dev/null 2>&1 || { echo "INSTALL FAILED"; exit 1; }
HEAVY_LANE=land "$SP/heavy.sh" bun run check >"$SP/check-$NAME.log" 2>&1 || { echo "CHECK FAILED: $(grep -E "✗|\(fail\)" "$SP/check-$NAME.log" | head -5)"; exit 1; }
HEAVY_LANE=land "$SP/heavy.sh" git push -q -u origin "$NAME" >"$SP/push-$NAME.log" 2>&1 || { echo "PUSH FAILED: $(tail -3 "$SP/push-$NAME.log")"; exit 1; }
H=$(git rev-parse HEAD); list=$(printf '#%s ' "${IN[@]}")
{ echo "Lands ${list}as one batch: one check for all of them. Each was reviewed on its own PR:"; echo
  cat "$BODY.verdicts"; echo
  echo "## Debt verdict"; echo "Reviewed: $H"; echo "Verdict: no debt added"
  echo "Plan: matched (each PR's own plan and verdict, linked above)"; echo "Net lines: see each PR"
  echo "Debt reduced: see each PR"; echo "Debt added: none beyond each PR's own verdict"; echo "Reworks: see each PR"
  echo "Kept on purpose: none"; } >"$BODY"
gh pr create --head "$NAME" --title "Land train: $list" --body-file "$BODY" >/dev/null || exit 1
gh pr merge "$NAME" --merge 2>&1 | tail -1
echo "landed ${list}in $(gh pr view "$NAME" --json number,state -q '"#\(.number) \(.state)"')"
# Drop the locks from the train worktree: land-lock.sh names the holder by its branch, gone once it is removed.
"$LL" drop $AREAS; trap - EXIT
cd "$REPO" && git worktree remove --force "$T-$NAME"
```

## codex-clean.sh

```bash
#!/bin/bash
# Codex with none of his secrets: no login shell (which sources ~/.zshrc), only the core environment for its tools.
# The safety flags go last among the options (the work-on-code gate checks the last -c values); the prompt stays last.
# usage: codex-clean.sh exec <options…> "<prompt>"
sub="$1"; shift
prompt="${@: -1}"; set -- "${@:1:$#-1}"
exec codex "$sub" "$@" -c allow_login_shell=false -c 'shell_environment_policy.inherit="core"' "$prompt"
```

## codex-verdict.sh

```bash
#!/bin/bash
# Debt verdict on Codex: codex-verdict.sh <worktree> <base ref> <out.md> <mode confirm|full> <tier> <extra context>
unset GITHUB_TOKEN GH_TOKEN  # a shell from before the key rotation holds the old one; gh's own login works
set -uo pipefail
WT="$1"; BASE="$2"; OUT="$3"; MODE="$4"; TIER="$5"; EXTRA="$6"
HEAD=$(git -C "$WT" rev-parse HEAD)
PROMPT="Read ~/.agents/skills/work-on-code/verdict-review.md and follow it in $MODE mode, $TIER tier. Repo worktree: $WT (you are in it). The change is \`git diff $BASE...$HEAD\` (head $HEAD); the PR body, with its Debt plan section, is the file named below. Read-only: never edit, commit, push or comment. $EXTRA"
"$(dirname "$0")/codex-clean.sh" exec -m gpt-6.2-astra -c model_reasoning_effort=high -s read-only --skip-git-repo-check -C "$WT" -o "$OUT" "$PROMPT" </dev/null > "$OUT.log" 2>&1
echo "exit $? head $HEAD -> $OUT"
```

## build-and-swap.sh

```bash
#!/bin/zsh
# Build Life.app from main, verify, wait until no agent turn is open, swap with rollback.
S=$TOOLS
cd ~/Work/life && git pull -q --ff-only origin main || { echo PULL_FAILED; exit 1; }
bun install >/dev/null 2>&1 || { echo INSTALL_FAILED; exit 1; }
rm -rf $S/life-build && mkdir -p $S/life-build
HEAVY_LANE=release LIFE_SIGN_IDENTITY=$LIFE_SIGN_IDENTITY $TOOLS/heavy.sh bun scripts/app.ts $S/life-build > $S/build.log 2>&1
codesign --verify --deep --strict $S/life-build/Life.app || { echo BUILD_BAD; exit 1; }
D="$HOME/Library/Application Support/Life/state/desk/desk.sqlite"
for i in {1..90}; do n=$(sqlite3 "$D" "select count(*) from turn where ended_at is null"); [ "$n" = "0" ] && break; sleep 10; done
echo "open turns: $n"
zsh $S/swap-life.sh $S/life-build/Life.app 2>&1 | tail -1
sleep 20; pgrep -fl "Life.app/Contents/Helpers/life" | awk '{print $1,$3}'
git log --oneline -1
```

## swap-life.sh

```bash
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
```

## compile-cache.xcconfig

```text
// heavy.sh: content-addressed compile cache, independent of the worktree's path (Xcode 26+).
COMPILATION_CACHE_ENABLE_CACHING = YES
SWIFT_ENABLE_PREFIX_MAPPING = YES
CLANG_ENABLE_PREFIX_MAPPING = YES
```
