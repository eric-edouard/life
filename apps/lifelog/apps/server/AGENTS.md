# apps/server

Routes are in `src/routes/<domain>.ts` (Hono with Zod OpenAPI schemas); the logic is in `src/<domain>.ts`, tested
beside it. The database is `packages/db` (`@lifelog/db`): the Drizzle schema of one SQLite file (`DATABASE_PATH`) in
`src/schema`, the committed migrations in `src/migrations`, applied at boot, and `connect`. Nothing but the server
uses it, and the notes below hold for it.
Model calls go to the Mac over its socket (`mac-socket.ts`), and `openapi.json` is the contract the phone is checked
against. What the server owns and what the phone copies: `docs/sync.md`.

## How to

- **Add a route or field:** follow "Where to add a feature" in `docs/architecture.md`. After any route or schema
  change, run `bun run --cwd apps/lifelog/apps/server openapi`; the gate fails on a stale `openapi.json`.
- **Change a table:** edit `packages/db/src/schema`, run `bun run --cwd apps/lifelog/packages/db db:generate` and commit the
  migration. Add a new migration rather than editing a committed one.
- **Test:** `bun run --cwd apps/lifelog/apps/server test`. Each test file gets its own SQLite file through `testDb()` in
  `src/testing.ts`.

## Worth knowing

- One process writes the file: a server holds `<file>.lock` (`@lifelog/db` `holdArchive`) and a second one exits before it
  migrates; scripts open it read-only
  (`connect(file, { readonly: true })`). Queries run
  synchronously: `.all()`, `.get()`, `.run()`, never `await` a query. A long synchronous pass holds every request,
  socket and long poll while it runs: keep passes incremental, and time a new full scan on a real-sized archive.
- The server runs on Windows too (checked by hand on a Windows PC): close a `connect` with `$client.close(true)` before removing or
  renaming its file, build paths with `join`, and keep audio keys and manifest paths in `/` (`keyPath`).
- A transaction is a synchronous function (Drizzle's bun-sqlite commits when it returns): never `async`, no `await`,
  every query through its `tx`, and no audio store, network or Mac call inside (they run before or after). Nothing runs
  while it does, so a check and its write in one transaction need no lock (`cutter.ts` `holderOf`).
- Raw SQL: bind instants as epoch ms, never a `Date` (bun:sqlite refuses it). Raw reads give ms, JSON text and 0/1;
  prefer a Drizzle select, and read one raw row as `db.all(…)[0]` (raw `db.get` returns bare values).
- `search_text` (FTS5) follows `search_passages` by rowid: never `VACUUM` without `insert into search_text(search_text)
  values ('rebuild')` after. A copy (`VACUUM INTO`: the daily snapshot, the export) is rebuilt where it is restored
  (`export.ts` `importArchive` does; so do the restore steps in `docs/transcription-server.md`), not when it is
  taken.
- `GET /status` scans the last day; the Mac host polls `GET /status/live` (`status.ts` `liveStatus`, the device
  token only), and `/status` is that plus the scans. Something cheap goes in the live part.
- `lifelog-server export|import <folder>` (`export.ts`, dispatched at the top of `index.ts`) moves the archive and its
  audio as a folder; with `RESTIC_*` set, the daily snapshot is a restic one of an export (`restic.ts`) instead of
  `snapshotArchive`. `docs/transcription-server.md` has both.
- The phone and readers (`docs/voice-source.md`) follow changes through `GET /changes` (`feed.ts`, by seq). A
  writer of anything the feed carries calls `logChange` last in its transaction. A new field goes in the feed, with a row in `docs/sync.md`.
  A pass that redoes only what changed reads `change-log.ts` `touchedSince` (conversation state, summaries, search, the
  naming queue): a write it must see logs its conversation or job.
- A reader's token opens only the routes `app.ts` lists in `READS` (and `CORRECTIONS`); a route for readers goes there
  and in `docs/voice-source.md`. The device token opens everything.
- A conversation's words are the turns that start inside its range (`transcript.ts` `loadTurns`, the
  `conversation_jobs` view); nothing else says which job belongs to which conversation.
- `fixtures/wire/` holds real answers, checked by `wire.test.ts` and decoded by Kit's `WireTests`; after a deliberate
  change to a shape run it with `WRITE_WIRE=1`; `fixtures/time-map.json` is read by
  both sides too, and so is `fixtures/fragments/` (the join's `joined.ogg`, rewritten by `WRITE_WIRE=1`). Cases only the server reads are in `apps/server/fixtures/` (grouping, speaker tokens), and so is the voice eval's baseline (`eval:voices` rewrites it).
- Events carry ids, states, counts and status codes, never transcript text. Every job's audio is kept in the audio store, a folder
  under `AUDIO_DIR` or an S3 bucket (`audio-store.ts`; keys are relative paths, never `..`): key
  `blocks/<sourceId>/<firstPage>-<sha>.ogg`, a joined job's too, `jobs/<sha256>.ogg` before blocks; a speech fragment's waits under `fragments/<sourceId>/<firstPage>-<sha>.ogg` until its block closes; a thin
  phone's raw pages are batches under `pages/<sourceId>/<firstPage>-<sha>.bin` (`pages.ts`);
  `apps/identity` gets excerpts for one request and keeps none.
