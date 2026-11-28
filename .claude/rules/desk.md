---
paths:
  - "apps/server/src/desk/**"
  - "apps/server/src/host/**"
  - "apps/server/src/memory/arrival-*.ts"
  - "apps/claude-plugin/**"
---

# The desk, registered agents and wakes

`SECURITY.md`, "Agents", is the security reading of these rules and says how the runtime and the send guard work.

## Content never runs Life's code

- Recorded text never makes Life's code act. Model calls see no tools and no instruction files (`models/llm.ts`); the
  one exception is the question cases' Codex agent, with the connector's reads only (`scripts/question-cases.ts`,
  10 Nov 2026).
- An agent reads what it pulls through the connector as data.
- A wake hands the event's facts (who, where, when; a payment's, arrival's or GitHub activity's fields), never its
  words. One assignment of each agent per event (`routeOf`). On a matter it opens with Life's own record
  (`matterRecordOf`), never the event's text (20 Nov 2026).
- Words choose a wake in three ways only; code only tests the text and queues the wake, never runs or hands it over:
  - the wait's pattern (`text_matches`; `EventFilter`, `matcherOf`, shared with the connector's poll) on a message as
    its readers see it, a payment's merchant, category and note, an arrival's line, or a GitHub activity's title and
    body (20 Nov 2026). A GitHub wait names `owner/name` or `owner/*`; only repos open waits name are read, through
    `gh`, never stored (life#774).
  - closeness in meaning to its matter (`desk/matter-net.ts`, the Mac's embedder; 18 Nov 2026).
  - the arrival reader's confirmed ask, promise or wait for him, or his word that he will do something
    (`memory/arrival-reader.ts`, `confirmedArrivalsOf`; 20 Nov 2026). Apple's on-device yes alone never wakes; a low
    priority wakes no one (21 Nov 2026). It wakes one agent, chosen in code (`matterOrPersonalOf`, `desk/event-queue.ts`); a message is queued for one agent at most, and
    for none once he wrote in its chat after another person's lines.
- His spoken ask (`wakeOf` high, `host/hear.ts`) wakes no agent: it is an ask of the main session, like Ask Life
  (`desk/spoken-ask-intake.ts`; 27 Nov 2026), which hands work on with `tell_agent` (`ask.spoken`: facts only).
- An ended call (`call.ended`, 19 Nov 2026) is queued once lifelog says its words are in, with refs, never a word.
- A mark only keeps a unit read. Apple Notes and imported assistant chats are never his words for actions.
- One fact of a message acts: his writing in an open draft card's chat withdraws the card
  (`withdrawDraftsAnsweredInChat`, life#731).

## Life starts and wakes his registered agents, and nothing else of Life does

His yes, 18 Nov 2026. The desk (`apps/server/src/desk/`, off until his `desk` setting) is the only dispatcher.

- It creates an agent only on his word: a project's (a one-off project's once: `openOneOffProject`, 28 Nov 2026), or
  the Personal agent (one at most, home `<agentsRepo>/personal/`). It wakes a session on its events, his answer or its
  deadline.
- The main session and the caretaker stand from the desk's start (`standUp`, 22 Nov 2026), running no turn until his
  words or complaint.
- With none standing, the desk registers the Personal agent for a confirmed arrival no agent takes, or his words to an
  ended agent (21 Nov 2026). `desk/role-agents.ts` is the one start of a standing role.
- An `intention` instruction opens one assignment on a standing agent and starts none (`openIntentions`;
  closed when replaced or past `until`).
- A matter is never an agent: it is an assignment of the agent that takes it (`agentForOf`, his `matter-project` word
  first).
- An agent gets a matter on his Start, or from the hand-out within his `desk.handOut` pace, only one of his
  (`isOneOfHis`, `handOutOf`, `desk/hand-out.ts`; 20 Nov 2026). With the hand-out on, his own new matter gets no Start
  card; another's waits for his Start.
- The fold (20 Nov 2026): a matter's open assignment moves to its agent; an agent left with nothing open ends. A
  project's agent holds only what is assigned to it.
- A matter he moved (`hand_over`) stays put (`pinnedAssignmentsOf`); a move whose new holder never begins is rolled back.
- An agent changes a project's repo only on a card he approved, never writes its notes there, and never starts a
  session of its own (20 Nov 2026). The Personal agent may draft to a project's work contacts until it has an agent.
- The night, the watcher, the connector and recorded content never start an agent.
- Life gives an agent a brief, the door and the send guard, nothing else (on pi also `life connector-reads`,
  `pi-subagent.ts`, `web_search`). The rest is its runtime's permissions and his rules.
- An agent of his own Life is one of his sessions in full (19, 20 Nov 2026: `readLoginEnv`, `Row.mode`), held back only
  by the send guard (`desk/send-guard.ts`, `pi-extension.ts`, `readCodexGuardTrust`): no send outside a card's draft,
  none of his connector's writes (`CONNECTOR_WRITES`) but at the `desk` door. No agent starts without it.
- A second Life's agent (`isOwnLife` false) gets its door alone: none of his settings, tools or environment
  (`Row.onlyDoorPrefix`, `runtime-rows.ts`), never in his Claude or Codex app; a Codex one runs in Life's own Codex home.
- The brief's one gate: nothing outward in his name without his yes on the exact thing, asked as a decision. No plan
  card (25 Nov 2026): an agent asks only what is his, and may `finish` or `set_wait` with none (`desk/first-turns.ts`).
- A handed-out assignment that neither asked nor waits in two hours closes (`isCardOverdue`). A turn holding the main
  session's question ends only once it read his words (`main_question`).
- The caretaker (22 Nov 2026) says nothing technical, fixes memory itself with `correct_memory` (`said` from the
  complaint, `complaintWordsIn`), and sends a fault in Life's code only as an anonymized card mailed to
  `DEVELOPER_CONTACT` on his Send.
- The main session (`desk/main-session.ts`, one at most, 21 Nov 2026) wakes only on his words, never the clock, an
  event or the hand-out; low-confidence words run no turn. His words are its prompt as he sent them.
  Its door's extra writers (`SECURITY.md`, "Agents"; also `read_assignment`, `record_instruction`) are no other
  agent's, but the caretaker's `correct_memory`.
- Each such act takes `said` from his words of that ask (`hisWordsIn`): proof the words are his, not that the act
  matches them. `tell_agent` goes to one assignment, never routed by meaning. The send guard still applies.
- Its answer's blocks are checked as they close and dropped when wrong (`records/answer-blocks.ts`).
- Life starts no unregistered agent but the question cases' agent.
- An agent's state lives in `desk.sqlite`, never `memory/`; an assignment's notes are a file in `desk.agentsRepo`.
- A first turn that never began closes its assignment (`why_not_started`), never retried; one cut by a restart is due
  again (`endTurnsCutByRestart`). An agent ends with its last open assignment.
- An agent is known by its pairing or its door key, never by what it says. Nothing branches on an agent's name.

## Every spoken ask ends with something he sees

27 Nov 2026: his thread entry, one push that Life heard (replaced by its outcome, no words), then the answer or why
not. One over an hour old (`SPOKEN_ASK_FRESH`) or already received never runs (`askMainSession`, `spoken-asks.test.ts`).

## Sessions on his Mac

- Never resume a Claude session a live process holds: the wake waits (`isSessionOpen`, `runtime-rows.ts`). One
  session, one process.
- Each fresh Claude session is listed in his app's sidebar once (`listInApp`; 26 Nov 2026); the import starts no process.
- It comes to the front only on his "Continue on your Mac" (`desk/continue-on-mac.ts`), guard loaded.
- A holder quiet 10 minutes when a wake is due (the main session: always) is ended (`takeBackIfLeft`; 22 Nov 2026).

## Hearing a conversation

The watcher and the desk take a conversation's or call's words only once lifelog's own signals say they are complete
(`endedOnSilence`, `closed`; `recordingsOf`), never by a timing rule of Life's (`docs/operations.md`).
