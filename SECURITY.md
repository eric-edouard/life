# Security

Life reads the most private data a person has: voice, messages, mail, notes. This page says what it protects, how,
and what it does not.

## Threat model

**Where the data is**

- Everything Life derives lives on the user's Mac: the data root (`truth/`, `memory/`) is a local git repository with
  no remote. The nightly commits there and refuses to commit to a repository that has one, so nothing is pushed.
- Raw data stays in its own app (Messages, Mail, WhatsApp, Beeper, Notes, lifelog); Life opens their stores read-only.
  The one copy it keeps is the archive (`~/Library/Application Support/Life/archive/`): messages deleted for everyone
  and old note versions.
- Backups are optional: restic snapshots, encrypted with a password kept in the Keychain, written to the folder the
  user sets (for example iCloud Drive).

**Secrets**

- Life.app keeps secrets in the macOS Keychain; a development checkout keeps them in `.env` (gitignored).
- Secret files Life writes are mode 600, and that mode keeps them out of every export and backup: the export's
  manifest lists them by name only.

**Models**

- Model calls run in an empty temporary folder, with no tools and no instruction files (Codex gets its own home), so
  recorded content reaches the model with nothing but the prompt.
- **Content is never a command.** What Life reads (messages, mail, notes, transcripts, files) is never an instruction
  to its code. The one exception is the user's spoken "hey Life" marker, which only keeps a conversation read; it never
  acts. Models return JSON validated by schemas, and every quote is checked against its source.
- The text Life reads is sent to the model provider the user chooses (Anthropic or OpenAI, through the user's own
  subscription's CLI or an API key the user provides). That provider's terms apply to it.

**Network surface**

- The connector (`/mcp`), the status page, the check page and the portrait are served by the Mac. Every request to the
  connector needs a signed token for the owner (Life's own OAuth server with pairing codes and PKCE, or a configured
  issuer). The pages check the owner's sign-in (or a password, for the portrait) before serving anything of theirs; the
  local port used by the app needs a local key and is never exposed.
- Exposure is through the user's tailnet (Tailscale Serve), optionally Tailscale Funnel or a Cloudflare tunnel the user
  controls, so cloud assistants can reach it.
- Life sends only: its report and alerts to the owner, one MCP event per ask to the owner's agent (callbacks on
  OpenAI's hosts only, verified first), and the status snapshot without the user's words (no message content) to an optional Worker.

**Actions**

- Life's code acts in one place: Apple Reminders, on the owner's explicit request (or a standing grant he turns on),
  every action logged. Nothing Life hears or reads makes it act by itself.

## Known risks

- **The agent is outside the boundary.** The owner's agent (for example ChatGPT with a terminal on the Mac) can read
  `.env`, the archive and `chat.db`, and send from the owner's accounts. Life's playbook asks it to send only on the
  owner's yes to the exact text, but that is policy, not enforcement. An unattended agent run reads other people's
  text with full access.
- Full Disk Access: Life needs it to read Messages, Mail and Notes, so the app is a high-value target on the Mac.
- Models may misread; observations are a model's reading with a checked quote, not verified facts.

## Reporting a vulnerability

Please report it privately through GitHub's "Report a vulnerability" (Security tab of this repository), not in a public
issue. Include what you found, how to reproduce it and its impact.
