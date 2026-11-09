---
type: task
blocked_by: []
assets: [.plan/memory-rework/assets/03-old-sources.md]
---

# Old sources, read in once

## Question

What history exists outside Life today, and how each gets in once: WhatsApp (an iPhone backup through the existing reader vs per-chat exports; his father's old account, already exported), iMessage, mail, Notes, the bridged networks, assistant chats, anything else. For each: span, size, how it is imported, how it is deduplicated against what Life already holds, and what he must do by hand.

## Answer

Detail, with his checklists, in [03-old-sources.md](../assets/03-old-sources.md); counts re-checked (iMessage 120k messages
since June 2015; 31 WhatsApp export zips in Downloads, about 8 distinct chats).

- WhatsApp before Oct 2025 exists only on his iPhone. An iPhone backup (unencrypted is his phone's setting) holds the
  same store Life's WhatsApp reader reads, with stable message ids, so the existing archive key deduplicates it. Started
  9 Nov. The father's old-number export (2019–2025) is the one export still needed; exports have no ids, so each is cut
  at the archive's first message for its chat.
- iMessage (2015) and Notes (2012) are already complete on the Mac: the readers only have to start earlier.
- Mail is the one big source (2007 onward, about 79k messages once bulk is dropped): it needs a filter, not an import.
- Telegram, Instagram and LinkedIn need official exports (bridges only hold what they copied since linking); LINE only
  from Sep 2026. claude.ai and ChatGPT exports were requested by him on 9 Nov.
- Nothing older exists for voice (Sep 2026), Screen Time (Oct 2026), Signal or Messenger.
- Everything that holds old words lands before the one read of the whole history; calendar, payments, git and call
  history can wait.
- Open, for the tickets that need them: how much old mail to read (The questions he asks Life, Organic memory), whether
  his Claude Code and Codex sessions count as his words (What knowing everything about him means).
