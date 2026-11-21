#!/bin/bash
# Debt verdict on Claude (his word, 21 Nov evening: reviews on Claude, not Codex).
# claude-verdict.sh <worktree> <base ref> <out.md> <mode confirm|full|fast|plan> <tier> <extra context> [model]
# Model by the skill's rank: full → opus (hard: fable), confirm/fast → sonnet; override with arg 7.
unset GITHUB_TOKEN GH_TOKEN
WT="$1"; BASE="$2"; OUT="$3"; MODE="$4"; TIER="$5"; EXTRA="$6"
case "$MODE" in full) M=opus; [ "$TIER" = hard ] && M=fable ;; *) M=sonnet ;; esac
M="${7:-$M}"
HEAD=$(git -C "$WT" rev-parse HEAD)
FILE=verdict-review.md; [ "$MODE" = plan ] && FILE=plan-review.md
SECT=""; [ "$MODE" = fast ] && SECT="Fast mode: sections 2 and 3 only."
PROMPT="You are a fresh reviewer with no memory of this work. Never edit, commit, push or comment. Never run bun run check, bun test, tsc or any build: the Mac runs one heavy job at a time. Read ~/.agents/skills/work-on-code/$FILE and follow it in $MODE mode, $TIER tier. $SECT Repo worktree: $WT. The change is \`git diff $BASE...$HEAD\` (head $HEAD). $EXTRA"
cd "$WT" && claude -p --model "$M" --effort medium --permission-mode plan "$PROMPT" </dev/null > "$OUT" 2> "$OUT.log"
echo "exit $? model $M head $HEAD -> $OUT"
