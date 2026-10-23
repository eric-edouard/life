# dictation-sensor

A small Mac helper. When you talk to the Mac (FluidVoice, Wispr Flow, Handy, Superwhisper,
the voice input of Claude, ChatGPT or Codex, Claude Code's `/voice`), the Pendant hears it too.
The helper tells the voice server when each dictation happened, and the phone leaves that audio out of
transcription. Dictation the phone already transcribed (the Mac was offline) is hidden from transcripts and search.

How it works: macOS knows which process has the microphone open. The helper watches that flag for every process
using audio and, whenever the set capturing changes, sends it on its socket; before the Mac sleeps it says so. That
is all it decides: the server's rules (`apps/voice/src/dictation.ts`, `docs/voice/sync.md`) turn those facts into quiet
ranges. Only dictation apps count; calls (FaceTime, WhatsApp, a browser) are conversations. Each dictation is padded
1 s before and 1.5 s after, dictations less than 5 s apart are one, one over 10 minutes or cut by sleep is dropped,
and a flag still on after 10 minutes stops holding the phone back. The server names only dictation apps and counts
the others; the helper's log (`capturing: …`) names every app it sees, so a missing dictation app shows up there. It
needs no microphone permission. A cancelled dictation counts like any other: the flag can't tell them apart. Core
Audio says when a process's flag changes; a read of every flag each second backs it up, since it once missed some.

Events the server hasn't acked wait in `~/Library/Application Support/lifelog-quiet/outbox.json`, each with its
`seq`, and go again, in order, on every new socket and every 30 s ping, until the ack comes: a sensor never loses
one. Each socket waits for the server's welcome (the last seq it applied); a file no welcome has numbered yet (a lost
one) goes above it, so it never reads as a resend. A server that can't apply one holds the phone back from there
until one applies. One it refuses as invalid is logged (`the server refused event …`) and dropped, and the capture set
follows at once; the server keeps the span from the block to it as a quiet range of unknown source. If the log shows the same event refused again and
again, stop the helper, delete that event from `outbox.json`, and start it: the hold clears once the next good event
applies.

Moving from the helper that sent ranges (protocol 1): let a dictation finish and wait for the log to show its range
acked, stop the old helper, update the server, then install this one. Voice Host ships both, so updating Host does
it in that order. Any ranges still in the old `outbox.json` go as the events that make them, and the server holds
the phone back from where the old helper left it until this one speaks.

It keeps one WebSocket open to the server, with the Mac's token, for events and model calls, at protocol 2; a server
of another protocol refuses it (the log says `426`), so update both together. Each socket starts with the outbox,
then a hello. While the socket is open, the server vouches for the Mac up to now, or up to a dictation not yet a range;
when it closes (sleep, offline, crash), up to the last moment it heard from it. On waking it opens a new one. A ping
every 30 s finds a dead socket; it reconnects after 1 s, doubling up to a minute, and at once when the network comes
back. Most drops are the server restarting, back within seconds. The server transcribes a block only once the Mac
vouched for it, so dictated audio never reaches a provider. If it hasn't heard from the Mac for 2 hours (it is off,
or the helper is removed), it goes on without it.

The server also uses the socket to run its model calls (chapters, summaries, titles) on your selected ChatGPT or Claude
subscription. ChatGPT uses Codex with GPT-6.1 Sol at the effort the server asks (medium). The helper has a separate
Codex home at `~/Library/Application Support/lifelog-quiet/codex`, so personal recordings do not load your engineering
rules, skills, plugins or tools. Codex runs with `--ephemeral --ignore-user-config --ignore-rules`, a read-only
sandbox, disabled tools and web search, and the server's JSON schema.

When Claude is selected, for each `llm` message the helper runs Claude Code in an empty temp folder, with no tools, settings or MCP
servers:

```sh
claude -p --model <model> --system-prompt <system> --tools "" --strict-mcp-config --setting-sources "" \
  --no-session-persistence --output-format json --json-schema <schema>   # prompt on stdin
```

Those flags are the helper's own, whatever the server asks. It runs each call it gets (the server sends at most 4 at
once) and kills it at the call's timeout (170 s). It sends back the CLI's raw output and exit status, and the server
reads what it means (an answer, or `auth`, `limit`, `timeout`, `failed`). The output goes back on the socket that sent
the call; if it closed, calls under way go on and their output goes out on the next socket, where the server keeps it.
Each call writes one line to the log.

On power, the helper holds off idle sleep (an `IOPMAssertion`), so summaries run while you are away from the Mac. The
screen still sleeps, and closing the lid still sleeps the Mac. On battery, macOS decides. `pmset -g assertions` lists
it as "Life: summaries run while the Mac is on power".

