# Life: where things stand (19 October 2026)

Life was reset on 14 Oct into a read-only memory and rebuilt over the 15th; later that day it started acting, on his clear requests only (below). This is **not a full spec**: the rules are
in `AGENTS.md`, the record formats in `docs/SCHEMA.md`, the sources in `docs/sources.md`; his feedback,
roadmap, evals and research notes in `~/Life/docs/`. This repo starts on 19 Oct; the older history is in the
encrypted backup. This file says what is true now.

## Why the reset

- The owner does not use Life. The to-dos and cards it pushed were too many and badly calibrated, and the build
  (app, agents, logins, Telegram) burned a lot of tokens for little value.
- Life went wrong by starting at the top: actions before a reliable picture of the owner's life existed.
- The goal now: **a knowledge map of what's going on in the owner's life**, meaning the people around him, his
  projects, and the chronology, built from every source. Actions only on top of it, and only on his clear request (next line).
- 15 Oct: the map is reliable enough, so Life acts again, but only on his clear words: Apple Reminders, every action
  logged (`memory/actions.jsonl`), never on anyone else's words. 19 Oct: Life stopped acting on what it hears: he says
  "hey Atlas, …", and Life hands the ask to his ChatGPT agent Atlas as an MCP event (below, "Atlas"), which does the
  deep work, reading Life through the connector.

## The split (decided by the owner, 13 Oct)

| | lifelog (`~/Work/lifelog`) | Life (this repo) |
|---|---|---|
| Job | Voice capture: Pendant audio, transcripts, speakers, per-conversation chapters and summaries, search, MCP | Memory across sources: Pendant (via lifelog), WhatsApp/Beeper, iMessage, mail, Apple Notes |
| Owns | The raw spoken archive | The people list across channels, observations, people and project pages |
| Runs | iPhone + Railway + the Mac helper | The Mac (Beeper and chat.db are Mac-only, and chats stay off Railway) |
| Acts? | Never | Only on his clear request: Reminders (15 Oct) |

- Life reads lifelog through its REST API with the device token (`src/sources/lifelog.ts`). It keeps chapter
  titles, summaries and turn refs, no transcript text but an ask's words (AGENTS.md). Exact quotes are fetched on demand.
- Life writes to lifelog only through `forward`: the owner's explicit corrections (speaker, title, rename, merge). For
  anything else it needs from lifelog, write an ask for a lifelog session.
- Memory does **not** move into lifelog (rejected 13 Oct): memory about one person comes from voice, chats and mail
  together, and chats must not go to Railway or their text to OpenAI for embeddings.
- Raw search scales, reading does not: a day of speech is about 110-150k tokens, the largest context holds about 8
  days. Hence one compressed layer, the people and project pages, each line cited. Not justified: an atomic-fact
  database, graph databases, contradiction resolvers, summary hierarchies, decision models.

## How it runs

Three LaunchAgents, all installed by `bun scripts/install.ts <archive|watch|memory-nightly>` (safe to repeat; run it
from `~/Work/life`). Logs are in `~/Library/Logs/life-*.log`.

