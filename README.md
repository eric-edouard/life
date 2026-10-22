<div align="center">

<img src="assets/icon/icon.svg" alt="Life" width="112" height="112" />

# Life

Ask Claude or ChatGPT about your own life. Life answers from your messages, mail, notes and, if you want, your voice,
and cites where each answer comes from.

[![License: MIT](https://img.shields.io/badge/license-MIT-1b1d1f.svg)](LICENSE)
![macOS 14+ on Apple silicon](https://img.shields.io/badge/macOS-14%2B%20·%20Apple%20silicon-1b1d1f.svg)

</div>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/readme/status-dark.png">
  <img src="assets/readme/status-light.png" alt="Life's status window: sources, capture, pipeline, memory and outputs, each as a card with its state.">
</picture>

<sub>The status window in Life.app, on made-up demo data before its first night.</sub>

## What it looks like

> **You:** What did I promise my landlord last week? Did I keep it?
>
> *Claude reads Life: `search landlord`, `search rent`, `day 2026-10-14`, `day 2026-10-18`*
>
> **Claude:** On 14 October you made two promises to your landlord, Jean Dupont, over WhatsApp. You kept both.
>
> 1. Pay the October rent by Friday 17 October. Kept, one day early. The promise (obs_99b039b6b84d): *"I'll send the
>    rent by Friday, sorry for the delay."* You paid on 16 October (obs_f36ccacbdafe): *"Done, the October rent is
>    sent."*
> 2. Be home on Saturday 18 October to let the plumber in. Kept. Hans came at 10:00 and fixed the sink
>    (obs_73b0b2b233a0): *"the drain pipe was cracked, I put in a new one."*
>
> Separately, Claire Dupont is due to send you the 2027 lease to sign by 31 October (obs_c64a9899753a).

This ran on made-up demo data: Claude Code, with Life's read commands as its only tool. Claude.ai and ChatGPT get the
same reads through Life's connector. Each `obs_…` id opens the fact and the message it was quoted from.

<!-- DRAFT: the owner rewrites this in his own words -->
## Why I built this

Most of what I need to remember I have already said or written somewhere: in a chat, an email, a note, a conversation.
I wanted something that reads all of it every night and keeps a memory I can ask, without me filing anything. It had
to stay on my own Mac, in a git repository of its own, and answer through the assistant I already use every day.

## What you need

Required:

- A Mac with Apple silicon on macOS 14 or later, which stays on and awake at night. Life runs there and nowhere else.
- A model to read with: a Claude or ChatGPT subscription (Life uses the `claude` or `codex` command line), or an
  Anthropic or OpenAI API key.
- [Tailscale](https://tailscale.com), signed in on the Mac. It is how Claude and ChatGPT reach Life; without it you can
  only ask from a terminal on the Mac.
- [Bun](https://bun.sh) 1.4 and Xcode's command line tools, to build the app. There is no prebuilt release yet.

Life reads iMessage, Mail, Apple Notes and your contacts with nothing else installed, once you give it Full Disk
Access. Each of these adds something if you have it:

- WhatsApp's Mac app: your WhatsApp chats, including messages later deleted for everyone.
- Beeper Desktop: LINE, Telegram and Instagram chats.
- lifelog, a companion project that records and transcribes your conversations from your phone: voice, where you were,
  and "hey <agent>" requests. It is not public yet. [Set up voice](docs/use/voice.md).
- Your code: the commits in every git repository under one folder (the `repos` setting).
- Your claude.ai and ChatGPT exports: what you told those assistants, read once with `bun life import <folder>`.
- [restic](https://restic.net): a daily encrypted backup, for example into iCloud Drive.
  [Back up and restore](docs/use/backup.md).
- A [Resend](https://resend.com) account: the nightly report by email instead of a notification.
- [remctl](https://github.com/viticci/remctl): Life changes Apple Reminders when you ask it to.

## Install

```sh
git clone https://github.com/eric-edouard/life.git
cd life
bun install
bun scripts/app.ts      # builds dist/Life.app, signed ad hoc
open dist/Life.app
```

Life's settings open on first launch. Enter your name and press Start Life. Then pick the model, turn on the sources
you want, and press Open Full Disk Access to allow Life there. Life lives in the menu bar from then on; turn on Open
Life at login so it starts with the Mac.

## What happens next

The archive starts at once: every 5 seconds it copies new WhatsApp, Beeper and Notes changes, so a message deleted
later, or an old version of a note, is kept. Nothing is ready to ask yet.

Tonight, on the first check after 2:00, Life reads the last 7 days from every source you turned on. It writes what
happened each day, the facts worth keeping, and a page for each person who matters to you. When it is done you get the
report, by email or as a notification. Tomorrow morning you can ask about last week.

From then on it reads again each night, and at 13:00 and 19:00 it reads the day so far. Older months come in through a
backfill: `bun life memory backfill --from 2026-01-01 --to 2026-09-30` from a checkout, read a week at a time, at most
four weeks a day, oldest first.

The cost is your model usage, nothing else. Each night makes up to one model call per day of the week it reads, then more
for the facts and pages that changed; the status window's engine card shows the tokens used this week. On a ChatGPT
subscription Life reads your Codex quota first and, above 75% used, skips the 13:00 and 19:00 passes and the backfill.
The nightly always runs.

## Connect your assistant

Your assistant reaches Life at an address on your Mac's Tailscale name, like
`https://your-mac.your-tailnet.ts.net/mcp`, and you approve it once with a pairing code shown on the Mac. Claude.ai,
the Claude apps and ChatGPT call from their makers' servers, so that address has to be public, through Tailscale
Funnel; Claude Code on your own devices can keep it private to your tailnet.

- [Connect Claude](docs/use/connect-claude.md) (Claude.ai, the Claude apps, Claude Code)
- [Connect ChatGPT](docs/use/connect-chatgpt.md)

## Where your data goes

Your memory is plain text in a git repository of its own, on your Mac, with no remote: Life commits to it every night
and never pushes. Raw messages stay in their apps. What leaves the Mac, and only that:

- the text Life reads, sent to the model you chose (Anthropic or OpenAI, through your own subscription's command line
  or an API key), with no tools and nothing but the prompt;
- what your assistant reads through the connector, when you ask it;
- the encrypted backup, if you set one up, to the folder you chose.

## Status and limitations

Life was built for one person and has one user so far. Its author uses it every day, and it shows: backups, email and
the backfill have no screen in the app yet, only commands.

The app is not signed with a Developer ID or notarized. You build it yourself, and macOS treats it as an app from an
unidentified developer.

The models misread. A fact can have the wrong person, the wrong day, or miss that something was done. Every fact
cites its source, so check it before you act on it, and tell your assistant when something is wrong: the correction is
kept and wins over the memory.

If you set up an agent (an assistant that acts on "hey <agent>" requests), it runs outside Life's boundary, with full
access to your Mac's terminal. [SECURITY.md](SECURITY.md) has the threat model and how to report a vulnerability.

## Docs

Use Life:

- [Connect Claude](docs/use/connect-claude.md) and [connect ChatGPT](docs/use/connect-chatgpt.md)
- [Set up voice](docs/use/voice.md)
- [Set up your agent](docs/use/agent.md)
- [Back up and restore](docs/use/backup.md)
- [Move to a new Mac](docs/use/move.md)

How Life works:

- [Architecture](docs/architecture.md): the pipeline, lifelog and Life, why memory stays local
- [Sources](docs/sources.md): what each source reads and how
- [Schema](docs/SCHEMA.md): every file in the memory
- [The agent, the connector and actions](docs/tasks.md)
- [Operations](docs/operations.md): schedule, services, backups, measuring, the read commands
- [Dashboard reads](docs/dashboard.md): the connector's JSON status reads, for developers

Develop:

- [AGENTS.md](AGENTS.md): rules for contributors and coding agents
- [Writing docs](docs/STYLE.md)
- [Building the app](app/README.md) and [releasing](docs/releasing.md)

## Development

```sh
bun install
bun run check                 # lint, types, tests, scrub and case checks: run before every commit
bun test src/memory/units.test.ts
bun life <command>            # the command line, from the checkout (src/cli.ts)
```

Tests run on made-up data (`src/test-data`), each run in its own temp folder. Point `LIFE_DATA` and `LIFE_STATE` at a
copy to experiment; never experiment on live data.

## License

[MIT](LICENSE)
