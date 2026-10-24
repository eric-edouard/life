# apps/mac-quiet

A LaunchAgent on the owner's Mac, a sensor and a runner: it reports on its socket which processes have the microphone
on and when the Mac sleeps, and runs the server's model calls with Codex or `claude -p` on the selected subscription,
reporting their raw output. `README.md` explains how it works and how to install it. The tested logic is in
`QuietCore`; test it with `swift test --package-path apps/lifelog/apps/mac-quiet --scratch-path .build/mac-quiet`. Its log is
`~/Library/Logs/lifelog-quiet.log`, and `bun run events mac` reads it alongside the server's events.

Rules live on the server, once: which apps are dictation and how events become quiet ranges (`dictation.ts`), what
a CLI's output means and the call's timeout (`mac-llm.ts`). The helper keeps only what must run on the machine: the
Core Audio and sleep readings, the outbox until acked, the empty folder and no-tools flags every call runs with, and
the subscription readings, filtered to percentages before they leave. The socket protocol is `macProtocol` here and
`MAC_PROTOCOL` on the server; change both together. Its token opens only its socket.

`LifelogHost` is the menu-bar app that runs all of lifelog on a Mac (`bun run host:app`, README "Lifelog Host"). Its
decisions are `QuietCore.Host` and `HostStatus` (the server's environment, the tunnel's arguments, `server.env`, the
status report the menu and window show, the export/import result) and `Summaries` (the helper's sign-in to ChatGPT
or Claude, shared with its `--setup-*` flags), tested. `HostModel` holds the settings and
says how each `Child` runs; `Supervisor` keeps the children alive; the views only show. Speaker recognition
(`apps/identity`) is a child too: `HostModel.installIdentity` installs it with the bundled `uv` once per launch,
started by `restart`, before the child runs. The app delegate owns the
only model. Its secrets share the helper's `secrets.json`, never the Keychain (`docs/decisions.md`); whoever writes
the file reads it first, so neither drops the other's fields. Its other settings are the app's defaults
(`HostSettings`).

Invariants: a child is stopped on purpose only through `Supervisor.halt`, which lets go of it before stopping it, so
its restart never fires; a Save or an import restarts every child, and every restart (the launch one too), Save,
import and export runs inside `HostModel.exclusive`, one at a time, except speaker recognition's install and its
restart of that one child, which touch nothing of the archive and would hold a Save for minutes; `/status` is
decoded section by section, so a server that adds or reshapes a field never blanks the menu; the menu reads
`/status/live` (owner token), the window `/status` (reader token).