| Job | What it does |
|---|---|
| `archive` (KeepAlive) | Every 5 s copies WhatsApp (and media) and Beeper's LINE, Telegram and Instagram into `~/Library/Application Support/Life/archive/`, so messages deleted for everyone survive, and each new version of every Apple Note (`notes.sqlite`), opening any of the three apps that is closed, hidden. The only copy: never touch its files. |
| `watch` (KeepAlive) | Long-polls lifelog's change feed, folds each page into `derived/watch/lifelog.sqlite`, then rewrites the lifelog units and the search index. Skips the sync while the nightly holds its lock (`~/Life/.nightly.lock`, shared by every worktree) and catches up after. Also hears "hey Atlas" once a conversation's speech is complete (`speechIn`, `WAIT_MS`), `hear` (`hear.ts`) records its asks, and each loop `deliver` (`events.ts`) pushes the undelivered asks, nudges and steers to Atlas and `tick` (`board.ts`) chases and mirrors his tasks. `bun life status` reads `derived/watch/health.json`. An outage delays, never loses, so nothing alerts on it (AGENTS.md). |
| `memory-nightly` (every 30 min) | A guard (`derived/memory/nightly.json`) lets it run once a day after 02:00, 3 tries; `--force` for hand runs. The same tick also runs a **midday** pass at the first tick after 13:00 and after 19:00 (`bun life memory midday`: moments + extract of today's lifelog conversations that are summarized and quiet for an hour, then the index; same lock, no pages/commit/email, a failure only logs). All steps look back 7 days (lifelog re-summarizes units days later). Reads lifelog as the watcher's store holds it (only the watcher polls, so every turn is heard; the report says when it is not polling). Maps the repos (new ones only), then moments (who the unknown people are too), extract, pages, index, one commit "Memory: <date>" in `~/Life` (the data repo, never pushed), and one report email, saying which days it read and counting as new only the observations whose source line was first cited since the last good night (`newSince`: a re-read announces nothing again), midday runs included (HTML with a plain-text alternative, `report.ts`, with an Actions section: the last 24 h and any remctl problem, an Atlas tasks section: every open task and those closed in the last day, and a Code section: yesterday's commits by project, the repos the step just guessed as possible new projects). The first failing step stops it: non-zero exit, nothing committed, a failure email after the 3rd try. Once the night is done for the day (ok or 3 tries), or from 06:00, the same or a later tick runs the **backup** (`backupDue`, its own guard state `derived/memory/backup.json`, 3 tries): `src/backup.ts`, the daily restic snapshot to iCloud Drive, and on Sundays forget, prune and check; status in `derived/backup.json` and a "Last backup" line in the next report. Key and restore: AGENTS.md. At high effort the moments step takes about 3-5 minutes per day it reads (a prompt change re-reads the window: about 40 minutes); each day is read again when one of its units changes, so about 3 times (13:00, 19:00, the night). |

- **Model calls** go through `src/llm.ts` (`askOnce`): `claude -p` or the pinned native `codex` (0.162.1, model
  gpt-6.1-sol), switched with `bun life engine claude|codex`, fast and main tiers. Both run in an empty temp folder, so
  no CLAUDE.md, AGENTS.md or auto-memory reaches a call. Codex has its own `CODEX_HOME` in
  `~/Library/Application Support/Life/codex` and needs one login by the owner:
  `CODEX_HOME="$HOME/Library/Application Support/Life/codex" codex login --device-auth`.
- **The pipeline:** sources become units (`units.ts` only); moments (`moments.ts`, one deep call per day) reads each
  day of units across every channel in time order, appends a verdict per unit to `memory/verdicts.jsonl` and writes
  what happened or is planned (`memory/moments/`); extract reads each moment's units together and writes quote-checked observations (and retires
  earlier facts the moment shows are no longer true), the same moments call writes who the day's unknown people are to `memory/people-inferred.jsonl` (used at once by the
  resolver), `repos` writes `memory/repos-inferred.jsonl` (the same for code repos: his map is `Project.repos` in truth/), pages (`page.ts` pure, `pages.ts` orchestration) rewrite the people and area pages with every line cited,
  no churn and 800 words at most (his own page 2,000). One area vocabulary, `truth/areas.yaml`. Lifelog units are one per chapter, id from
  lifelog's chapter id; an id-map is shipped with any change to how unit ids are made.
