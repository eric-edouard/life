# Next session: handoff of 21 Nov 2026 (afternoon)

Start here, then [README.md](README.md) for how the work runs (roles, scripts, swaps). This session resumed the
21 Nov stop as the orchestrator: helpers built and reviewed PRs, the session landed them in trains and swapped
Life.app.

## Where things stand

- **Merged today:**
  - #926 "Your move" cards (server);
  - #924 Spending page (train #932);
  - #931 "Your move" on the phone (#937);
  - #935, a lost reminder while his app holds an agent's session, fixes #912 (#939);
  - #930 Projects tab (#941);
  - #933 spoken asks PR 1, the desk starts Personal itself (#942);
  - #936 moving a matter or an agent between Claude Code and Codex from the phone (#943);
  - #940, strict paths in AGENTS.md.
- **Open:** only the trials #516 and #517 (not to merge before their trials pass).
- **Running:**
  - Life.app is main at 87da7e79, with #933. #936 is phone only.
  - Lifelog Host is unchanged since 5f774947.
- **His phone runs an old build** (train #910). Main now has the Spending page, "Your move", the Projects tab,
  moving a matter, and the Live logs crash fix. **Ask him** before installing: `bun run install:phone -- --no-watch`
  from the live checkout, in the release lane, with his phone unlocked.
- **Reworks tracked:**
  - #925 (a matter opened from elsewhere is swapped out);
  - #927 (the Agents row's "not all reported" flag);
  - #934 (the simulator's fake project reads);
  - #938 (the phone repeats the desk's "move back" rule);
  - golden-rule#20 (four wording gaps in the new skill).

## The workflow changed (his yes, 21 Nov)

Fable's review: `~/Work/life-workflow-review-2026-11-21.md`. It is applied in golden-rule#19, agent-config#67 and
life#940, and the skill on the Mac is updated.

- **Only Blocking findings hold a merge:** data loss, a wrong or duplicate send, a lost or starved event, a privacy or
  security leak, a broken invariant, wrong stored data. Everything else goes into a `debt` issue.
- **No polling inside agents:** start the check, the review or the landing as one background command, then end the turn.
- **Land in trains** every 20–30 minutes. Main is merged once, in the train.
- **Plan review only for hard tier.**
- **Fast mode** applies only when he says "fast", never on the strict paths in AGENTS.md. Each fast PR opens one
  `debt` issue. At 15 open issues in an area, fast mode is refused there.
- **Lesson of this session:** helpers didn't build the app, so two trains failed on Swift (#930, #936). A phone PR's
  helper builds the app once before it reports "ready to land": the check's xcodegen + xcodebuild command, through
  `heavy.sh`.

## The queue, in his order

1. **The six backlog tools** (direction review, his pushback included: `~/Life/docs/product/direction-review-2026-11-21.md`).
   The 340 open items are months of backlog. Build what clears many at once:
   1. "Is this done?" in bulk: one list, pre-ticked, confirmed once (about 60 of 71).
   2. A sorting list for "your move", by project, person or age. Each row is Done, Hand to an agent or Drop, with
      select-many (all 224).
   3. Batch close of dead matters (drawn: StackClose, StackCloseSome, StackClosed, DuoFoldStackClose), inside the
      sorting list.
   4. Agents preparing more. First find why 14 of 55 agent cards were withdrawn and fix the top cause, then raise the
      hand-out's cards waiting from 5 to 10. Start this at once, beside 1 to 3.
   5. Guesses and names on one yes/no screen.
   6. **Voices in bulk.** The plan is `~/Life/docs/product/app-design/voices-in-bulk-2026-11-21.md`, with his answers:
      pre-tick likely guesses "Yes", and pre-tick every voice heard once "Don't name", with no 7-day wait.
      **Its first PR is a live bug:** two voice answers at the same moment make one fail. Voice answers must go one at a
      time on the server.
2. **Voice naming with context.** Fable's report: `~/Life/docs/memory-rework/voice-naming-with-context-2026-11-21.md`
   (committed in the data repo; read its sections 1 to 6 before building).
   - **Root cause:** the sound and the model are fine. The context never reaches the guessing step, and the guess never
     reaches the card. Five gaps, four of them "knows but doesn't use":
     - a chat's plan doesn't make someone a candidate (`possibleSpeakersOf`);
     - one token per recording instead of Voice's groups (76 instead of 7 that night);
     - conversations under 15,000 characters are never read, so short calls are skipped;
     - 487 stored guess reads are shown nowhere, and `voiceSuggestionOf` drops a name Voice calls "new person";
     - guesses were only ever judged for silent naming, never as a one-tap "Is this X?".
   - **Proof:** on the night of 20 Nov, with the chats added, his engine named the friend he had planned to meet, "sure", 3 minutes after the voice
     arrived, twice of twice, for $0.001. One wrong guess in 14. Apple's on-device model reads "about to meet, where,
     on the way" well, but it can't tell who a voice is: it notes the expected company, and his engine names the voice.
   - **Build plan** (each PR follows `work-on-code`; tests use made-up people and voices):

     | PR | What | Tier | Measures | His decision |
     |---|---|---|---|---|
     | 1. The card uses what Life already knows | Name from Voice's heard name (exactly one known person) and the stored guesses summed over the group; shown only when they don't disagree. No model, no prompt | standard | Score script "by group" on his past answered voices | Yes to show a guessed name on a card |
     | 2. Expected company and groups in the input | People from chats and calls in the window (6 h before to the end) with chat titles and appointments; tokens are Voice's groups; calls with slack; any length when a call or plan is near; confidence by counted signals in code | standard | `voice-naming-score.ts --hidden --trial` on 14 days, on a copy, against 16 Nov (9 of 9, 79 of 86); about 100 calls, about $1 | Yes to the new prompt version and that one trial |
     | 3. Asked when the voice appears | The watcher asks a few minutes after a group reaches 150 words or a conversation closes; daily cap; the night catches up | standard | Minutes from first word to card; calls and cost a day | Yes to a third daytime model step |
     | 4. Apple notes who he's about to be with | One more question on the arrival trigger (together soon, where, arriving), stored with the arrival replies, feeding PRs 2 and 3 | standard | A week of Apple's "together soon" against the night's episodes | Yes to a new trigger prompt version |
     | 5. Bulk card rows and learning | "Probably them" filled by sure guesses; the same person's small groups as rows; a weekly score per level; a level under its bar steps down | hard | Taps saved a week; right and wrong per level | Sure rows start ticked: **already yes** (21 Nov). Silent naming later, with numbers, and his yes |

     **Order:** 1 alone first (small, and fixes today's top "Leo" card), then 2 (the real gain), then 3 and 4 together,
     then 5. It builds on the voices-in-bulk card (item 1.6 above), whose concurrency fix lands first.
   - **Found on the way:** one person's Instagram account is a separate guessed person in Life (the report names
     them), which caused the one wrong guess. The fix is a same-person card for him; it should come first among guesses. Not ours to correct by hand.
     Voice could also link a person's groups across a language switch (Voice's side, later).
