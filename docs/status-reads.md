# Status reads

Developer reference for the connector's four JSON status reads. Most people never need it: the status window in Life.app
shows the same.

Four read-only tools on Life's connector (`/mcp`) let a private page show whether Life works, what it ran, every
change to the memory and the evidence behind a claim. The CLI has the same reads, from the same code: `bun life memory
status | runs | changes | claim`. Code: `apps/server/src/host/status/life.ts` (status), `apps/server/src/memory/run-log.ts` (runs) and `apps/server/src/memory/changes.ts` (changes,
claim). They run no model, write nothing, log nothing and send nothing (a test checks the code; the connector logs each
call as `mcp.call`), and read no source except, for `claim`, the cited unit's chat-day or mail thread-day, read again
the way `fetch` reads it (to show who sent the line). Every answer is JSON, sent once as text content (no
`structuredContent`: the model would read it twice), and carries `observedAt`, the server's time.

Auth is the connector's, unchanged: a JWT for `<your connector origin>/mcp` (from Life's own issuer or the `connector`
setting's), `life:read`, `sub` = the owner. Without it: 401; another user: 403; lifelog's keys out of reach: 503. The
four tools are annotated read-only.

## status

Is Life working, how fresh is its memory, what runs next. Four clocks, kept apart:

| Field | Clock | From |
|---|---|---|
| `capture.lifelogOkAt` | the watcher folds lifelog in as it arrives | `derived/watch/health.json` |
| `capture.archive.{whatsapp,beeper,notes}` | last copy into Life's archive (a new message or note version), not a health check | each store's newest `seenAt` (`lastCopied`) |
| `capture.lastTriage` | the last run that judged units (the moments step since 18 Oct, its counts per source under `sources`; the key keeps its name) | derived/log |
| `extraction` | midday (13:00, 19:00), nightly and backfill weeks | derived/log, `memory.extract` |
| `consolidation` | pages: midday (13:00, 19:00) and nightly (or a hand run) | derived/log, `memory.pages` |
| `indexBuiltAt` | rebuilt by the watcher on any lifelog change and by each sweep: **not new memory** | index file time |

- `watcher.state`: `ok` (a good poll in the last 15 min), `not-polling`, `off` (no voice source), or `unknown` (no
  health file).
- `extraction`, `consolidation`, `nightly`, `midday` each give `latest`, `lastOk`, `lastFailed` (whole run records, see
  `runs`) within the last `lookbackDays` (7) of logs; null means none recorded in that time, not success.
- `processing`: `running` while a run holds the lock (`since`, the `sweep` and the step in progress as `phase`), else
  `idle`.
- `nightly.state`: the guard's record (`date`, `status`, `attempts` of `maxAttempts`, `okAt`); `midday.slotSpentAt`:
  when the last midday started. **A spent slot is not a success**: read `midday.lastOk` / `lastFailed`.
- `backfill`: the backfill's runs (`latest`, `lastOk`, `lastFailed`) and `state`: its range (`next`, `to`), `failures`
  of its current week (3 stop it), and `weeks` read on `day` (4 a day at most); null when none was set.
- `nightly.next`, `midday.next`: `{earliest, latest, why}`. The nightly tick runs every 30 min, so a run is expected
  between the two if the Mac is awake and the lock is free; `why` says "retry 2 of 3 after a failure", "3 failures
  today: no more tries until tomorrow", "today's night succeeded", "the next slot", or "held: Codex quota 91% used, over
  75%" (the midday waits for the quota's reset: `earliest` is the first slot after it, or after the next tick when the
  reading has no reset time). Not a countdown.
- `timeZone`: the Mac's, which every schedule follows.

## runs

Processing history, newest first: `{items, count, cursor, observedAt}`; pass `cursor` back for the next page until it is
null. `limit` 1-500 (default 50). `steps` picks other kinds (default: the sweeps `memory.nightly`, `memory.midday`,
`memory.backfill` and the steps `memory.repos|files|moments|extract|closeness|pages` (`memory.triage` and `memory.infer`
until 18 Oct)).

