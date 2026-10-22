# Transition

The owner moves from the developer setup (this checkout under launchd, `~/Life`, `derived/`) to Life.app, as a friend
runs it, with nothing lost. His decisions (22 Oct): Life.app only after the move; Tailscale Funnel, no Cloudflare;
lifelog moves to his Mac now (Lifelog Host), its speaker recognition after; Reminders is an optional plugin, input and
output, and its backend is `remctl` for everyone, with every feature it has today.

How it lands: an integration branch `transition`, one PR into it per item, each merged only after a passing golden-rule
review (`debt-review`), and `transition` into `main` on his OK.

## Items, in order

- [x] T1 One Life per Mac: the archive and the watcher each hold a lock in `~/Library/Application Support/Life` (shared
  by every install), so a second copy waits; the status page reads those locks, not launchd.
- [x] R0 Reminders as an optional plugin (a setting, like a source): off, nothing touches Reminders (no minute pass, no
  board, no reading back, no `reminders`/`open_reminders` tools, no grant) and the rest of Life runs as before.
- [x] R1 The plugin's backend is `remctl` (MIT, github.com/viticci/remctl), pinned by version and checksum and installed
  by its own installer from the app's setup; `life-eventkit` keeps only its calendar.
- [x] T2 Status parity: the app shows the status page's truth from the same plate (its headline and every card not ok
  in the menu, the whole page in a window), read through the helper, served locally without a connector.
- [x] T3 Export: the backup's staging, extended to everything Life holds, with a manifest (every file's size and
  sha256) and counts; secrets never exported, only named. `life export <dir>` and the app's Export…; the backup is
  restic of that same folder.
- [x] T4 Import: one `life import <dir>` (a Life export, verified by its manifest, never over existing data, never
  writing to an existing archive; or an assistant export, what `memory import` was), also in the app's first run.
- [ ] The switch (runbook below), then the connector on Life's own sign-in through Tailscale Funnel.
- [ ] T5 Delete the launchd setup; T6 delete the Cloudflare tunnel and the status Worker.

## The switch (runbook)

Nothing restarts between the export and the app's start, so nothing the old install writes is lost.

1. **The checkout on the new code.** Wait until memory's lock is free; `launchctl bootout` the three
   `com.ericedouard.life.*` jobs; pull `~/Work/life` (now with `transition`); `bun install`; add `"reminders": true` to
   `derived/settings.json` (off by default, and the old code's strict schema refused the key); `bun life validate` and
   `bun life act --check` (remctl ready). The jobs stay stopped.
2. **Export:** `bun life export ~/LifeExport-<date>` from the checkout.
3. **Life.app** built (`bun scripts/app.ts`) into /Applications. By his hand: the Keychain items of service `Life`,
   each named as in `.env` (the manifest's `leftOut.env`; a script he runs, never in chat), and Full Disk Access,
   Automation and Contacts for Life.app.
4. **Import** with the app's folders (its helper, `LIFE_DATA`/`LIFE_STATE` under `MAC`): `life import`, then
   `life memory index`. The archive is kept as it is (same folder). Copy the secrets the export leaves out from
   `derived/` to `MAC/state` (Life's sign-in, the agent's subscription), so nothing reconnects.
5. **One place for his data:** `~/Life` becomes `~/Life.before-app` and `derived/` `derived.before-app`, both read-only
   for 30 days; `~/Life` and `~/Work/life/derived` become links to `MAC/data` and `MAC/state`, so `bun life …` from the
   checkout, `isHis` and his Claude sessions keep reading and writing the one live copy.
6. **Launch Life.app** (Reminders on, login item). Check: the status page's cards as before, the watcher polling,
   both locks in `MAC`, `actions: remctl ready`, the connector's tools in ChatGPT, the next nightly's report and
   backup.
7. **Rollback:** quit the app; remove the two links and rename the `.before-app` folders back; `launchctl bootstrap` the
   three jobs. What the app wrote meanwhile stays in `MAC/data` and `MAC/state`.

Later, separately: ChatGPT and Claude to Life's own sign-in through Tailscale Funnel (the costly reconnect), then T6.