3. **Spoken asks PR 2 and PR 3** (branch `spoken-asks`, its PLAN.md lists the 8 refinements by PR). PR 3 needs a
   Life.app swap.
4. **The phone's performance fixes 4 to 8** (branch `phone-perf-4`, which doesn't compile yet; brief:
   [app-performance-audit.md](app-performance-audit.md)).
5. **Decision 98's batches**, then `calendar-adds-phone` ([builder.md](builder.md)).
6. **The Life plugin** (`~/Life/docs/memory-rework/life-claude-plugin-proposal-2026-11-20.md`, his answers included):
   the 30-minute experiment first.
7. **Then his earlier order:** the tap-feedback audit, the final design-fidelity pass, Tell Life last, and an email to
   him when all of it is done.

## The 7 agents in his second Claude app

He now talks to Life from a second Claude app, "Claude Overflow", signed into another account. Its connector is the
same Life connector (`https://life.ericedouard.com/mcp`), signed in on 21 Nov. Both apps read the same session
files (`~/.claude/projects`). Each app keeps its own list of sessions in its folder `claude-code-sessions`.

- **Done:** the 7 live agent sessions were added to Claude Overflow's list, with the titles they have in the main app:
  - Agent: Personal
  - Agent: MADworks (internal)
  - Agent: the house
  - Agent: Bloom
  - Agent: Lynx e-commerce
  - Agent: Lynx growth
  - Agent: Trocknerheld

  A sidebar section **Life Agents** exists, empty, id `cg-5584fdf4-8129-4ab2-bba4-a22010c45973`.
