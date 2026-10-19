# Data sources

Every source is read-only. Each one is a file in `src/sources/` (the message archive is `src/archive.ts`) that returns `SourceEvent`s with stable ids, so
reading twice never duplicates anything. Raw data stays in its own app; Life keeps only ids and short quotes (and an ask's words, AGENTS.md). Before any text reaches a model,
`src/redact.ts` removes card numbers, IBANs, long tokens and lines that look like passwords or codes.

Each chat and mail reader also names a message's files (`SourceFile`, `schema.ts`: where it was met, name, type, and the
path when the file is on this Mac). One place, `showFiles` in `src/memory/files.ts`, turns them into lines of the message,
such as `[photo IMG_2910.HEIC, described by Life: … | text: …]` or `[video clip.mp4, not on this Mac]`, so every memory
step, search and the connector see them. Each file on this Mac is read once into `memory/files.jsonl`: a document's text
(`textutil`) and a PDF's text layer (`pdftotext`) by code, a photo or a scanned PDF's first page (`sips`, as JPEG) by
the fast model (`prompts/files.v1.md`), 8 per call. Video and voice notes stay a tag. Originals stay in their app (or
the archive's media copy); Life copies none, and a description outlives its file.

| Source | Where it lives | Reader | Notes |
|---|---|---|---|
| LINE, Telegram, Instagram | The archive below (`beeper.sqlite`), opened read-only; Telegram senders' phones from the bridge's `local-telegram/megabridge.db` | `beeper.ts` | Same chat-day units as WhatsApp; messages deleted for everyone keep their text and an edited message reads as its last version. Unit ids are `beeper:<chat>/<Beeper message id>`, as when the Beeper API was read. Attachments come from the archive (each version, since a delete wipes them), with Beeper's cached copy when it fetched one. iMessage comes from `imessage.ts`, WhatsApp from its own archive. Beeper's API is not used for memory. |
| WhatsApp | The archive below, opened read-only; senders' phones from the Mac app's `ContactsV2.sqlite` (`@lid` ids) | `src/sources/whatsapp.ts` | Same chat-day units as Beeper, but messages deleted for everyone keep their text and an edited message reads as its last version. Senders not in the address book stay `unknown`. |
| Message archive | WhatsApp Mac app's store, `~/Library/Group Containers/group.net.whatsapp.WhatsApp.shared/ChatStorage.sqlite`; Beeper Desktop's index, `~/Library/Application Support/BeeperTexts/index.db` (plain SQLite, `mx_room_messages` with `threads` and `participants`, LINE, Telegram and Instagram accounts only) | `src/archive.ts` | The one exception to "raw data stays in its own app": WhatsApp and Beeper blank a message deleted for everyone, so every 5 s Life copies new and changed messages into `~/Library/Application Support/Life/archive/`: `whatsapp.sqlite` (plus APFS clones of media) and `beeper.sqlite` (text and attachments' metadata, no file copies). Each version is kept (original, edits, the blanked one). Both stores are opened read-only; Beeper's whole table is re-read each pass, so its backfills are caught. Messages Beeper had already blanked before the first run, and ones it removes outright instead of flagging, cannot be recovered. `bun life archive deleted [days]` lists deleted ones from both. Closed, WhatsApp receives nothing and Beeper's store cannot be opened read-only, so the archive opens a closed one hidden (`app` in `STORES`). |
| Note archive | Apple Notes' store, `~/Library/Group Containers/group.com.apple.notes/NoteStore.sqlite` (Core Data; bodies are compressed protobuf) | `src/archive.ts`, `src/sources/notes.ts` | Notes overwrites a note in place, so every 5 s the archive keeps each new version in `notes.sqlite` (`versions`): the text, checklist lines marked `[ ]`/`[x]` (a tick is a change), and the attachments it holds (id, type, file in Notes' Media folder, Apple's OCR or table summary; no file copies). Every folder; shared notes included and marked; locked and not-downloaded notes skipped entirely. A version is saved once the note has gone 2 minutes without an edit. A note in Recently Deleted, marked deleted or gone from the store gets a deleted row (a restore is a new live row), except when more than 20 vanish at once or the store lists none (a sign-out). An iPhone edit reaches the store only while Notes runs on the Mac, so the archive opens it hidden when it is closed. Read back by `readNotes` (`notes.ts`) as one chat-day per note: each version in the window is a message showing what it changed (`+ `/`− ` lines, the first version whole, a deletion `[deleted the note <title>]`, a restore `[restored the note <title>]` and what changed since the last live version), his own except in a shared note (sender `shared note`: a co-editor may have written it), with the attachments it added as files (`notes:<attachment id>`) and Apple's text of a table or scan as a line. Memory only, never his words for actions. |
| iMessage and SMS | `~/Library/Messages/chat.db` | `imessage.ts` | Opened read-only. Newer messages keep text in `attributedBody`; the reader decodes it. Attachments from the `attachment` table, link previews left out. |
| Email, all accounts | Apple Mail's local store, `~/Library/Mail/V10/` | `mail.ts` | Covers every account in Mail (personal, the shop's, the company's, iCloud, Exchange). Every MIME part with a file name is a file, in the `.emlx` or, for a partial one, in Mail's `Attachments` folder. |
| Git commits | `git log --all --no-merges --numstat` in every repo under `~/Work` (worktrees folded into the main repo by `git rev-parse --git-common-dir`) | `git.ts` | Read-only. One unit per repo and day (`repoUnits`), reusing the chat-day builder. His commits in every repo; in the repos of his projects (`Project.repos` in `truth/projects/*.md`) other authors' too. The moments step tags them (topics), code caps their salience at 1, so they are searchable and listed by `day` but never extracted. Lines leave out lockfiles, binaries and files changed by over 3,000 lines in one commit (generated). |
| Recorded conversations | lifelog's REST API (`/changes`, `/transcription-jobs/{id}/transcript`, `POST /search` for the exact words), owner device token as `LIFELOG_TOKEN` in `.env` | `lifelog.ts` | Reads only, except the owner's corrections `forward` sends. Units come from the store `bun life watch` keeps, the only caller of `poll` (so every "hey Atlas" is heard); exact words are fetched on demand. Chapter titles and summaries (lifelog's own) with turn refs. `bun life memory moments` reads only those; `bun life memory extract` also reads the transcript turns of kept chapters (`/transcription-jobs/{id}/transcript`) and keeps short quotes. |

## Removed in the 14 Oct reset (restore from git when a layer needs one)

Reminders (JXA), Calendar, Apple Notes (now from the archive), Contacts, Whereabouts, the Gmail connector.

## Not used yet

| Source | Why later |
|---|---|
| Call history (`CallHistory.storedata`, 1,593 calls) | Good closure signal ("called X"); add with the weekly review |
| Google Drive (meeting notes, "Dividendes") | Project status pages, not day-to-day material |
| Claude sessions | Weekly "where your time went" view |
| Bank alerts (KBank in Gmail), finance dashboard | Dashboard last synced 5 Aug; Revolut consent likely expired |
| Business numbers (Stripe, RevenueCat, App Store, PostHog, the shop's sales and ads) | Project status pages |
| Screen Time / Biome / browser history | Needs a parser for Apple's binary format |
| Apple Health | Only reachable from the iPhone (Shortcut export) |
