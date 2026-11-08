# Events: agents wake on what Life sees

Life's connector implements MCP's Events extension (SEP-3415, `io.modelcontextprotocol/events`, draft, open on
modelcontextprotocol/modelcontextprotocol#3415). An agent subscribes with its own exact filter (event type +
arguments, matched by code, no model). Life only lists what can be heard and when it happened. Events are a read
computed when an agent polls: Life stores nothing for them. The voice `onAsk` hook goes.

Built for runtime plugins: `events/list` is computed at call time from the enabled sources that can say what is new
(a capability on the descriptor, never a hand list), so a source moved into a plugin later brings its events with it.

## Milestone 1: Life serves `message.received` by poll

- [ ] Source contract: a chat or mail source gains `incoming(after?: number) => { messages, last }`: its messages
      after a row number, in the order the store wrote them. It existed until be25aacf (`incomingImessage`): bring
      back its shape, widened to every chat/mail source with an ordered store. A source without it emits no events.
  - iMessage `chat.db` and Mail's Envelope Index: `ROWID`. Mail can rebuild its index (renumbered): a cursor past
    the store's max row restarts at now and the page says `truncated: true` (the spec's signal).
  - WhatsApp and the bridged archives: the table's implicit `rowid`, first-seen versions only (the first row of its
    `(chat, eventId)`); an edit or delete row is never a new message.
- [ ] `feedPage` (changes.ts:92-125) changes signature: a `Source` reads `after(position) => { lines, last }` with
      sparse positions, instead of a dense count and the whole array. Both callers move (changes.ts:468-479,
      asks.ts:65-68) with `changes.test.ts`; one pager, one cursor encoding (`encode`/`parseCursor`).
- [ ] `apps/server/src/host/events.ts`: event types and matching, one job (answer `events/list` and `events/poll`).
  - `message.received`: arguments `person` (resolved by `meant`, `who.ts`), `channels` (enum: enabled sources with
    `incoming`, now), `chat`, `from_me` (default false), `text_matches` (a regex). `person` is who wrote it
    (`speakerOf`, the one rule, AGENTS.md "One way"); on his own messages it is the other side of a 1:1 chat
    (`directChats`, closeness.ts), none in a group. Payload: `id, at, source, chat, person`, no text (the agent
    reads it with `read_chats`/`fetch`; the spec's payload minimality).
  - A page is filled across sources by cursor; `remaining` says more is waiting (a bridge backfill pages through).
- [ ] `read_chats --who` stays a word search (`needlesOf`: any words, raw handles, chat names, unresolved senders),
      a different job from an exact match; its comment says so and points to `speakerOf` for who wrote a message.
- [ ] `mcp.ts`: `events/list`, `events/poll` via `setRequestHandler` (SDK 2.3.1), the `extensions` capability. No
      push mode: no client needs a held stream.
- [ ] Tests (made-up people): one person on mail, WhatsApp and Telegram matches `person`; `from_me`; `text_matches`;
      a disabled source is not in `channels`; a cursor resumes with nothing skipped or repeated.
- [ ] Docs: glossary `event` (MCP's word, forced by the protocol: an occurrence an agent polls or subscribes to; a
      source's message is a message); docs/architecture.md:50 says "message"; delete the stale `events.json` line in
      `.claude/rules/derived.md:9`; AGENTS.md: "events are a read at poll time, no stored state".

## Milestone 2: claude-loops wakes on events (its repo, its PR)

- [ ] A loop's `.loop/plan.json` gets `watches: [{name, arguments}]`, written by the loop when it waits on someone
      (one `rules.md` line).
- [ ] The mod's 30 s poll (`mod.ts`, plain code) calls `events/poll` per watch over loopback with the Loops pairing
      (`.mcp.json`), pages until `remaining` is 0, keeps each cursor in its state; a match appends to the inbox
      (`appendInbox`) and starts a run (`$.command.run`, the path a pause's end takes). Nothing leaves the Mac.
- [ ] Asks: the same poll checks `read_agent_asks` past `forward.ts`'s own cursor (no second cursor) and runs
      `forward.sh` when one is new.

## Milestone 3: `onAsk` goes

- [ ] Once milestone 2 runs on his Mac: remove `onAsk` from his `settings.json` (else each ask starts `forward.sh`
      twice). Then the code: settings.ts, asks.ts, its test, docs/tasks.md, SECURITY.md, the AGENTS.md invariant ("Life
      starts no agent", no exception left), glossary. Never code first: the strict schema would stop the watcher.

## Milestone 4: webhooks, for agents not on the Mac (needs his yes)

- [ ] `events/subscribe`/`events/unsubscribe`: subscriptions in the watcher's memory, 1 h TTL refreshed by the
      client, each with its own cursor; a one-minute timer polls for each and POSTs, signed per Standard Webhooks
      (`node:crypto`, the client's `whsec_` secret). A failed POST is not retried: the client's cursor replays it.
- [ ] `ask.received` as an event type, then, for a remote agent to be woken on its asks.
- [ ] SECURITY.md "What leaves the Mac": "to his agents" gains webhook delivery (ids, who, where, when; never text).

## Open decisions (his)

1. Webhooks (milestone 4): his message metadata leaves the Mac, to an address a paired agent gives.
2. A tool-shaped fallback (`poll_events`…): not built until a client with no Events support needs its model to
   subscribe itself (a tool change forces a ChatGPT reconnect).
3. Building on a draft: the extension may change; we follow it.

## Golden rule plan
Inventory: `rg -n "onAsk|startDetached|asksFor|feedPage|parseCursor|agentOnly|readPeople|speakerOf|needlesOf|tablesOf|setRequestHandler|incoming|seenAt|ROWID"`;
`git show be25aacf`. Agent wake: `onAsk` (settings.ts:25-33, asks.ts:46-49, asks.test.ts:42-55, docs/tasks.md:18,
SECURITY.md:27, AGENTS.md:105, glossary.md:26). Cursors: `feedPage`/`fileSource`/`parseCursor` (changes.ts; asks.ts:59).
Who wrote a message: `speakerOf` (units.ts:362); `read_chats --who` decides it again by `needlesOf` (words.ts:334, 634).
Messages: readers by send time (`tables().CHATS`, units.ts:714; `readChats`, words.ts:451); ordered rows in the
archive (archived.ts:149), `chat.db`, Mail's index (mail.ts). Old per-source `incoming` and `events.json`: deleted in
be25aacf, `events.json` still in `.claude/rules/derived.md:9`. Connector: mcp.ts (`buildServer`, `agentOnly` :176).
Shape: each source says what is new after its own row (`incoming`, its descriptor); `feedPage` pages any "after a
position" feed; `events.ts` matches with `speakerOf`. Nothing stored: an event is computed when polled.
State: none in Life for M1-M3 (cursors are the agent's). M4: per subscription, in memory, TTL-bound.
Deletes: `onAsk` and Life starting agents; the stale `events.json` line.
Net lines: Life about +200 / −50 (M1 +150, M3 −50, M4 +100); claude-loops about +100.
Plan review: reshaped. Dropped `arrivals.jsonl` (a copy of ordered stores, his text in state, a second deleted-message
copy) for per-source `incoming`; dropped `ask.received` until M4 (it duplicated `read_agent_asks`); one rule for who
wrote a message; onAsk removed key first, code after; no "subscription"/"arrival" words. Confirming review:
named the first-seen filter (WhatsApp, bridges) and Mail's rebuild guard; `feedPage`'s signature change with both
callers; `directChats` for his own messages; `read_chats --who` kept as a word search (a different job), not
folded into `speakerOf`. Stopped there (one confirming round).