- **Read path** (`bun life memory ...`): the commands are listed in AGENTS.md ("Answering about his life"). Code:
  `search.ts` (index and pages), `raw.ts` (words fetched on demand, not stored but in an ask's quote). Text is redacted; ids are not.
- **Self-sustaining:** the owner never runs `bun life ...` or reviews a queue. His word arrives in conversation and is
  recorded with `bun life memory correct` (`memory/corrections.jsonl`); conflicts between observations are settled by
  extraction, from the moment's evidence, and recorded as supersessions.
- **Connector** (`src/mcp.ts`, `https://life.ericedouard.com/mcp`): Life's one MCP server for Claude and ChatGPT, the CLI's
  read functions as seven tools, four JSON reads for a dashboard (`status`, `runs`, `changes`, `claim`: `docs/dashboard.md`), plus `tasks` (it also returns Atlas's playbook and the seal `task` needs), `open_reminders`, `correct` (annotated so clients ask first), `reminders` and `task` (writes, not destructive: Atlas uses them unattended), and one MCP event, `ask`. The watcher serves it on 127.0.0.1:46200 (`serveConnector`, `src/server.ts`), reached through
  the Cloudflare tunnel (`~/.cloudflared/config.yml`, proxied CNAME `life`). Its rules are in AGENTS.md; auth, tools and the wave icon are in the code,
  and in `derived/log` each call is an `mcp.call` (who asked, the arguments, what surfaced: `tool` in `src/mcp.ts`; a refused request too, with `refused`), each
  forwarded correction a `lifelog.write`. Off when `LIFE_OWNER_SUB` is unset. The same server serves the check page (`/check/`, `src/check.ts`): the truth benchmark's statements, one tap or swipe each, behind the same lifelog sign-in.
- A Telegram bot's token and an `INSTINCT_KEY` are parked in `.env`; nothing uses them.
- **Removed on 14 Oct** (the old history in the backup has it, see the "Nuke" commit): the SwiftUI app, the Railway server, the Telegram bot's
  cards, brief, gate, agents, logins and the calendar, notes, reminders, contacts and whereabouts sources. The owner
  deleted the Railway project on 14 Oct (purged 16 Oct). The `life-vault-<signer>` Keychain items and
  `~/Library/Application Support/Life/Chrome` are his to delete.

- **Actions** (`src/actions.ts` the only writer on his request): `act` changes his Reminders when he asks in a Claude session
  (`bun life act '<json>'`, `--check`) or a chat (the connector's `reminders`), and logs it. `act` records as a
  duplicate an add whose title an open reminder has (`duplicateOf`, every caller). A timed due always gets an alarm at
  that time; several doses a day are one daily reminder per time, ending with remctl's JSON recurrence. Reminders
  through `~/bin/remctl`. A failed action is emailed at once with his words.
- **Atlas** (19 Oct; its playbook, returned by `tasks` with a seal `task` checks: `docs/atlas.md`): his ChatGPT agent, with
  Life's connector, its cloud computer and his Mac's terminal. "Hey Atlas" anywhere in one of his turns (`hear.ts`, no
  model) makes an ask: that turn and his following ones until another speaker or a 15 s pause, with the conversation
  and turn numbers; an unattributed turn makes a `low` confidence ask, someone else's none. `bun life ask '<words>'`
  makes one from a Claude session. An ask is an Action (`kind: ask`), delivered as the MCP event `ask`
  (`events.ts`, OpenAI's spec: `events/subscribe` with a verified callback on OpenAI's hosts, Standard Webhooks
  signatures, the ledger line as the replay cursor, `derived/events.json`). `bun life asks` lists where each ask's
  time went.
  Every ask is a task until Atlas closes it done or dropped (`tasks.ts`, its board `board.ts`): Atlas reports with `task` (also
  making a task from his chat words, or a split), Life nudges it past a deadline and shows every task on the Reminders
  list `Atlas` (made 19 Oct, with its sections), where his own changes steer Atlas. Rules and states: AGENTS.md and the playbook.

## Evals

`~/Life/docs/evals/questions.md` has 15 questions. Plain retrieval (`baseline-2026-10-14.md`): 10 right, 3 missed evidence, 2
confirmed by the owner, 0 wrong. With memory (`memory-2026-10-15.md`): 12 right, 3 missed, 0 wrong; better on 5 broad
questions, the same on 9, worse on 1 (a read-path gap, not memory).

The truth benchmark (step T): after any pipeline change, `bun scripts/eval.ts --ratings` scores the memory against his
ratings (recorded in `memory/scores.jsonl`). The first score is near-perfect by design (a false hides its own claim, a
true is judged against itself, an outdated one counts as true and held, unjudged, and apart as a closure Life missed): only a score after a re-read (a prompt or code change, then a nightly) means anything. It holds the lock through its
judge calls: not near 02:00, 13:00 or 19:00. To trace a false to its step: `bun life memory claim <obs_id>`, `day` for
a moment.

Model choice: `bun bench [--models opus,…] [--runs n]` runs the real moments and extract over 12–18 Oct, once per
candidate (`MODELS` in `scripts/bench.ts`: Opus on his subscription, the others through OpenRouter on zero-retention
hosts) on an empty copy of the data (today's `truth/`), and judges each run's claims (his engine's main tier, named in the table) against that week's
38 hand-checked facts and his rated statements; the baseline (Life's deep tier) runs twice so its own spread shows.
About 40 minutes; it prints the table and writes nothing of his. Not between 01:30 and 06:00.

## Open

- From the debt review of PR #1: one identity resolver (eric-edouard/life#2), one rule for which inferred person
  counts (#3), split `units.ts` (#4), a run
  record for the eval's model calls (#6); `gh issue list` has the rest.
- The owner's 13–18 Oct feedback, ranked, with its progress grid: `~/Life/docs/roadmap.md`.
- **The owner model (18 Oct):** his own page has Views, values and habits (never ages, his own words only), Health
  (ages at 60 days) and Now, 2,000 words; his goals are in `truth/me.md`. For the event rebuild (step 3): a claim
  carries **who it is about** apart from who it mentions (`about`, from `memory-extract.v3`; `homeOf` goes by it),
  and conditional speech stays as such (`modality`, never a page line). Still open: a type for a belief or value.
  Extraction should also decide that an unnamed voice in a recording where nobody
  else is identified is his (`speaker: person:me`): then code can hold views lines to
  his words (`speaker === OWNER` in `checkReply`), which only the prompt asks today. The 55 earlier conversations about his views (triage 0-1 before
  `memory-triage.v3.2`) were not re-judged: the rebuild re-reads them.

- Tell the lifelog session that Life is on the numeric cursor, so it can delete the timestamp `since` shim.
- Phase 6: re-run the evals against the baseline.
- Stale 9 Oct lifelog bugs with no end state, sensitive lines on pages, near-duplicate observations from two copies of
  one recording.
- Observations pointing at units that no longer exist: 5 mail and 8 Beeper (cited by id only) and some labels on
  re-cut lifelog chapters. Older observations from multi-line messages may have a wrong speaker, ref or time (a fixed
  quote-check bug).
- The codex login for the engine switch.
- **Life as the single connector** (plan: `squishy-gliding-kazoo`): PR1 and lifelog PR-A are done; PR2 (`src/mcp.ts`)
  is built, see "Connector" above. To go live: merge, restart the watcher, add `https://life.ericedouard.com/mcp` in
  Claude and ChatGPT (web; iOS apps use the connectors added on the web), test, then the owner removes the lifelog
  connectors. Also put a favicon at the apex `ericedouard.com`: Claude asks Google's favicon service about the last two
  labels of the connector's host, so it never sees `life.`'s icon. Then lifelog PR-B (removes its MCP).

- **Actions, still open:** the connector approval test in Claude, and his rounds on the Reminders structure (Life reads
  lists and sections at run time, so no code waits on them).
- **Atlas, still open:** his test that a scheduled Atlas run can use the Mac with no approval prompt, then: rescan the
  connector in ChatGPT (for `tasks`, `task`, `open_reminders` and the new instructions), paste the bootstrap sentence (`docs/atlas.md`, "Set up once") as the dot's, the `ask` subscription's and the daily review's instructions, ask it to subscribe to `ask`, and `bun life ask "run date
  on my Mac and message me the result"`. Not built: tagging what Atlas sends from his accounts (read back as his words),
  "Atlas" in lifelog's transcription vocabulary and better speaker ids (lifelog's session), a mail fallback if MCP
  Events fail on his plan.

## Lifelog (agreed with the lifelog rebuild session, 14 Oct)

- **Latency target:** about 5 minutes from speech to words, and about 5 minutes from a closed chapter to its summary
  (conversations capped at 60 minutes).
- **The feed:** `GET /changes?since=<seq>&wait=<0..60>` (long-poll), a gap-free numeric cursor. `turns[]` arrive before
  any summary, each with `isOwner`; `chapters[]` are summarized as they close, each with a `kind`; `conversations[]`
  carry `waiting` and `retired`; `removed[]` lists deletions. Life has been on it since 15 Oct. A name given to one
  turn names that turn, not the voice: Life takes each turn's speaker from the feed.
- Being fixed on lifelog's side: duplicate conversations, wrong speaker labels, name spellings fed to transcription,
  and chapter-level fetch for long conversations.
