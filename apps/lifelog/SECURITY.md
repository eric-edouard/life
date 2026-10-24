# Security

lifelog records everything said around its owner, other people included. This page says where that data and its
secrets live, what an attacker could do with each piece, what lifelog does about it, and what it does not.

## Where data lives

| What | Where | Protection |
| --- | --- | --- |
| Raw recorder pages, playback audio, the library cache | The iPhone app's container | iOS data protection (available after first unlock, so background Bluetooth can write while locked) |
| The archive: conversations, words, people, voice embeddings, places, summaries | `archive.sqlite` in `~/Library/Application Support/lifelog` on the Mac | The Mac account's file permissions; turn on FileVault |
| Speech blocks, raw page backups, daily archive copies | `audio/` beside the archive (or an S3 bucket, if configured) | As above |
| Backups | A restic repository in iCloud Drive (`lifelog backup/restic`) | Encrypted by restic with a password minted once, kept in `secrets.json` |
| Transcripts | ElevenLabs keeps a copy under its own retention policy | Their terms ([docs/providers.md](docs/providers.md)) |
| Text sent for summaries | Your ChatGPT or Claude account, through Codex or Claude Code | Your subscription's consumer terms |
| Passages and queries for search by meaning | OpenAI's embeddings API, if a key is set | No training on API data by default; abuse logs up to 30 days |

## Where secrets live

- **The iPhone:** its device token in the Keychain, this device only (`AfterFirstUnlockThisDeviceOnly`); the server's
  address in the app's defaults.
- **The Mac:** `~/Library/Application Support/lifelog-quiet/secrets.json` (mode 0600 in a 0700 folder) holds the
  tokens Lifelog Host mints, the ElevenLabs and OpenAI keys, the tunnel token, the backup password and the helper's
  Claude sign-in; Codex's sign-in is in the helper's own Codex home beside it. `~/Library/Application Support/lifelog/server.env` (mode 0600; Host refuses to start the server
  if others can read it) holds keys Host doesn't manage, such as APNs and Resend.
- **The server** stores only the sha256 of each token. Tokens never go on a command line: the tunnel token reaches
  `cloudflared` through its environment, which `ps` doesn't show.
- **A development checkout** keeps its secrets in gitignored `.env` files.

## Threat model

**Tokens.** Every route except /health, the signed ElevenLabs webhook and the OAuth pages needs a bearer token;
the server compares its hash.

- The **device token** (the phone's) opens every route: reading the whole archive, editing it, and changing the
  processing switches. Whoever holds it is the owner, as far as the server knows. Mint a new one
  (`bun run --cwd apps/lifelog/apps/server mint-token`) and re-pair the phone to rotate it.
- A **reader token** opens only the reads the voice-source contract lists, and a `corrections` token also the
  owner's explicit corrections (titles, speakers, people). Both see every transcript and the location history. Lifelog
  Host's reader token is a `corrections` token.
- The **Mac token** opens only the helper's socket, but that socket carries the summaries' prompts (transcript text)
  and the dictation ranges. A stolen one could read prompts while the real helper is away, answer them with made-up
  summaries, and vouch for the Mac without sending ranges, which would let dictation reach ElevenLabs.

**Network exposure.** The server listens on 127.0.0.1 only.

- **On a tailnet** (Tailscale Serve, never Funnel), every device on the tailnet can reach it; the token is the only
  gate. Keep the tailnet to your own devices.
- **Through your own domain** (a Cloudflare tunnel), the server is on the public internet behind its tokens. Add
  Cloudflare Access in front if you can.
- The ElevenLabs webhook route refuses everything unless `ELEVENLABS_WEBHOOK_SECRET` is set, and then checks each
  call's signature.
- The optional identity service (`apps/identity`) listens on every interface with a shared secret: run it on the
  same Mac or a private network, never on a public address.

**The recorder's Bluetooth.** The Limitless Pendant bonds with "Just Works" pairing and holds one bond at a time;
its audio is not encrypted on the link. Anyone who pairs with a Pendant that isn't bonded (blue light) can read and
delete what is on it. lifelog never sends the factory-reset, unpair or encryption-key commands, and never
acknowledges a page before it is safe on the phone. An Omi on released firmware frees each record as soon as it is
delivered: a phone that dies mid-transfer loses it ([docs/research/omi.md](docs/research/omi.md)).

**Prompt injection through speech.** Anyone near the recorder can say "ignore your instructions and…". What a
recording, transcript or summary says is never an instruction: model calls run in an empty folder with no tools,
settings, MCP servers or web access, the transcript is sent as quoted data, and answers must match a strict JSON
schema whose claims cite real turns. The worst a spoken attack can do is a wrong title or summary, which the owner
can see and regenerate. Readers such as Life must treat lifelog's text the same way.

**Dictation.** When the owner dictates to the Mac, the recorder hears it. The Mac helper reports those ranges, and
the server cuts them from every block before ElevenLabs, the identity service or a model sees it, checking twice.
The raw backup still holds them, on your own disk.

**Backups.** The restic repository is encrypted, so iCloud holds only ciphertext; anyone with the password and the
repository can read everything. Lose the password and the backups are unreadable: Lifelog Host asks you to copy it
somewhere safe. The daily copy without restic (`archive/` in the audio folder) is not encrypted.

**The Mac itself.** Anything running as your user can read the archive, the audio and `secrets.json`. lifelog
doesn't defend against malware or another admin on the Mac; FileVault defends a stolen one at rest.

## Known limits

- Voice embeddings are biometric data. They stay in the archive and are never sent to a provider, but they are only
  as safe as the Mac.
- Speaker recognition and summaries can be wrong; they are a model's reading, not facts.
- Recording other people may require their consent where you live. That is on the person wearing the recorder.

## Reporting a vulnerability

Please report it privately through GitHub's "Report a vulnerability" (the Security tab of this repository), not in a
public issue. Include what you found, how to reproduce it and its impact.