- **The app reads that list only when it starts.** He restarts Claude Overflow. Then, in the new session:
  1. `mcp__ccd_session_mgmt__list_sessions`: the 7 "Agent: …" sessions must be there.
  2. `mcp__ccd_sidebar__list_sections`: find **Life Agents**, or create it with `create_section` if it is gone.
  3. `mcp__ccd_sidebar__move_sessions` with the 7 ids and `section_id` of Life Agents.
- **If they are missing**, add them again and restart once more. The script below copies the main app's record of
  each active agent's current session, keeping only the safe fields. The two folders are this Mac's account and
  workspace ids.

```sh
cd ~/Library/Application\ Support
SRC=Claude/claude-code-sessions/e84581f4-94d2-42b1-8ccd-172de673436c/560bcf0f-fabd-42b2-b13a-0e2259c4ef85
DST=Claude-Overflow/claude-code-sessions/34035780-8a3d-4190-a9b4-d2b3a3a17836/ebf376a1-1291-403c-9be7-8bb3f5849529
D="$HOME/Library/Application Support/Life/state/desk/desk.sqlite"
for ref in $(sqlite3 -readonly "$D" "select s.ref from session s join agent a on a.id=s.agent_id where s.ended_at is null and a.status='active'"); do
python3 - "$SRC" "$DST" "$ref" <<'EOF'
import json,sys,os
src,dst,ref=sys.argv[1:]
p=f'{src}/local_{ref}.json'
if not os.path.exists(p): print('no record',ref); sys.exit()
a=json.load(open(p))
keep=['sessionId','cliSessionId','cwd','originCwd','createdAt','lastActivityAt','model','isArchived','title','titleSource','permissionMode','chromePermissionMode','adoptedFromOtherSurface','fromCliTranscript','lastFocusedAt']
json.dump({k:a[k] for k in keep if k in a},open(f'{dst}/local_{ref}.json','w')); print(a['title'])
EOF
done
```

- **Good to know:**
  - An agent's session open in either app holds that agent: the desk waits to wake it until he closes it (#911).
    Since #935, the one reminder is kept until then.
  - When the desk starts a fresh session for an agent, it shows in the main app only. Run the script again for this
    app. The plugin's naming and filing step would make this automatic.

## Other things set today

- **Code Mode is on** for every new Claude Code session on the Mac: `CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1` in
  `~/.claude/settings.json` (backup `settings.json.bak-before-code-mode`). The desk's agents read the same file.
  - A session started in Code Mode resumes only with it still on.
  - Reports say Code Mode doesn't run under `claude -p`. Check that the desk's agents still start and resume normally.
- **The design canvas** is published as a Design artifact: https://claude.ai/artifact/LCRgPeZu9VZVgdL4ms7GeF (502 frames,
  private). Its source export is in the data repo, `~/Life/docs/product/app-design/canvas/project` (0dc3dba7).
- **A pairing code for an app** (the menu's "Pair an app" from the command line):
  `LIFE_STATE_DIR="$HOME/Library/Application Support/Life/state" bun life pair`. It writes to the app's sign-in state.
- **Scripts:** kept in [`tools/`](../../tools/), listed in
  [builder-tools.md](builder-tools.md). Signing: `LIFE_SIGN_IDENTITY` is the "Apple Development" identity's hash
  (`security find-identity -v -p codesigning`); the Developer ID the README mentions isn't in his keychain.

## Loose ends

- **`skill-lock.json` in `~/Work/agent-config`** has uncommitted skill installs from 12, 19 and 21 Nov. It needs a
  small PR, or to be thrown away.
- **His decisions still open:** see [README.md](README.md) ("His decisions still open") and fixer.md (#874,
  whether a Personal agent the desk starts skips its first plan card).
- **Session cleanup:** the old worktrees under `~/Work/life-*` and `.claude/worktrees/`.
