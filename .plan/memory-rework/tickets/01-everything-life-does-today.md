---
type: research
blocked_by: []
assets: [.plan/memory-rework/assets/01-features.md]
---

# Everything Life does for him today

## Question

List every end-user feature Life has today (the connector's reads and tools, person and area pages, situations, open items, appointments and the calendar, fact checks, the nightly and daily mails, search, actions, the status reads) and, for each, the layers and records that feed it. This is the checklist the rebuild must keep and improve: a feature missing from the new design is a gap, never a cut.

## Answer

The checklist is [01-features.md](../assets/01-features.md): every feature by surface (connector reads and writes, events,
pages, mails and notifications, the Mac app, other), each with the layers and records that feed it, and which features
each layer holds up. Checked against the code: the connector's 19 tools, the "an open item shows at most twice" rule
(`open-items.ts`, counted from the logged `mcp.call` ids, not from memory), and the layers no code reads.

What the rebuild must know from it:
- Three stored layers feed nothing: `communication-styles/`, `detail-tags.jsonl`, `decisions.jsonl`. They can go.
- The daily, weekly and triage mails are his scheduled tasks, outside the repo, built on `read_day`,
  `read_places_visited`, `read_open_todo_items`, `read_chats`, `search` and `correct_memory`: those reads' shapes are
  part of the checklist, or change in the one batched reconnect.
- Gaps worth improving: appointments reach him only through his calendar (no connector read, not in `read_day`);
  situations and personas exist only for people with a page, never for areas; several features are CLI-only (grants,
  the fact-check answers "outdated", "skip" and undo).