## Subscription widgets

The helper reports subscription limits over its existing socket every five minutes while awake and connected.
Codex uses the dedicated login from `--setup-codex` and the documented `account/rateLimits/read` app-server request.
It starts no thread and generates no tokens. The dial describes Codex's ChatGPT quota, not all ChatGPT features.

Claude's `setup-token` cannot read account usage (it lacks `user:profile`). Use Claude Code's documented status-line
payload instead; no cookie scraping, extra model requests or credentials copied to the server. Install this bridge
beside the helper, then add it to the `statusLine.command` in your Claude Code settings:

```sh
cp apps/dictation/claude-usage-statusline.sh ~/.local/bin/lifelog-claude-usage
chmod 700 ~/.local/bin/lifelog-claude-usage
```

```json
{"statusLine":{"type":"command","command":"~/.local/bin/lifelog-claude-usage"}}
```

If you already have a status-line renderer, preserve it by passing its command as arguments to the bridge, for
example `~/.local/bin/lifelog-claude-usage sh -c 'your existing command'`. The bridge passes the original input to
that renderer unchanged. It does not install or replace your settings automatically.

After the first response in an interactive Pro or Max session, the bridge stores only `rate_limits.five_hour` and
`rate_limits.seven_day` as percentages, reset times and an observation time, in the owner-only
`~/Library/Application Support/lifelog-quiet/claude-usage.json`. The helper picks it up within five minutes.
Without a running session or a new status-line observation, the last reading ages honestly. The existing isolated
summary subprocesses still load no personal settings, status-line scripts or tools.

How the dials show it: `docs/voice/design.md`.

