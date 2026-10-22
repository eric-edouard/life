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
- [x] The switch (runbook below), 22 Oct.
- [ ] The connector on Life's own sign-in through Tailscale Funnel.
- [ ] T5 Delete the launchd setup; T6 delete the Cloudflare tunnel and the status Worker. Since #114 that Worker is
  the connector's whole edge (every path, to the Mac's Funnel on 8443, a bridge that keeps the URL): T6 moves the
  connector to `bun life connect --public` and deletes both (#133).

## The switch (runbook)

Nothing restarts between the export and the app's start, so nothing the old install writes is lost; the archive keeps
running until the app's takes over. `MAC` is `~/Library/Application Support/Life`; the app's helper is
`H="/Applications/Life.app/Contents/Helpers/life"` run with `LIFE_ROOT=/Applications/Life.app/Contents/Resources/life`,
`LIFE_DATA="$MAC/data"`, `LIFE_STATE="$MAC/state"` (never the app's own Import button, which starts it all at once).

1. **The checkout on the new code.** `launchctl disable` the nightly and the watcher
   (`gui/$UID/com.ericedouard.life.memory-nightly`, `…watch`: they don't come back at login); wait until
   `~/Life/.nightly.lock` is free (a tick finishes, never killed mid-commit); then `launchctl bootout` both. The
   archive keeps running. With `transition` merged into `main` on GitHub: `git -C ~/Work/life pull --ff-only`;
   `bun install`; add `"reminders": true` to `derived/settings.json`; `bun life validate`; `bun life act --check`
   (remctl ready).
2. **Export:** `bun life export ~/LifeExport-<date>` from the checkout, then at once `chmod -R a-w ~/Life`: a Claude
   session's `bun life correct` or `act` meanwhile fails loudly instead of landing in a copy the app never reads.
3. **Life.app** built (`bun scripts/app.ts`) into /Applications. By his hand: `scripts/keychain-from-env.sh` (the
   Keychain items of service `Life` from `.env`, readable by Life.app without a prompt; names only printed), and Full
   Disk Access, Automation and Contacts for Life.app.
4. **Import** with the helper as above: `$H import ~/LifeExport-<date>` (the archive is kept as it is: the same
   folder), then `$H memory index`; copy `derived/events.json` (and `derived/oauth/` when there is one) to `$MAC/state/`
   with their modes (`cp -pR`), so Atlas keeps its subscription.
5. **One live copy:** `~/Life` becomes `~/Life.before-app` and `~/Work/life/derived` moves out of the repo to
   `$MAC/derived.before-app` (never committed), both read-only for 30 days, then removed with `~/LifeExport-<date>`
   (gigabytes); `~/Life` and `~/Work/life/derived` become links to `$MAC/data` and `$MAC/state`.
6. **Start:** `launchctl disable` and `bootout` the archive, then launch Life.app (Reminders on, login item); its
   archive takes the lock. Check: the status page's cards as before, the watcher polling, both locks in `MAC` held by
   the app, `actions: remctl ready`, the connector's tools in ChatGPT, the next nightly's report and backup.
7. **Rollback, nothing lost:** turn off Life.app's "Open Life at login" and quit it; keep the links; `launchctl enable`
   and `bootstrap` the three jobs: the checkout runs the same code on the same live copy. The `.before-app` folders
   matter only if the import itself was wrong.

Debt until T5: the secrets live in both `.env` (the checkout) and the Keychain (the app).

Later, separately: ChatGPT and Claude to Life's own sign-in through Tailscale Funnel (the costly reconnect), then T6.
