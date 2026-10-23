# Your mail, code and Google Tasks on a server

How-to: give Life running on a Linux server what it reads on your Mac without asking: your mail, your git commits
and your Google Tasks. On a Mac none of this is needed; Life reads Mail.app's store, your checkouts and gog as they
are. Each part is optional and costs nothing but the account access it names.

Settings go in the server's `settings.json` with `bun life settings set`, as on a Mac ([settings](settings.md)).
Secrets never do: put each one in the server's environment file (the Compose's 0600 env file), then restart Life.

## Mail

```sh
bun life settings set '{"imap":{"host":"imap.gmail.com","user":"you@gmail.com","folders":["[Gmail]/All Mail"]}}'
```

```sh
LIFE_IMAP_PASSWORD=<an app password>
```

Life copies your mailbox to the server over IMAP with mbsync, every 5 minutes, and reads the copy. It only reads: it
never moves, flags or deletes anything in your mailbox. The first copy of years of mail takes hours and a few GB of
disk; a message over 25 MB is left out.

For Gmail, turn on 2-Step Verification, then make an app password at
[myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords). `[Gmail]/All Mail` holds each message
once, whatever its labels. For another provider (iCloud, Fastmail), leave `folders` out: Life copies every folder but
junk, trash and drafts. Turn on **Mail** under **Sources** as on a Mac.

## Your code

```sh
bun life settings set '{"forge":"github","repos":"/data/repos"}'
```

```sh
GITHUB_TOKEN=<a fine-grained token>
```

Life clones every repository your projects list (`repos:` in your projects' pages) into the `repos` folder, then
fetches them every 5 minutes, and reads their commits as it reads your checkouts. A folder name finds the repository
of that name your token can see. Make the token at
[github.com/settings/personal-access-tokens](https://github.com/settings/personal-access-tokens): read-only
**Contents** and **Metadata**, on the repositories Life should read. Turn on **Git** under **Sources**.

## Google Tasks

Google Tasks is the to-do list a server can use (Apple Reminders lives on your Mac). Life reaches it through gog, as
on a Mac. On your Mac, where gog is already signed in, export your sign-in:

```sh
gog auth tokens export you@gmail.com --out gog-token.json
```

Copy that file and your Google OAuth client's `credentials.json` to the server, then on the server:

```sh
GOG_KEYRING_BACKEND=file GOG_KEYRING_PASSWORD=<a passphrase> gog auth credentials set credentials.json
GOG_KEYRING_BACKEND=file GOG_KEYRING_PASSWORD=<the same passphrase> gog auth tokens import gog-token.json
rm gog-token.json
bun life settings set '{"todo_list":{"backend":"google","account":"you@gmail.com"}}'
```

```sh
GOG_KEYRING_BACKEND=file
GOG_KEYRING_PASSWORD=<the same passphrase>
```

The exported file holds your Google sign-in: delete it from both machines once imported.

## Contacts

A server doesn't read your contacts yet. On a Mac they name the phone numbers in iMessage, which a server doesn't
read either; both come with the Mac companion.

Next: [move Life to another computer](move.md).
