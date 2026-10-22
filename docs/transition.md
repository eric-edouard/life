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

## The switch (runbook, filled in by T3/T4)

1. Stop the three `com.ericedouard.life.*` jobs; export; put the secrets in the Keychain (service `Life`) by hand.
   `transition` reaches `main` only as part of this step: his settings get `"reminders": true` (R0: off by default;
   the old code's strict schema refuses the key, so not before) in the same step, then the watcher restarts.
2. Launch Life.app, import; check the counts equal the export's, the cards match, the watcher and archive run.
3. Reconnect ChatGPT and Claude with a pairing code to the Funnel address (asks wait unsent meanwhile).
4. Keep `~/Life` and `derived/` read-only 30 days. Rollback: quit the app, start the old jobs on the app's folders.
