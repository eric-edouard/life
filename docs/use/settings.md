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

## Older months

Each night reads the last 7 days. To read further back, set a range; Life reads it a week at a time, oldest first, at
most four weeks a day, in the half-hourly checks once the night is done:

```sh
bun life memory backfill --from 2026-01-01 --to 2026-09-30
```

## Your claude.ai and ChatGPT history

Download your data from claude.ai or ChatGPT, unzip it, and import the folder once:

```sh
bun life import ~/Downloads/chatgpt-export
```

Life keeps only the conversations about your life. Set a backfill over their dates (above) to read them.

Next: [back up and restore](backup.md).