A run: `id` (`<step>/<run>`, the run id being its start instant with `:` written `-`), `step`, `startedAt`, `endedAt`,
`outcome`, `input` (what it started with: `from` and `to`, the local days it read (runs before 21 Oct: `days`), `force`,
`prompt`, `model`), `window` (`{from, to}`, the local days its sources were read for), `result` (the step's counters as
it logged them: `calls`, `failed`, `cached`, `reused`, `added`, `read` per source, `agreement`…; a nightly's `listed`:
the observation ids its report held, sent or not), `errors`, and for a sweep `phases`: the phases it entered, in order
(its steps among them; `run.phase` lines, since 21 Oct), the last one while it runs being `status`'s `processing.phase`.
A sweep lists its steps in `children`; a step names its `sweep`. Since 21 Oct a run that made model calls has `use`,
what it spent of the owner's Codex plan, derived from the log (`useOf`): the `tokens` (`input`, cached included,
`cached`, `output`) of its model calls (each `model.run` line's) and its steps'; a metered run (a sweep, the eval
`eval`, the agent bench `bench.agent`: `metered`, run.ts) also has the `quota` it read as it started and ended
(`before`, `after`: whole percents of the fuller window; null when unread, e.g. on the claude engine, and `after` while
it runs). The nightly email has a line per sweep of the last 24 h.

`outcome`: `ok`; `failed` (it ended with failures, or a sweep's `outcome: failed` with `failedAt`, the phase that
stopped it); `running` (no end yet, and it started after the lock was taken); `unfinished` (no end and nothing holds
the lock: interrupted, or killed). Old errors with no run id are their own entries (`startedAt` null), or join the
sweep they fell in.

Each run in the list is whole; what a step wrote is `changes` with its `run` (its `id` as given, or the bare run id). A
sweep writes nothing itself: open its `children`.

```json
{"id":"memory.extract/2026-10-16T11-12-49.565Z","step":"memory.extract","outcome":"ok",
 "startedAt":"2026-10-16T11:12:49.565Z","endedAt":"2026-10-16T11:13:16.894Z","window":{"from":"2026-10-16","to":"2026-10-16"},
 "input":{"days":1,"prompt":"memory-extract.v2"},"result":{"calls":1,"failed":0,"read":3,"cached":0,"added":7},"errors":[]}
```

## changes

Every change to the memory, past a cursor: `{items, count, remaining, cursor, observedAt}`. `count` is the items
returned; `remaining` the matching items past the new cursor (same filters). Keep the last cursor to refresh: a
refresh from it returns only what was appended since (about 40 ms).

Every item: `id` (stable: `observations/2026-10#1234`, `corrections#24`, `page:<sha>:<path>`), `type`, `record` (the
ledger line as written; a page change: its `sha`, `path`, `subject`), `recordedAt` (when Life recorded it; for an
observation, the start of the run that wrote it), `happenedAt` (when it happened in the owner's life: the cited line,
the owner's request; null for Life's own acts), `run` and `about`. By type:

| `type` | One item per | Also |
|---|---|---|
| `observation.extracted` | line of `observations/*.jsonl` | `status` |
| `observation.superseded` | supersession | |
| `correction.<kind>` | owner correction | `reflected` |
| `identity.inferred` | `people-inferred.jsonl` line | `used` (confidence ≥ 0.5), `current` (latest for one of its surfaces) |
| `action.ok` / `action.failed` / `action.duplicate` | `actions.jsonl` line: Life's act, or the owner's own change in Reminders (`record.madeBy` `reminders`); intents and imports are not in the feed | (`record.error` starting `partial:` on an ok add or edit that lost a field) |
| `action.ask` | an ask for the agent in `actions.jsonl` | `record.after.confidence` (`high`, `low`), `record.after.conversation` and `turns` for speech; `about` `task:<its id>` |
| `action.update` / `action.reply` (and until 20 Oct `action.nudge` / `action.steer`) | a task's line in `actions.jsonl` (`record.target`: the task, or `chat` for a reply on none) | `record.after` (`docs/SCHEMA.md`); `about` `task:<the task>` |
| `rating.true` / `rating.false` / `rating.outdated` / `rating.skip` / `rating.undone` | `ratings.jsonl` line (the owner's answer on the check page; a false hides its claim, an outdated retires it) | |
| `page.changed` | committed change of one page file | `added`, `removed`: the page's text lines, the owner's plain lines included (frontmatter left out; a commit that changed only frontmatter has both empty) |

Filters: `types` (types or prefixes: `observation`, `correction`, `action.failed`…), `about` (`person:<id>`,
`area:<id>`, `project:<id>`, `task:<id>`: one task's ask, updates and replies), `run`, `since` (recorded at or after). A
filter narrows the items, never the cursor's reach: every match is still returned, page by page.

- **Status** of an observation: `hidden` (the owner said wrong or not important: `correction`, `note`), `gone` (its unit
  no longer exists, a lifelog chapter re-cut, or a code rule drops it now), `replaced` (its unit was read again; the
  newer extraction counts), `retired` (superseded: `by`, `why`; `by` itself when the owner rated it outdated; still
  indexed, still cited on its page, never new there), or `active`. Retired and active carry `hiddenOn`: pages it is
  hidden on (pages carry salience 2+ only). It is the rule the index and the pages go by (`stateOf`,
  `apps/server/src/memory/ledger.ts`), so it says what they show. An observation is a model's reading of the source with its quote
  checked against it: `active` is not "verified", and `confidence` is the model's own.
- **Reflected**, for a correction: has it reached the index and the pages yet? Exact for `wrong` and `not-important`
  (the observations are gone from the index and from the pages) and `keep-mine` (the line is on its page). `null`: does
  not apply, no index, or an identity correction (not tracked). A correction is recorded at once; it shows after the
  next index (minutes) and the next pages run (the night).

**Cursor.** Opaque; it counts the complete lines read from each source (corrections, supersessions, inferred, actions,
ratings, each month of observations, then page commits). The ledgers are append-only, so a line never moves: a page ends
exactly where it stopped, a line appended to any source meanwhile is picked up, none twice, and a line still being
written waits for the next read. Items come source by source; sort by `recordedAt` to show them. A cursor past the end
of a ledger (one shrank, which the rules forbid) is an error, never a silent restart. Page changes are counted in `git
log` order of the data repo (`OWNER_DATA_DIR`): amending or rebasing a commit that touched `memory/pages` would shift them
silently.

## claim

One observation with its evidence: `observation` (the version that counts: the latest extraction, else the last line),
`status`, `versions` (every line of it in the ledger, with run and status), `unit` (id, source, conversation or chat
key, title), `read` (how to open the source with the existing readers: `{tool: "fetch", id}`, and for a chat
`{tool: "chats", chat, from, to}`; these redact secrets), `speaker` (`filed` at extraction with its readable `name`;
`handle`, the cited message's sender read again from its chat-day, as `fetch` and extraction see it; `now`, who that
is with today's map and corrections, so a mapping corrected since shows here),
`entities` (as resolved today, each `filed` or not, an inferred person with its `confidence`), `corrections` (that hide
it, or about its speaker's handle), `replaces` (the observations it retired; if it was retired, `status` says by
what), `pages` (the page lines citing it now) and `index` (`holds`, `supersededBy`).

## What is not covered

- Sweeps before 16 Oct 2026 logged only their failures: no start, phases or result. Step runs (triage, now moments,
  extract, infer, pages) are complete from 14 Oct. derived/log is never rotated.
- No record of each index rebuild (only the file's time). The archive's failures are in derived/log (`archive.<store>`:
  `run.error` when one starts, `run.end` when it ends), not in `status`.
- `about` matches the refs an item carries: an observation's filed entities, speaker and area; a supersession's page
  (none when extraction retired it); a correction's page or people; an ask's and its task lines' `task:<id>`. Not the
  entities of the observations a correction or supersession names.
- Page changes appear once committed (the nightly commits them); an uncommitted hand run of `pages` does not show.
- Units are not in the feed (they are rewritten, not appended): read them with `day`, `search`, `fetch`.

## ChatGPT Sites

Checked 16 Oct 2026 against learn.chatgpt.com (Data and connections, Publish and share, the enterprise page); the Help
Center articles on supported connections returned 403. What is stated: a Site reads connected data with **each
visitor's own connection and permissions**; plugin use must be enabled in the workspace, and the Site private to it;
when a connector returns a cursor, Sites fetches the next page with a "Load more" action; Sites manages caching. What is
**not** stated: whether a custom MCP connector added by URL (like Life's) is eligible, which plans allow it, size
limits, or whether structured output is used. So end-to-end compatibility is unverified: it needs a test in the
owner's workspace.

What holds either way: only the owner's token passes, so other workspace members get 403 even if the Site is shared,
and nothing is copied into a shared cache by Life. Live reads need the Mac online; a Site that keeps a last-known
snapshot must date it and mark it stale, and where it is stored is a separate decision.

# The status window

Life.app's status window and menu-bar panel (`apps/mac/Sources/LifeApp/`): Life's architecture as live cards,
native SwiftUI. **Read-only**: it changes nothing, sends nothing, and adds no connector tool.

- **Code.** `apps/server/src/host/status/snapshot.ts` reads every part (sources, capture, pipeline, memory, outputs, the Mac) into cards
  (`snapshot`); a source's card is its descriptor's (`SOURCES`: `label`, `silentAfter`, `newest`, each read by the
  source's own module), the Mac's probes are `apps/server/src/host/status/mac.ts`. `apps/server/src/host/status/snapshot-detail.ts` gives a card's history and log lines
  (`detail`) and a run's steps and what it wrote (`runDetail`, from `runs` and `changes`). `apps/server/src/host/http/status-reads.ts` serves
  them as JSON on the local port only (`/status/snapshot`, `/status/card/<id>`, `/status/run?id=`), behind the local
  key; the app decodes them (`StatusSnapshot.swift`) and reads the status snapshot every 3 s while the window is open.
- **Health.** Broken vs quiet (`toneOf`): red only when Life can't read or run a part; silence is grey, amber past its
  source's `silentAfter` (Pendant 6 h between 08:00 and 01:00, WhatsApp and iMessage 24 h, Mail 12 h, Beeper and
  Git 3 d, Notes 7 d). A card in trouble offers a sentence to paste into a Claude session.
- **Content.** In full (a message's first words, ask quotes, raw log lines) behind a Show content switch.
- **Look.** Life's brand (`docs/brand.md`, its fonts bundled from `apps/mac/Fonts`), light or dark as the Mac is set: no prose, the parts flowing
  left to right as data does, a card opening in place over the status snapshot.
- **Details.** A card opens to its history (a sweep's runs, the tasks, the memory's changes, the Mac's sleeps, else
  its log lines) and its raw log lines, each paging back through the whole log (`before`, `next`); a run opens to its
  steps, their counts and what it wrote.