Sources: [Codex account limits](https://developers.openai.com/codex/app-server),
[Claude Code status-line fields](https://code.claude.com/docs/en/statusline),
[setup-token scope limitation](https://github.com/anthropics/claude-code/issues/24200),
[WidgetKit refresh budgets](https://developer.apple.com/documentation/widgetkit/keeping-a-widget-up-to-date).

## Voice Host (the voice server on your own Mac)

`Voice Host.app` runs the voice half on a Mac: a menu-bar app with the server, this helper,
`cloudflared`, `restic`, `codex` and `uv` inside it (`Contents/Helpers`), and speaker recognition (`apps/speech`),
which it installs itself.

### Setting it up (for a friend)

1. Get an ElevenLabs API key (elevenlabs.io, Developers, API keys) and, if you want search by meaning, an OpenAI one.
2. For the phone to reach the Mac, either install Tailscale on the Mac and the iPhone and sign in to the same account
   on both (free), or, with a domain on Cloudflare, create a tunnel in Zero Trust (Networks, Tunnels), copy its
   token and route your address to `http://127.0.0.1:47613`.
3. Build it with `bun run host:app` (prebuilt, notarized releases are not published yet; "Building it" below), move
   `Voice Host.app` to Applications and open it. Settings opens by itself until it is set up. A Mac that had `Lifelog Host.app` (the same app, same bundle id) removes it first.
4. Paste the keys, choose how your phone reaches this Mac, then **Start fresh**, or **Import an export…** to bring
   an archive from another Mac. Voice Host starts and opens at login from then on.
5. Under **Summaries**, sign the helper in to your subscription: **Sign in to ChatGPT…** (in the browser, with the
   Codex inside the app), or for Claude, with Claude Code installed, run `claude setup-token` in Terminal and paste
   the token it prints. Once it runs, **Run on** picks the one summaries use; saving a Claude token restarts the helper.
6. Settings now shows a QR code: open the Camera on the iPhone (with Life installed) and point it at it. There is
   no built-in server: a phone pairs only this way.
7. Optional: turn on **Back up to iCloud Drive every day**, then **Copy the backup password** into your password
   manager. Without it nobody can read the backup.

The ring-and-dot in the menu bar says "Voice Host: all good" or how many things to look at, then one line each: what
waits to be transcribed, what is at ElevenLabs, the AI pass (running, waiting, blocked), the Pendant, the phone, the
Mac helper, speaker recognition (off, failing, or when it last answered), ElevenLabs credits and the backup. **Open
status…** shows all of it in full, with the last day's problems, the archive's checks, and Host's processes with their
logs.

### Restoring a backup

The backup's password is `resticPassword` in `~/Library/Application Support/lifelog-quiet/secrets.json`; **Copy the
backup password** copies it, so keep it somewhere safe. If `secrets.json` is lost (a new Mac), put the saved password
back there as `resticPassword` before turning backups on, or the new backups go nowhere the old ones can be read.
To restore, take the export out of the latest snapshot into a new folder (restic asks for the password), then
**Import an export…** that folder (`~/voice-restore`) into a new install. The server backs up its staging folder
by its full path, `<home>/Library/Application Support/lifelog/restic-staging`, so name that path after `latest:`
(checked with restic 0.19.1); from another account than the one backed up, use that account's home, which
`restic snapshots` shows:

```sh
"/Applications/Voice Host.app/Contents/Helpers/restic" \
  -r "$HOME/Library/Mobile Documents/com~apple~CloudDocs/lifelog backup/restic" \
  restore "latest:$HOME/Library/Application Support/lifelog/restic-staging" --target ~/voice-restore
```

### How it works

- The archive and audio live in `~/Library/Application Support/lifelog`; logs in `~/Library/Logs/lifelog-*.log`
  (server, quiet, tunnel, identity). `Supervisor` starts each process again 5 s after it stops, with its environment
  read anew; a Save or an import starts them all again on the new settings. While Voice Host runs the Mac doesn't idle-sleep
  (like `caffeinate -i`); the screen still sleeps.
- The keys, the tunnel token, the backup password and speaker recognition's secret are in the helper's
  `secrets.json` (mode 0600, never the Keychain). Host mints the phone's, the helper's and a reader's token, the
  backup password and `identitySecret` there once, keeping
  any already in it; the server gets only the tokens' hashes. Other choices (how phones reach the Mac, the domain,
  backups and speaker recognition on or off) are in the app's defaults.
- Keys Host doesn't manage (APNs, Resend and `ALERT_EMAIL_FROM`/`_TO`, `AUTH_SECRET` and `LIFE_URL`, webhook id and
  secret…) go in
  `~/Library/Application Support/lifelog/server.env`, `KEY='value'` lines, mode 0600 (the server won't start if
  others can read it). The server gets them under Host's own, which win; a key Host manages (restic's, speaker
  recognition's) is ignored there even while Host leaves it unset.
- The server listens on 127.0.0.1 only, and refuses to start while another server holds its archive.
- **On my tailnet**: Host runs `tailscale serve` (never Funnel), so the server answers at the Mac's tailnet name over
  HTTPS; switching to a domain turns Serve off. **My own domain**: Host runs `cloudflared tunnel --no-autoupdate
  --protocol http2 --edge-ip-version 4 run --url http://127.0.0.1:47613`, the token in its environment
  (`TUNNEL_TOKEN`) so `ps` never shows it.
- Speaker recognition (Settings, **Recognize speakers by their voice**, on by default): the app carries
  `apps/speech`'s `app.py`, `pyproject.toml` and `uv.lock` in `Contents/Resources/identity`. Once per launch Host
  runs `uv sync --frozen` and `app.py download` into `~/Library/Application Support/lifelog/identity` (the venv, uv's
  own Python 3.12, the models with Parakeet on MLX; about 3 GB the first time, seconds after; the service holds
  about 3 GB of memory), then runs the service on
  `127.0.0.1:47614`. Until it is installed, or if it fails, the reason shows under the menu and Settings, and Save
  tries again. The server gets `IDENTITY_URL` and `IDENTITY_SECRET` (minted once into `secrets.json`); off, it gets
  neither and names no voices, and the menu says "Speaker recognition: off".
- Backups: the server runs restic into `iCloud Drive/lifelog backup/restic` when Host gives it `RESTIC_REPOSITORY`,
  `RESTIC_PASSWORD` and `RESTIC_BINARY`; its last snapshot or error is in its status.
- The menu reads `/status/live` every 30 s with the phone's token; the status window reads the full `/status` with
  the reader's token when it opens and on "Check now".
- Export everything… runs `voice-server export <folder>` while the server runs; Import stops the server and runs
  `voice-server import <folder>`, all or nothing (the server refuses an install that isn't empty). Both get only
  `DATABASE_PATH` and `AUDIO_DIR`, and show the result in words.
- "Copy Life's voice settings" copies the address and the reader's token.
- Unload the LaunchAgent below before using it: the host runs its own helper.

### Building it

`bun run host:app [out]` builds into `.build/host`. It needs Xcode and Homebrew's `librsvg` (`brew install librsvg`,
for `rsvg-convert`, which draws the menu-bar icon). Set `LIFE_SIGN_IDENTITY` to sign with a Developer ID and
`VOICE_HOST_VERSION` for its version. cloudflared, restic, Codex and uv come from their GitHub releases, pinned by sha256; a
download that doesn't match is refused.

## Install (without Voice Host)

Voice Host runs its own helper with its own token; these steps are for a helper beside a server you run some other
way.

1. Mint the Mac's token and give the server its hash. The token opens only the helper's socket, never the phone's
   routes.

   ```sh
   bun run --cwd apps/voice mint-token mac   # prints the token and MAC_TOKEN_HASH=<its hash>
   ```

   Put `MAC_TOKEN_HASH` in the server's environment.

   Restart the server with it. Keep the token for step 3 and nowhere else.

2. Build and install the helper:

   ```sh
   cd apps/dictation   # from the checkout
   swift build -c release
   mkdir -p ~/.local/bin ~/Library/LaunchAgents
   cp .build/release/dictation-sensor ~/.local/bin/lifelog-quiet
   sed -e "s|__HOME__|$HOME|g" -e "s|__SERVER__|https://your-server.example|g" com.lifelog.quiet.plist \
     > ~/Library/LaunchAgents/com.lifelog.quiet.plist   # your server's address: the helper needs LIFELOG_URL
   ```

3. Put the token in the helper's secrets file, owner-only (the helper refuses to start if others can read it, and
   keeps it in memory, so restart it after changing it):

   ```sh
   mkdir -p -m 700 ~/Library/Application\ Support/lifelog-quiet
   (umask 077; printf '{"macToken":"%s"}\n' '<the token>' > ~/Library/Application\ Support/lifelog-quiet/secrets.json)
   ```

4. Sign the helper in to Claude, once a year. `claude setup-token` opens the browser and prints a token that
   lasts a year. Paste it into the installed helper, which keeps it in `secrets.json` as `claudeToken`:

   ```sh
   claude setup-token
   ~/.local/bin/lifelog-quiet --setup-claude-token
   ```

   Run it again when the log says `auth`. Until then, the server's model calls wait. There is no API fallback.

   For ChatGPT, install Codex CLI 0.162.1 or newer. The helper prefers a separate runtime over a global CLI:

   ```sh
   mkdir -p "$HOME/Library/Application Support/lifelog-quiet/codex-runtime"
   cd "$HOME/Library/Application Support/lifelog-quiet/codex-runtime"
   bun add --exact @openai/codex@0.162.1
   ```

   Then sign in the helper once, in the browser:

   ```sh
   ~/.local/bin/lifelog-quiet --setup-codex
   bun run switches engine codex   # from the checkout
   ```

   This uses your ChatGPT subscription through a dedicated login, with no API key. To choose Claude again, use
   Settings → Processing → AI model or `bun run switches engine claude`. Each engine keeps its own auth or limit hold, so
   switching away from one at its limit lets waiting work resume on the other. Valid summaries stay as they are.

5. Start it (it also starts at every login):

   ```sh
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.lifelog.quiet.plist
   ```

## Check

- `~/.local/bin/lifelog-quiet --list` shows every app using audio and whether it is capturing. Dictate while it runs
  and your app should read `capturing`.
- `tail -f ~/Library/Logs/lifelog-quiet.log` shows one line each time the processes capturing change, and one line
  per model call: its id, time and exit status. What each meant is on the server: `bun run events mac` (`mac.event`,
  `quiet_range.stored`, `mac.llm`, `mac.llm_error`). Plugging in or
  unplugging writes "on power: idle sleep held off" or "on battery: idle sleep allowed".

## Update or remove

Update the server and the helper together: a server of another socket protocol refuses the helper (`426` in its
log). After a rebuild, copy the binary again and restart it. Nothing asks for a password: the secrets are in a file,
not the Keychain. A LaunchAgent installed before the helper needed `LIFELOG_URL` must be rendered again first (Install,
step 2, with `__SERVER__`), or the new helper won't start.

```sh
rm ~/.local/bin/lifelog-quiet && cp .build/release/dictation-sensor ~/.local/bin/lifelog-quiet
launchctl kickstart -k gui/$(id -u)/com.lifelog.quiet
```

Remove the old binary first: copying over it in place keeps its file, whose signature macOS has cached, and launchd
then refuses to start it (`OS_REASON_CODESIGNING`).

To remove it:

```sh
launchctl bootout gui/$(id -u)/com.lifelog.quiet
rm ~/Library/LaunchAgents/com.lifelog.quiet.plist ~/.local/bin/lifelog-quiet
rm ~/Library/Application\ Support/lifelog-quiet/secrets.json
security delete-generic-password -s lifelog-quiet -a mac-token    # old Keychain items, if still there
security delete-generic-password -s lifelog-quiet -a claude-token
```

To add another dictation app, add its bundle id (as `--list` prints it, or as the log names it) to
`DICTATION_APPS` in `apps/voice/src/dictation.ts`; a command-line tool goes by its process name. Only the server changes.
