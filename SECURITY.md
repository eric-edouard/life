# Security

Life reads the most private data a person has: voice, messages, mail, notes. This page says what it protects, how,
and what it does not.

## Threat model

### Where the data is

- Everything Life derives lives on the owner's Mac: the data root (`truth/`, `memory/`) is a local git repository with
  no remote. The nightly commits there and refuses to commit to a repository that has one, so nothing is pushed.
- Raw data stays in its own app (Messages, Mail, WhatsApp, Beeper, Notes, lifelog); Life opens their stores read-only.
  The one copy it keeps is the archive (`~/Library/Application Support/Life/archive/`): messages deleted for everyone
  and old note versions.
- Backups are optional: restic snapshots, encrypted with a password kept in the Keychain, written to the folder the
  owner sets (for example iCloud Drive).

### Secrets

- Life.app keeps secrets in the macOS Keychain; a development checkout keeps them in `.env` (gitignored).
- Secret files Life writes are named in one list (`SECRETS`, `apps/server/src/core/secret.ts`) and written mode 600; that list keeps
  them out of every export and backup: the export's manifest names them only.

### Models

- Model calls run in an empty temporary folder, with no tools and no instruction files (Codex gets its own home), so
  recorded content reaches the model with nothing but the prompt.
- Content is never a command. What Life reads (messages, mail, notes, transcripts, files) is never an instruction
  to its code. The one exception is the owner's spoken "hey Life" marker, which only keeps a conversation read; it never
  acts. Models return JSON validated by schemas, and every quote is checked against its source.
- The text Life reads is sent to the model provider the owner chooses (Anthropic or OpenAI, through the owner's own
  subscription's CLI or an API key the owner provides). That provider's terms apply to it.

### Network surface

- The connector (`/mcp`), the check page and the portrait are served by the Mac. Every request to the
  connector needs a signed token for the owner (Life's own OAuth server with pairing codes and PKCE, or a configured
  issuer). The pages check the owner's sign-in (or a password, for the portrait) before serving anything of theirs; the
  local port used by the app needs a local key and is never exposed.
- Exposure is through the owner's tailnet (Tailscale Serve), optionally Tailscale Funnel or a Cloudflare tunnel the
  owner controls, so cloud assistants can reach it. The owner's own install also has a Cloudflare Worker
  (`apps/edge/`) on his public address that passes each request as is to Funnel, until #137.

### Actions

- Life's code acts in one place: its one actions backend (Apple Reminders or Google Tasks), on the owner's explicit request (or a standing grant the owner turns
  on), every action logged. Nothing Life hears or reads makes it act by itself.

## What leaves the Mac

This is the one list; nothing else leaves.

- To the model provider the owner chose (Anthropic or OpenAI): the text Life reads, as described under Models.
- To an assistant the owner connected: what it reads through the connector, when it asks.
- The nightly report and the alerts, by email to the owner through Resend, when the `mail` setting is set (otherwise a
  macOS notification, which stays on the Mac).
- One MCP event per ask to the owner's agent, with the ask's words (callbacks on OpenAI's hosts only, verified first).
- The Past calendar, one event per past moment, to the owner's Google calendar, when the `past` setting names a Google
  account (without one it goes to an Apple calendar, which syncs as Calendar does).
- The to-do items Life writes (his clear to-dos and the agent's board), to Google Tasks, when the actions backend is
  Google (with Reminders they stay in his Apple account, which syncs as Reminders does).
- The owner's corrections about recordings, to the owner's own voice server.
- From the voice half (the iPhone and the voice server, in this repo since the playbook's step 1, unchanged by the
  move): speech blocks to ElevenLabs for transcription, the summaries' text to the owner's ChatGPT or Claude
  subscription through the Mac helper, passages and queries to OpenAI's embeddings when a key is set, and the
  encrypted restic backup. Details in [docs/voice/security.md](docs/voice/security.md) and
  [docs/voice/providers.md](docs/voice/providers.md).
- The encrypted backup, when the `backup` setting is set, to the folder the owner chose (which may sync, as iCloud
  Drive does).

## Known risks

- The agent is outside the boundary. The owner's agent (for example ChatGPT with a terminal on the Mac) can read
  `.env`, the archive and `chat.db`, and send from the owner's accounts. Life's playbook asks it to send only on the
  owner's yes to the exact text, but that is policy, not enforcement. An unattended agent run reads other people's
  text with full access.
- Full Disk Access: Life needs it to read Messages, Mail and Notes, so the app is a high-value target on the Mac.
- Models may misread; observations are a model's reading with a checked quote, not verified facts.

## Reporting a vulnerability

Please report it privately through GitHub's "Report a vulnerability" (Security tab of this repository), not in a public
issue. Include what you found, how to reproduce it and its impact.
