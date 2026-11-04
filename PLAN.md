# Screen Time as a source

What it is: the time the owner spent in each app and website on his Mac and iOS devices, as Apple records it. What it
is not: what he did inside an app, anyone's words, or page content. It answers "when was I at which device, doing
what kind of thing", and gives moments real times. Picks up life#82 (parked 21 Oct, his "scope it" of 4 Nov).

## What the Mac holds (checked 4 Nov)

- `~/Library/Biome/streams/restricted/App.InFocus/local/`: the Mac's app focus changes, about 1,100 a day.
- `App.InFocus/remote/<device>/`: the same for each iOS device, synced over iCloud. Two are live: `33DF…` and
  `ED03…`. `~/Library/Biome/sync/sync.db` `DevicePeer` gives each device's platform (2 = iOS, 3 = macOS) but no name.
- `App.WebUsage/local/`: Safari's web use, with the domain and the full address.
- `App.MediaUsage/local/`: what was playing.
- All of them are SEGB v2 files: a 32-byte header, records of protobuf, and a table at the file's end of 16-byte
  entries (`end offset`, `state`: 1 kept, 3 pruned, `time` in seconds since 2001). Decoded by hand on his files.
- **Apple prunes them:** the iPhone's oldest kept record is from 27 Oct and the Mac's from 31 Oct. Every day without the
  copy loses a day.
- `knowledgeC.db` is left out: Biome holds the same, and it is one format to read.

## M1: copy, read, cut

- [ ] Reshape first: `isActivity(kind)` in `contract.ts` ("what his devices record he did, never anyone's words"),
      replacing the two repo checks that mean that (`moments.ts:179` cap at 1, `extract.ts:100` never extracted).
      `units.ts:619` stays: it keeps out repo's two-argument `read`, and screen has no `searchDays`, so no table reads
      it. Pure refactor, its own commit.
- [ ] `sources/screen.ts`: `parseSegb(bytes)` (header, entry table, kept records only) and the protobuf fields each
      stream needs: bundle id, start or end, domain, media title. ~100 lines.
- [ ] `copyScreen` (the `store.copy` of the descriptor): every 5 s with the archive, it reads only Biome files whose
      size changed since its last look and inserts their kept records into `archive/screen.sqlite` (`events`:
      device, stream, bundle, app name, domain, title, at, ending, seenAt), `unique(device, stream, at, bundle)` with
      insert-or-ignore: no resume point, and a record an iPhone syncs late with an older time still lands. Raw, every
      record, nothing filtered: rules change later, the copy can't be made again. The app name is stored at copy time
      (the Mac's `CFBundleName`, else the bundle id), so a removed app never changes an old unit's hash.
- [ ] Reshape: `AppStore.media` becomes optional; `archive deleted` (`archive.ts:77,105`) skips a store without it.
      Notes drops its `media: "''"` (`sources.ts:123`). Screen Time has no deleted view.
- [ ] `readScreen(since)`: the archive's events as `SourceEvent`s, one per stint (one stretch of time in one app;
      new glossary word, since "session" is a Claude session): the same app on the same device merged when focus
      comes back within 2 minutes. Chat = the device's Biome id, the Mac's own from `sync.db` (`me` = 1), so two Macs
      never merge.
- [ ] The descriptor in `SOURCES`: name `screen`, label "Screen Time", kind `screen`, `macOnly`, `store` (no `app`:
      the system writes Biome), `newest` with one part per device, `silentAfter` 24 h. No `missing`: `SOURCES` gives
      every archived source its own (`sources.ts:177`). `screen` in `SourceName`.
- [ ] Settings: `devices` (Biome device id → what he calls it: "iPhone", "iPad"), code first, no owner value in code; a
      device without a name shows its platform. Turn `screen` on in his `sources` once his OK on decision 1 is in.
