# Settings with no screen yet

How-to: turn on the parts of Life the app has no screen for: the email report, your code, older months and your
past assistant chats. Each takes a checkout of Life (`git clone https://github.com/eric-edouard/life.git`, then
`bun install`) and a Terminal.

Point the checkout at the app's data first, in the same Terminal. Without these two lines a command acts on the
checkout's own folders and the app never sees it:

```sh
export LIFE_OWNER_DATA_DIR="$HOME/Library/Application Support/Life/data"
export LIFE_STATE_DIR="$HOME/Library/Application Support/Life/state"
```

`bun life settings set` replaces each part you name as a whole, and leaves the others alone. After a change, quit Life
from its menu and open it again, so it reads the new settings.

## The report by email

By default the nightly report arrives as a notification. To get it by email you need a [Resend](https://resend.com)
account with a domain to send from. Keep its API key in the Keychain, where the app passes it to Life:

```sh
security add-generic-password -s Life -a RESEND_PERSONAL_API_KEY -w
bun life settings set '{"mail":{"from":"life@your-domain.com","to":"you@example.com"}}'
```

## Your code

Life can read the commits in every git repository under one folder. Turn on **Git** under **Sources** in Life's
settings, then name the folder:

```sh
bun life settings set '{"repos":"~/Code"}'
```

## Your devices in Screen Time

Life reads Screen Time from the Mac and from each iPhone or iPad that shares it. Turn on **Screen Time** under
**Sources**, then name each device by its id (the folders in `~/Library/Biome/streams/restricted/App.InFocus/remote/`);
one left out shows as "iOS device":

```sh
bun life settings set '{"devices":{"ED032E56-…":"iPhone Duo","33DF71A7-…":"iPhone 17"}}'
```

## Older months

```sh
bun life memory historical-units --from 2026-01-01 --to 2026-09-30
```

Each night reads the last 7 days. Older months can be collected for search without model calls, one month at a time;
their end must be before those 7 days. Omit the dates to collect every available month. Collection reports unavailable
sources and uncertain time zones. Historical model backfill is paused until its prompts are ready.

## History

```sh
bun life settings set '{"history":{"from":"2026-09"}}'
```

Off until you set it. Each night Life then summarises, once, every finished month from `from` on between you and each
person with a page, from your one-to-one chats and mail; a month is read again only when its messages change. Your
assistant sees it on each person's page. Before turning it on or moving `from` back, `bun life memory histories --from 2026-09` prints how many
people, months and model calls that is, calling no model.

## Your claude.ai and ChatGPT history

```sh
bun life settings set '{"backfillEngine":"codex"}'
bun life import ~/Downloads/claude-export --dry
bun life import ~/Downloads/claude-export
```

Download your data from claude.ai or ChatGPT and unzip it first (a large ChatGPT export comes as several
`conversations-000.json` files: Life reads them as one). The optional `backfillEngine` selects the runner for
imports and historical model backfills; without it those jobs are off. Codex uses your subscription quota, while an
API engine uses its paid credits. This setting leaves the nightly runner unchanged.

The dry run copies nothing and calls no model; it says what is new in the export. A newer export imports the same way:
Life keeps every export as it came, never replacing an older one, so a conversation you deleted in the app stays in Life.
Each conversation reads at its latest version, and the real import judges in batches of ten only the new conversations
and those whose beginning changed, resuming missing judgments when repeated. A failed Codex call waits for a retry.
Life collects the older messages it touched and updates search without reading them for facts. Any conversation, even
one Life did not keep, can be read back whole by its id.

Next: [back up and restore](backup.md).
