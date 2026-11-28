---
paths:
  - "apps/server/src/sources/**"
  - "apps/server/src/host/bridges*.ts"
  - "apps/server/src/memory/imports*.ts"
  - "apps/server/src/memory/units.ts"
---

# Sources, the archive and imports

Moved from the root `AGENTS.md`.

- **The export copies in `imports/<source>/` are never rewritten, merged or deleted without his yes.** They are the only
  copy of his assistant history besides the backup (a conversation he deleted in the app survives only there); a newer
  export lands as a copy of its own, and a conversation reads from the copy holding its latest version.

- **The archive is the only live copy of deleted messages and old note versions.** Never move, wipe or migrate its
  files; a new table only with the owner's OK, never a rewrite of rows. Keep it running. App stores are opened
  read-only; only the apps of enabled sources are kept open (`keptStores`). The bridges' homeserver is the buffer
  before the archive's copy: its `redaction_retention_period` stays null, its rooms are never purged and its database is
  never made again (the copy counts its event numbers) (his OK of the
  new archive files `line.sqlite`, `instagram.sqlite`, 29 Oct 2026; `screen.sqlite`, 4 Nov 2026; the table `phone_calls` in `whatsapp.sqlite`, his "any architectural change" for calls, 5 Nov 2026; `phone.sqlite`, table `calls`, 10 Nov 2026; `messenger.sqlite`, his ask for the Messenger bridge, 14 Nov 2026; `github.sqlite`, the issues and comments of the repos he lists, 19 Nov 2026).

- **Life's own output never re-enters memory:** its chat and mail are dropped as `life-output` (`units.ts`). A card's
  draft Life sent on his answer is his own message, read back from its chat like any other; only the communication
  styles skip it (`sentDraftsOf`: drafts never learn from drafts). What Life
  read off a file (`memory/files.jsonl`) shows inside the file's brackets and is evidence of what was sent, never
  anyone's words. The agent's done tasks enter only as the agent's source (named by `AGENT_WORD`), as evidence of what was done, never as his
  words or a request.

- lifelog is read through its REST API; the zod shapes accept every null and absent field its contract allows
  (`lifelog.test.ts` checks them against `apps/lifelog/apps/server/openapi.json`).
