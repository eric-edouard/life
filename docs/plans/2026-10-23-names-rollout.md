# Rollout: the stored names' rename (23 Oct 2026)

Runbook for a Claude session on the owner's Mac. It ships #172–#176: Life.app is rebuilt, and its first start renames
his stored memory once (`apps/server/src/host/migrate.ts`, AGENTS.md "A rename backfills"). Read AGENTS.md first;
its rules hold here. Do every step yourself except those marked **owner**, and report after each step in one line.

**Stop** at any surprise (an error, a check that fails, a number that moved), say what you saw, and wait for the owner.
Never hand-edit `memory/`, never run the migration by hand, never touch the archive (`~/Library/Application
Support/Life/archive`). The data repo keeps the state from before: a rollback is at the end.

Paths: `S="$HOME/Library/Application Support/Life"`; his data is `$S/data` (`~/Life` may link to it), Life's state
`$S/state`, its log `$S/state/log/<UTC day>.jsonl`.

## 1. Before

Run the nightly window check first: the nightly starts from 02:00 local. Don't start between 01:30 and its end
(`bun life memory status` in `~/Work/life` shows `nightly` and `processing`); if a run is going, wait for it.

```sh
S="$HOME/Library/Application Support/Life"
env | grep -E '^LIFE_(DATA|STATE|ROOT)='; grep -nE 'LIFE_(DATA|STATE|ROOT)=' ~/.zshrc ~/.zprofile ~/.zshenv 2>/dev/null
launchctl list | grep -i life
git -C "$S/data" status --short | head; git -C "$S/data" log --oneline -1
ls -d /Applications/Life.app ~/Applications/Life.app 2>/dev/null
```

- Any old `LIFE_DATA`, `LIFE_STATE` or `LIFE_ROOT`: the new code refuses to start while one is set. Show the owner
  the line and, on his yes, rename it (`LIFE_OWNER_DATA_DIR`, `LIFE_STATE_DIR`, `LIFE_CODE_DIR`) or remove it.
- A loaded LaunchAgent of a checkout (`com.….life.*` running the checkout's code): stop. Life.app supervises the
  services; ask the owner before unloading it.
- Note the data repo's last commit: it is the rollback point if the "before" commit is missing.
- Take the baseline, kept for step 4: `bun life memory status` (in `~/Work/life`, still on the old code), and the
  line counts:

```sh
cd "$S/data" && wc -l memory/actions.jsonl memory/observations/*.jsonl memory/verdicts.jsonl memory/corrections.jsonl | tail -1
ls memory/units | wc -l; ls memory/moments | wc -l; ls memory/pages/people memory/pages/areas | wc -l
```

## 2. Build

```sh
cd ~/Work/life && git status --short && git checkout main && git pull
rm -rf node_modules && bun install && bun run check && bun scripts/app.ts
```

`git status` must be clean (it is the live checkout); stop if not. The check must pass. If the Swift build fails, it is
this change's (the Mac app was not compiled when it was written): send the owner the error, stop.

## 3. Swap the app (owner, with you)

Quitting Life stops its services (the old watcher must be gone: the rename waits for it).

```sh
osascript -e 'quit app "Life"'; sleep 5; pgrep -fl "Life.app/Contents" || echo "stopped"
```

Then replace the installed app with `dist/Life.app` where step 1 found it (keep the old one aside, for the rollback):

```sh
A=/Applications/Life.app   # or ~/Applications/Life.app, as step 1 found
mv "$A" "$HOME/Life-before-names.app" && cp -R ~/Work/life/dist/Life.app "$A" && open "$A"
```

**Owner:** the build is signed ad hoc, so macOS may ask again for Full Disk Access (Privacy & Security → Full Disk
Access → Life). Without it the archive and the Mac's stores fail; the rename itself doesn't need it.

## 4. Watch and verify

The first command the app runs renames the memory (a minute or so) before anything else. Follow it:

```sh
tail -n 50 -f "$S/state/log/$(date -u +%F).jsonl" | grep --line-buffered -E 'memory.renamed|run.error'
```

A `run.error` with `memory.renamed`: stop. When `memory.renamed` shows, check:

```sh
cd "$S/data"
grep stored-names memory/migrations.jsonl
git log --oneline -3                      # "stored names renamed", and "before the stored names' rename" under it
ls memory/actions.jsonl memory.renamed memory.old memory.stray 2>/dev/null   # none of these may exist
wc -l memory/ledger.jsonl memory/observations/*.jsonl memory/verdicts.jsonl memory/corrections.jsonl | tail -1
ls memory/units | wc -l; ls memory/moments | wc -l; ls memory/pages/people memory/pages/areas | wc -l
grep -c '"u_\|"act_\|person:inf-\|"salience"' memory/observations/*.jsonl memory/ledger.jsonl | grep -v ':0$' || echo "no old names"
grep -E '"actions"|"atlas"' "$S/state/settings.json" || echo "settings renamed"
```

- The total line count must equal step 1's (only late lines may add, a handful at most), and the file counts too.
- `git -C "$S/data" diff --stat HEAD~1 HEAD | tail -1` shows the files the rename rewrote; it must not list `truth/`.
- Then `cd ~/Work/life && bun life memory status`: the watcher `ok`, processing idle or running, no new failure. Open
  the status window: no new red card but Full Disk Access ones (step 3).
- Spot-check one person's page: `bun life memory person <someone close>`: it reads as before, with `obs_` cites.

## 5. The agent

1. **Owner:** reconnect Life in ChatGPT (Settings → Apps & Connectors → Life → refresh, or remove and add it again)
   and in Claude (Settings → Connectors). The tools are renamed (`read_open_agent_tasks`, `change_todo_item`…).
2. **Owner:** paste the setup sentence again, from `docs/use/agent.md` step 3 (it now names `read_open_agent_tasks`),
   into the agent's instructions.
3. His own part of the playbook may name the old tools. Show him the lines; edit them on his yes:

```sh
grep -nE '`(day|person|area|chats|places|status|runs|changes|claim|correct|reminders|open_reminders|tasks|task|reply)`|claim: true|waiting-eric' "$S/data/playbook.md"
```

4. On his yes (it spends model quota): `cd ~/Work/life && bun scripts/bench-agent.ts`, and report its table. A case
   that fails on a tool name is this rollout's; others are the agent's.

## 6. Done

Tell the owner: done, the counts before and after, anything noticed. The first day is a little noisy, by design: the
first night may say no daily review reached Life, and for about a week a Due item may be shown again (old log lines
name the old tools). Then the cleanup PR removes the migration code (`host/migrate.ts`, `renamedSettings`, the old
environment names' refusal) once `memory/migrations.jsonl` holds `stored-names-2026-10-22`.

## Rollback (only on the owner's yes)

1. Quit Life (step 3's command).
2. Put the data back to the commit before the rename: `git -C "$S/data" log --oneline -4`, then, on his yes,
   `git -C "$S/data" reset --hard <the "before the stored names' rename" commit>` and remove any of `memory.renamed`,
   `memory.old`, `memory.stray` that exists. Lines appended after that commit (a correction, a ledger line) are lost:
   list them first (`git -C "$S/data" diff <commit> -- memory/ledger.jsonl memory/corrections.jsonl`) and give them to
   him.
3. Settings: in `$S/state/settings.json`, rename `todo_list` back to `actions` and `"agent"` in `sources` back to
   `"atlas"`.
4. Put the old app back: `mv "$HOME/Life-before-names.app" "$A"`, open it. The code before the rename is `d4b1d79`.
