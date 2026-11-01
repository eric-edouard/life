# Messaging bridges: send replies, read LINE, Instagram and LinkedIn

Life can send the reply you chose on a decision card, as you, into the chat it answers. It sends only the text you
tapped, once, and never if they wrote again after the card was made. iMessage goes through `imsg` (installed, nothing
to link; the first send may ask to let it control Messages). The other networks go through a bridge: a small program
linked to your account as one more device, like WhatsApp Web. LINE, Instagram and LinkedIn are also read through
their bridge into Life's archive; WhatsApp is read from its Mac app.

The bridges and their local Matrix server (Synapse) run on your Mac as one background job, talk to nothing but
their network, and keep running when Life is closed: the server holds every message, deleted ones included, until Life copies it. Linking a
bridge may be against a network's terms (WhatsApp's); for one personal account, bans are rare. LINE allows one
Chrome-extension session: linking its bridge logs LINE's Chrome extension out.

## One command

```sh
bun life bridge                         # every messaging connector checked at once: ✓ or ✗, and why
bun life bridge add <network>           # whatsapp, line, instagram or linkedin: builds it, then links it
bun life bridge link <network> [flow]   # links it again (another way to log in: its flow id, listed when linking)
bun life bridge remove <network>        # logs out and removes the bridge; what Life archived of it stays
```

`add` sets up the Matrix server the first time (it needs `uv` and `go`), builds the bridge at its newest release, and
runs it. `add` again rebuilds it at its newest release. `link` shows a QR code in the terminal, or asks for what the
network needs (your email and password, a code), hidden as you type. When a network needs your browser's cookies
(Instagram, LinkedIn), it opens a Chrome window on the site: sign in as usual and it closes by itself once you're in
(a fresh profile of its own, deleted after). Without Chrome, it asks you to paste one request ("Copy as cURL" from
the developer tools' Network tab). A network Life reads is
turned on as a source; Life copies it once it restarts.

Turn sends on once: `bun life settings set '{"sends":true}'`. The status window's Sends card says whether each
network can send now.

`bun life send <decision>` says why a reply can't go, or sends it and closes the decision. The ledger keeps one `sent`
line per send.
