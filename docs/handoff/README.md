# Life rework: master handoff (21 Nov 2026)

**27 Nov: [2026-11-27-app-parity.md](2026-11-27-app-parity.md)** (the app matches the prototype: goal, board, what landed, where it stopped, how to continue) and [2026-11-27-turn-by-turn.md](2026-11-27-turn-by-turn.md).

**Newest first: [next-session-2026-11-21.md](next-session-2026-11-21.md)** (21 Nov afternoon: what landed, the new workflow, the queue, the 7 agents).

Work stopped on 21 Nov 2026 at the owner's word ("gonna stop the work we do here to pick it up later"). Every session pushed
its work and stopped. Start here, then read the three role handoffs:

- [fixer.md](fixer.md): the server, the desk and Voice (the "Life App Fixer" session).
- [builder.md](builder.md): the phone app and its server reads (the "Life App Builder" session), and the landing tools.
- The Designer's handoff (the canvas, v156, the frames and what is drawn but not built) is in his data repo, not here:
  `~/Life/docs/product/app-design/handoff-designer.md` (committed in `~/Life`, which has no remote by design).

## How the work was run

- **Four sessions.** Direction (this one) held the goal and his decisions and wrote no code. The Fixer took the server, the
  desk and Voice; the Builder took the phone; the Designer drew frames before the Builder built them. Each builder ran up
  to 3 helper agents and landed its own PRs after a passing debt verdict (`work-on-code`).
- **The Mac is the CI.** Life has no GitHub Actions; `bun run check` gates every push and merge. Heavy jobs (checks, app
  builds, Swift) went through the Builder's `heavy.sh`: one queued slot, lanes `land`, `light`, `release`. Several reviewed
  PRs landed together as a "land train" (`land-train.sh`). The scripts are in [`tools/`](../../tools/), listed in [builder-tools.md](builder-tools.md).
- **Swaps.** After a server, desk or Voice batch merged, the session that landed it rebuilt Life.app from main and swapped
  it with rollback. Lifelog Host needs a separate swap when Voice's server changes. Both scripts are at the end of this file.
- **Phone installs** only on his yes, once per batch.

## Where the product stands

