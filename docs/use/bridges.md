# Messaging bridges: read LINE, Instagram, Messenger, LinkedIn and Telegram

Life reads LINE, Instagram, Messenger, LinkedIn and Telegram through a bridge into its archive: a small program linked to your account as
one more device, like WhatsApp Web.

The bridges and their local Matrix server (Synapse) run on your Mac as one background job, talk to nothing but
their network, and keep running when Life is closed: the server holds every message, deleted ones included, until Life copies it. Linking a
bridge may be against a network's terms; for one personal account, bans are rare. LINE allows one
Chrome-extension session: linking its bridge logs LINE's Chrome extension out.

## One command

```sh
bun life bridge                         # every messaging connector checked at once: ✓ or ✗, and why
bun life bridge add <network>           # line, instagram, messenger, linkedin or telegram: builds it, then links it
bun life bridge link <network> [flow]   # links it again (another way to log in: its flow id, listed when linking)
bun life bridge remove <network>        # logs out and removes the bridge; what Life archived of it stays. With no bridge, a
                                        # network Beeper Desktop holds is copied from Beeper (turn its source back on)
```

`add` sets up the Matrix server the first time (it needs `uv` and `go`), builds the bridge at its newest release, and
runs it. `add` again rebuilds it at its newest release. `link` shows a QR code in the terminal, or asks for what the
network needs (your email and password, a code), hidden as you type. When a network needs your browser's cookies
(Instagram, Messenger, LinkedIn), it opens a Chrome window on the site: sign in as usual and it closes by itself once you're in
(a fresh profile of its own, deleted after, presenting itself as the browser the bridge claims to be: LinkedIn revokes
cookies another browser signed in for). Without Chrome, it asks you to paste one request ("Copy as cURL" from
the developer tools' Network tab); LinkedIn revokes those within minutes. A linked network is turned on as a
source; Life copies it once it restarts.

Telegram needs two keys of your own first, once: at https://my.telegram.org (log in with your phone number) open
"API development tools" and make an app; `link telegram` asks for its `api_id` and `api_hash` (the hash hidden as you
type) and writes them into the bridge's config. Until then the bridge isn't running, and `add` and the daily heal don't
wait for it. Then it logs in with your phone number and the code Telegram sends you (a QR code is the other way).

The bridges are also the only way Life sends: a card's draft (a message, or a file, a reply, a reaction, mentions, as
the chat allows: its bridge says), on your answer to its send option, goes as you into its
one chat through the network's bridge (Instagram, Messenger, LinkedIn, Telegram once linked, and WhatsApp, whose bridge
stays linked only for this: WhatsApp is read from its Mac app). A card can also start a one-to-one WhatsApp chat
with a number the bridge never saw, as `<digits>@s.whatsapp.net`: Life asks WhatsApp whether the number has an account.
A group the bridge never saw can't be opened. Other networks send only into a chat the bridge already holds. LINE (read from Beeper), iMessage and mail don't send.