- [ ] The day cut, `screenDay` (`units.ts:341`, next to `repoDay`): one unit per device and local day. Its lines:
      stints of 5 minutes or more (`09:02–10:40 Claude`); each app's day total; domains with 5 minutes or more;
      what was playing. Left out: stints under a minute (they still count in the totals), the home and lock screens,
      Finder, System Settings, the screen saver, Life itself. Call screens stay. Title: `iPhone: 3 h 10 min, Instagram 1 h`.
- [ ] Tests, made-up data: a SEGB file built in the test (kept and pruned records), the copy run twice (no duplicate),
      `screenDay`'s merge and filter rules.
- [ ] Docs: `sources.md` row (and its "Not used yet" row goes), glossary: `kind` line (`screen`), its source list,
      `activity`, `stint`, `devices`; `SCHEMA.md` for `screen.sqlite`; `architecture.md` archive list;
      `roadmap.md:81`'s line goes.
- [ ] Measure (`docs/operations.md`, "Measuring"): moments on one truth-set day (`~/Life/docs/evals/truth-2026-11-03.json`)
      with and without screen units, on a copy of the data.

## Left out

Full addresses and Safari's page titles (`History.db`): domains only; add when "what was I reading at 15:00" is asked.
Notifications: their messages already come through the chat sources. Categories (work, social, video): the models
read app names; a table when a weekly "where time went" view is built. knowledgeC.

## Decisions for the owner

1. The new archive file `screen.sqlite` (archive rule: a new table needs his OK).
2. Which device is `33DF…` and which is `ED03…` (an iPhone, an iPad?): the `devices` setting's two names.
3. The moments prompt: no bump now (his 80/20 rule); screen units reach moments with the code cap at 1, and the moments
   rework (4 Nov) writes their line ("when he was at a device; never a moment alone") into its new prompt.

## Golden rule plan
Inventory: `rg -n '"repo"|kindOf\(|kind ===' apps/server/src`; `rg -n 'store\.|ARCHIVED|deletedIn' apps/server/src/host/archive.ts`; `rg -in 'screen|biome|segb' apps/server/src docs`.
The places that decide what this touches: source names `core/names.ts:21`; kinds `sources/contract.ts:66,72`; the
registry `memory/sources.ts:51`; the archived stores `AppStore` `contract.ts:22`, `archive.ts:77,105` (the `deleted`
view every store has); the day cut `units.ts:341` (`repoDay` `units.ts:462`); "not words" checks `moments.ts:179`,
`extract.ts:100`; git-only checks that stay git's `units.ts:619,654` (its two-argument read),
`memory/repos.ts:227`, `snapshot.ts:281`; glossary `docs/glossary.md:46`. Nothing reads Biome or knowledgeC today.
Shape: Screen Time is one more archived source, like Notes: Apple's store → the archive's copy → a reader → day units.
The one rule "activity is never extracted, never words, importance ≤1" moves into `isActivity` before the source lands,
so git and screen share it instead of a second `|| kind === "screen"` in two places. `AppStore.media` turns optional
rather than Screen Time faking a `deleted` view.
State: `archive/screen.sqlite`, owned by `copyScreen`, per event, its unique key the only dedupe (no resume point);
the size check per file lives in memory only. `devices`, in settings, global (his names for his devices).
Deletes: two `kind === "repo"` checks (now `isActivity`), Notes' `media: "''"`, `sources.md`'s "Screen Time / Biome"
row, `roadmap.md:81`, life#82 closes.
Net lines: about +320 / −12 (parser 100, copy 55, reader and cut 80, descriptor and setting 15, tests 80).
Plan review: reshape, all applied: `isActivity` on two checks, not `units.ts:619`; `media` optional instead of an empty
`deleted` view; a unique key replaces the resume point (late iPhone syncs); no dead `missing`; the `devices` setting
and turning `screen` on named; "stint" instead of "session"; the app name stored at copy time; roadmap and glossary
source list in the deletes.