Live in Life.app on 21 Nov: the agents on matters (desk, hand-out, fold, Personal agent, caretaker), cards with needs
and "Mark as done", the send guard, the arrival reader, appointments in his calendar, the hand-off of a matter or an
agent between Claude Code and Codex (#915), and the fix for the beads promise left open (#906). Each role file lists
what is merged, open or queued.

In flight when work stopped (details in the role files):

- **"Your move" cards** (#926): every matter step of his stays in his inbox, dormant ones too. On 21 Nov data that is 231
  cards. His answer: all 55 with a deadline count in the badge. It reuses the decision card (needs, Mark as done, Start),
  and adds a `place` need (Maps and Bolt links) and "Not now".
  Its phone half is #931.
- **Phone PRs**: the Spending page (#924, ready to land), the Projects tab (#930, verdict to run).
- Two trial PRs, not to merge before their trials pass: #516, #517.
- Unpushed work that fails the check is saved as bundles in `~/Work/life-wip/` (`arrival-pass`, `github-prs`), see
  [fixer.md](fixer.md).

Fixed on 21 Nov: the desk no longer runs a second copy of a Claude session he has open in the app (#911); the wake waits.

At the stop, Life.app ran main at 2af401d3 and Lifelog Host ran 5f774947 (Voice's 19 migrations).

## His order for what remains (20 and 21 Nov)

1. Finish both queues (the role files).
2. **Tap-feedback audit:** every phone action that calls the server shows what is happening, goes green when fine, waits
   a little, then moves on; never "press and forget". Include an agent attaching a call transcript to a draft. Send the
   fixes to whoever fits.
3. **Final design-fidelity review** against the frames, one proper pass with a high score, then the transitions.
4. **Tell Life**, last of all: an always-there button talking to one Life main session. His decisions so far are
   in `~/Life/docs/memory-rework/life-main-session-study-2026-11-21.md` and
   `~/Life/docs/product/app-design/tell-life-2026-11-21.md` (canvas v134 to v142). The first slice is read only: button,
   live words, a warm session, the answer streamed, first word in under 2 s.
5. Email him a summary when all of it is done.

After "Agents PR 3" merged: hand the matter "Get the V2 version of the Life app finished" (to-do `reminder:3893`) to the
Personal agent and send him one test card from it. Parked: agent gating (life#784), fresh-wake rules (life#785), the
notification center, the "Last night" page.

## His decisions still open

- Should Life enforce "reach this person only through one channel" (asked after the MADworks agents drafted a WhatsApp
  to someone he talks to only through hub issues)? For now that rule is in the MADworks agents' own instructions.
- A reply of 6 Nov that Life missed (Direction's transcript of 21 Nov names the chat): should the Fixer find why?
- The four credential-vault decisions, the three Instinct decisions, and semantic waits (asked earlier; the role files
  say which session holds each).

## Rules that held

- Nothing outward or public without his yes on the exact content; no phone install, no spend, no code off the Mac
  ("Keep Mac": no remote checks) without his yes. Never archive a session without his yes.
- Never `--no-verify`. Only he writes `truth/`. Never hand-edit `memory/`. No person's name in code.
- Run `gh` with `unset GITHUB_TOKEN GH_TOKEN` (the environment token is stale; gh's own login works).
- Every `codex exec` passes `-c allow_login_shell=false -c 'shell_environment_policy.inherit="core"'`.
- Batch everything: pushes, verdicts, landings, swaps, installs, messages.

## How to resume

1. Read the three role files and run `gh pr list --state open`.
2. Restart one builder per area (server, phone), each from its role file's "How to resume", with the 3-helper cap and
   `heavy.sh`.
3. Land "your move" (#926, then the phone's #931) and #924 first, swap Life.app, ask him about a phone install, then go
   on with the order above.

## Swap scripts

Copy to a scratch folder, set `S` to it and `HEAVY` to wherever `heavy.sh` lives, and run with `zsh`. The signing
identity is the Developer ID in his keychain (`security find-identity -v -p codesigning`).

`build-and-swap.sh` (Life.app from main; waits until no agent turn is open):

```sh
#!/bin/zsh
cd ~/Work/life && git pull -q --ff-only origin main || { echo PULL_FAILED; exit 1; }
bun install >/dev/null 2>&1 || { echo INSTALL_FAILED; exit 1; }
rm -rf $S/life-build && mkdir -p $S/life-build
HEAVY_LANE=release LIFE_SIGN_IDENTITY=<identity> $HEAVY bun scripts/app.ts $S/life-build > $S/build.log 2>&1
codesign --verify --deep --strict $S/life-build/Life.app || { echo BUILD_BAD; exit 1; }
D="$HOME/Library/Application Support/Life/state/desk/desk.sqlite"
for i in {1..90}; do n=$(sqlite3 "$D" "select count(*) from turn where ended_at is null"); [ "$n" = "0" ] && break; sleep 10; done
zsh $S/swap-life.sh $S/life-build/Life.app 2>&1 | tail -1
```

`swap-life.sh` (keeps the previous app; rolls back if the helpers don't start or crash-loop in 90 s):

```sh
#!/bin/zsh
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
```

`host-build-and-swap.sh` (Lifelog Host.app, whose `Contents/Helpers/lifelog-server` is Voice's server; health on
`127.0.0.1:47613/health`; rolls back if Voice's migrations count falls):

```sh
#!/bin/zsh
APP="/Applications/Lifelog Host.app"; OLD="/Applications/Lifelog Host-previous.app"
DB="$HOME/Library/Application Support/lifelog/archive.sqlite"
migs() { sqlite3 -readonly "$DB" "select count(*) from __drizzle_migrations" 2>/dev/null || echo 0; }
health() { [ "$(curl -s -m 10 -o /dev/null -w %{http_code} http://127.0.0.1:47613/health)" = 200 ]; }
cd ~/Work/life && git pull -q --ff-only origin main || { echo PULL_FAILED; exit 1; }
bun install >/dev/null 2>&1 || { echo INSTALL_FAILED; exit 1; }
rm -rf $S/host-build && mkdir -p $S/host-build
HEAVY_LANE=release $HEAVY bun run host:app $S/host-build >$S/host-build.log 2>&1 || { echo BUILD_FAILED; exit 1; }
NEW="$S/host-build/Lifelog Host.app"
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
```
