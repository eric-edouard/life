# The iPhone app's end-to-end tests: a map

Research, 26 Nov 2026: the end-to-end tests the Life iPhone app needs, front end only, each run in the iOS Simulator
against a fake Life connector (no Mac, no models). Nothing here is built; v4 shipped "no app tests"
(`docs/plans/2026-11-25-overhaul/README.md`, "The app"). Read with the current spec
(`docs/design/chat-first/2026-11-23-current-spec.md`), the v4.1 plan (`docs/plans/2026-11-26-v4.1.md`) and the
prototype's side panel (`docs/design/chat-first/prototypes/shell.html`).

## How to read it

- **Status**: Built (in the app on `main`: P2, P3), v4.1 (DS, P4, or G/H's wire, drawn by P4), Prototype (drawn in
  `shell.html`, in no plan yet).
- **P0** guards money, a send, a deletion, pairing, or the offline queue (never sending twice). P1 is a core flow he
  uses daily. P2 is polish, motion, or rare.
- **Server** names fixtures in `apps/lifelog/fixtures/wire/life/` (written by Life's server tests) or
  `apps/lifelog/fixtures/design/`. A name marked **new** must be added, written by the server's own tests through
  `wire-fixture.ts` like the rest, never by hand, so the fake never drifts from Life.
- Every test asserts through the accessibility tree (labels the code already sets: "Needs you", "Later", "Under way",
  "Settled", "Goes when Life is back", "Undo", "Pendant", "What's waiting on me"), never through pixels. Motion is
  checked only for its end state; Reduce Motion is on in every run but the motion ones.

## Thread and asking

| ID | Flow | Steps | Asserts | Server | Status | P |
|---|---|---|---|---|---|---|
| T1 | Open on the bottom | Launch paired | Thread opens at its last entry; day separators; "Show earlier" present | `read_thread.json`, **new** `read_thread_two_days.json` | Built | P1 |
| T2 | Show earlier | Tap Show earlier | Older page lands above, scroll position kept, no duplicate entry | **new** `read_thread_earlier.json` (`before` given) | Built | P2 |
| T3 | Ask in words | Type "When is the dentist?", Send | His bubble at once; steps line ("Reading …"); words ink in; one `ask_main_session` call with the screen's refs | **new** `ask_main_session_reply.jsonl` (thinking, step, words, block, result) | Built | P1 |
| T4 | Ask by voice | Hold mic, release | Field shows dictated words; release sends; same as T3 | as T3; dictation faked by Debug flag (**new** `-fakeDictation "<words>"`) | Built | P1 |
| T5 | Stop | Ask, tap Stop while steps run | Entry ends "Stopped"; field free; no late words land after | **new** `ask_main_session_slow.jsonl` | Built | P1 |
| T6 | The count | Tap the left round button | His bubble "What's waiting on me?"; Life's items block; count equals needs-you asks | `read_thread` with asks, **new** `ask_main_session_waiting.jsonl` | Built | P1 |
| T7 | Life can't answer | Ask; fake returns error | "I couldn't answer that."; tapping his bubble asks again, once | **new** `ask_main_session_error.jsonl` | Built | P1 |
| T8 | Dropped stream | Ask; fake cuts SSE mid-words | Entry waits, then the replay under the same key reads as working, then lands; one entry, not two | **new** `ask_main_session_dropped.jsonl` + replay | Built | P0 (one ask, one turn) |
| T9 | Poll by version | Leave thread open 10 s; fake bumps `version` | Re-read with `ifNot`; only changed items move; unchanged version re-renders nothing | `read_thread.json` × 2 versions | Built | P2 |
| T10 | Long work handed off | Ask "find a physio this week" | 👀 on his bubble, "I'm on it…", item under way with a still ring and estimate; edge back to idle | **new** `read_thread_under_way_estimate.json` | Prototype | P2 |
| T11 | Late reply | Agent answers a question after 60 s | Reply lands as an entry under the ask it follows | **new** `read_thread_follows.json` (G) | v4.1 | P2 |

## Answers and blocks

| ID | Flow | Steps | Asserts | Server | Status | P |
|---|---|---|---|---|---|---|
| A1 | Markdown answer | Ask | Headings, lists, bold, table, quote render; `life:` link present | **new** `ask_main_session_markdown.jsonl` | Built | P1 |
| A2 | Items block | Answer with an `items` block | Rows live, each in its state; two copies of one ask change together | as A1 + `read_thread` asks | Built | P1 |
| A3 | Single item unfolded | "Show me the dentist matter" | One item, unfolded in place, under Life's sentence | **new** `ask_main_session_one_item.jsonl`, `read_matter_found.json` | Built | P1 |
| A4 | Pictures, phrase full screen | Tap a picture; tap a phrase's Show it | Full screen opens; closes back to thread | **new** `ask_main_session_pictures.jsonl`, `read_person_pictures.json` | Built | P2 |
| A5 | Place, document | Answer with place and document blocks | Maps link opens out; document opens the system viewer | as A1 | Built | P2 |
| A6 | Question: two pills | Answer ends with a question | Pills under it, likelier filled; tap sends that label as his words; question not in count | **new** `ask_main_session_question.jsonl` | Built | P1 |
| A7 | Question kinds | Option cards, value pills, faces, "your words" | Each draws its control; tap becomes his words | **new**, one line per kind | Prototype (only two pills built) | P2 |
| A8 | Reactions both ways | Life reacts 👍 to his bubble; he holds a line of Life's, picks 🤩 | Mark on the bubble; his reaction rides the next request, never as `said` | **new** `ask_main_session_reaction.jsonl`; request checked | Built | P2 |
| A9 | `life:` link opens | Tap a `life:person:…` in words | Profile opens (see PF1); a `life:` ask link unfolds the ask | `read_people_and_organizations_now.json` | Built | P1 |
| A10 | Context sheet | Unfold an ask with `context`; tap its link | Sheet opens; inner `life:` page pushes with Back; web link opens Safari view | `fetch_matter_thread.json`, **new** `read_thread_ask_context.json` | Built | P2 |

## Cards and answering (Send, Later, Undo, rate)

| ID | Flow | Steps | Asserts | Server | Status | P |
|---|---|---|---|---|---|---|
| C1 | Send a draft | Unfold a draft ask, tap its main answer | Button busy, then done for 1 s, then row "Settled"; exactly one `answer_check` with one `answerKey` | **new** `read_thread_draft.json`, `answer_check_sent.json` | Built | P0 |
| C2 | Double tap | Tap Send twice fast | One call; second tap ignored while running | as C1 | Built | P0 |
| C3 | Not sent | Send; fake returns not sent | Reason on the ask, retry allowed; retry uses a **new** key | `answer_check_not_sent.json` | Built | P0 |
| C4 | May have gone | Send; fake returns may have gone | No retry offered; ask stays answered | **new** `answer_check_may_have_gone.json` | Built | P0 |
| C5 | Dropped mid-send | Send; fake drops connection before result | Retry repeats the **same** key; fake's dedupe returns the first result; one send recorded | `answer_check_sent.json` + replay | Built | P0 |
| C6 | Mac silent | Send; fake never answers | Ends "not done" after `MacSilence.noAnswerAfter`; late result applies nothing | as C1, delay ∞ | Built | P0 |
| C7 | Already answered elsewhere | Fake marks card answered on the Watch, he taps | Button reads "Already answered: Sent"; no second send | **new** `answer_check_already_answered.json` | v4.1 (wording not built) | P0 |
| C8 | Later | Tap Later on an ask | One `answer_check` `options:["later"]`; row "Later · tomorrow 9:00"; count drops | **new** `answer_check_later.json`, `read_thread_later.json` | Built | P1 |
| C9 | Undo an answer | Answer, then Undo | `undo:true` sent; "Undoing…", then Undone or the refusal line | **new** `answer_check_undone.json`, `answer_check_undo_refused.json` | Built | P1 |
| C10 | Send has no Undo (iMessage, mail) | Send an iMessage draft | No Undo control on the settled row | **new** `read_thread_settled_imessage.json` | Built | P0 |
| C11 | Undo a WhatsApp send | Settled row "Undo until Fri"; Undo | Confirm shows what the other side sees; "Keep it" sends nothing; "Delete for both" sends one undo | **new** `read_thread_settled_whatsapp.json`, `answer_check_deleted_for_both.json` | Prototype (D's redaction waits on question 20) | P0 |
| C12 | Takes a note | Option that takes words; type, answer | Button off until words; note sent once | **new** `read_thread_takes_note.json` | Built | P1 |
| C13 | Takes a person | Option `takes: person` | Picker searches his directory; pick sends `person` | `read_people_and_organizations.json` | v4.1 (P4 picker) | P1 |
| C14 | Payment card | Unfold a pay ask; "I paid it" | Amount, IBAN, QR hero; Open your bank opens the chosen app; Life's done-seen line; no money moves from the app | `answer_check_done_seen.json`, **new** `read_thread_payment.json` | Built | P0 |
| C15 | Calendar add | Unfold an `adds` ask; answer | One answer; done shows the event line | **new** `answer_check_event_added.json` | Built | P1 |
| C16 | Outdated while open | Ask open; fake flips it to outdated ("Nora wrote since") | Row fades, folds, no answers; a tap sends nothing | **new** `read_thread_outdated.json` | Built | P0 |
| C17 | Under way stalls | Answer; fake keeps under way, then back to needs you with why | Row returns with "Couldn't reach …"; answers back | **new** `read_thread_stalled.json` | Built | P1 |
| C18 | Answered away from the bottom | Answer an ask scrolled up | Folds in its new state; bottom line "You answered **…**"; link scrolls back and lights it | as C1 | Prototype | P2 |
| C19 | Skipped ask | Life brings an ask; he types instead | Ask loses buttons; "Left for now, still waiting on you" | **new** `ask_main_session_brings_ask.jsonl` | Prototype | P2 |
| C20 | How am I doing? | Rate item under an answered ask; tap 👍 | "Thanks", fades; one `rated` sent; cross sends nothing | **new** `read_thread_rate.json` (H) | v4.1 | P2 |
| C21 | Spending stop | Under way item returns: "Keep looking for a physio?" | Small line "About 1 € more · 1 € so far"; Keep looking, Later, Stop here each send one answer | **new** `read_thread_spending_stop.json` | v4.1 (server G); drawn as any ask | P0 |
| C22 | Unknown `takes` | Option with a `takes` this build doesn't know | Opens "Tell the agent…", never a dead button | **new** `read_thread_unknown_takes.json` | Built | P1 |

## Drafts and redraft

| ID | Flow | Steps | Asserts | Server | Status | P |
|---|---|---|---|---|---|---|
| D1 | Draft as its chat | Unfold a WhatsApp draft | Chat name and size, cited messages (≤5 + replied-to), draft on the app's colour, "Open WhatsApp ↗" | **new** `read_thread_draft.json` (with `chat`) | Built (plain text in rows; strip in notification only) | P1 |
| D2 | Redraft by words | Draft open; type "make it warmer" | His bubble; old draft folds to a faded "Earlier draft"; new ask lands below; Send sends the **new** ref only | **new** `ask_main_session_redraft.jsonl`, `read_thread_redrafted.json` (`changed: edit:words`) | v4.1 | P0 |
| D3 | Quick edit chip | Tap "Shorter" | Draft changes in place; back arrow restores the last version; Send sends what is shown | **new** `read_thread_redrafted_tap.json` (`edit:tap`) | v4.1 (chips need G's wire) | P0 |
| D4 | Someone wrote meanwhile | Fake: someone wrote in the chat before Send | Not sent with reason; the follow-up card replaces it | `answer_check_not_sent.json` | Built | P0 |
| D5 | Two drafts, one chat | Contest: second card replaces the first | First goes outdated "replaced"; only one has Send | **new** `read_thread_replaced.json` | Built | P0 |

## Offline and reconnect

| ID | Flow | Steps | Asserts | Server | Status | P |
|---|---|---|---|---|---|---|
| O1 | Go offline | Fake unreachable | Notice "Your Mac isn't answering" with why; edge still; thread readable from cache | fake down; cached `read_thread` | Built | P1 |
| O2 | Answer offline | Offline, tap an answer | Row "Goes when Life is back"; nothing sent; queue survives app kill and relaunch | none | Built | P0 |
| O3 | Back online flush | O2, then fake up | Each queued answer sent once, in order, with its own saved key; "Back · 2 sent"; rows take Life's state | `answer_check_sent.json` | Built | P0 |
| O4 | Flush after outdated | Queued answer's ask went outdated meanwhile | Life drops it; dropped counted, said once; nothing sent | **new** `answer_check_outdated.json` | Built | P0 |
| O5 | Flaky flush | Fake drops the first flush call | Same key retried; fake records one send | replay of `answer_check_sent.json` | Built | P0 |
| O6 | Undo never queues | Offline, tap Undo | Not queued; refused with offline reason | none | Built | P0 |
| O7 | Queue tied to its Life | Queue offline, re-pair to another origin, come back | Queued answer dropped, never sent to the new Life | two fake origins | Built | P0 |
| O8 | Words offline | Offline, ask in words | His bubble with a small clock; sent when back | as T3 | Built (`sendWaiting`) | P1 |
| O9 | Mac back on foreground | Background 2 min, fake changes, foreground | Reads again at once; out-of-date mark clears | `read_thread.json` new version | Built | P1 |
| O10 | Send in flight not replaced | Tap Send, go offline mid-call, tap again | Second tap neither queues nor sends | as C5 | Built | P0 |

## Notifications

| ID | Flow | Steps | Asserts | Server | Status | P |
|---|---|---|---|---|---|---|
| N1 | Push is the ask | `simctl push` with a `pushId` only | Service extension reads Life and writes title, who, when; no words in the payload | `read_inbox.json` (pushId) | Built (moves to `read_thread`, P4) | P1 |
| N2 | Send from the notification | Expand; tap Send | One `answer_check` to the card's origin with its key; app wakes in background | `read_inbox.json`, `answer_check_sent.json` | Built | P0 |
| N3 | Face ID setting on | Setting on; expand | No Send on the notification | as N2 | Built | P0 |
| N4 | Tap opens the ask | Tap the notification | App opens with that ask unfolded at once from cache, then confirmed | `read_inbox.json`, `read_thread` | Built | P1 |
| N5 | Card changed since the push | Fake changes the card, then Send from the push | Answer goes against Life's current card, refused if outdated; never the kept copy | **new** `read_inbox_outdated.json` | Built | P0 |
| N6 | Push from another pairing | Re-pair, then answer an old push | Nothing sent | two origins | Built | P0 |
| N7 | Push while in front | Push arrives with app open | No banner; asks re-read; count updates | `read_thread` new version | Built | P2 |
| N8 | Answered in notification shows in thread | N2, then open app | Ask in its state; his answer as a bubble with the bell and time | **new** `read_thread_answered_by_push.json` | Prototype (bubble) | P2 |
| N9 | Held asks | Meeting ends; held asks arrive | Rows under one separator "While you were in your meeting · …"; count unchanged while held | **new** `read_thread_held.json` (H) | Prototype | P2 |
| N10 | Mac silent 3 h | Advance clock, no contact | Local notification "Life hasn't checked in since …"; opening the app checks and removes it | fake down; clock control | Built | P1 |

## Profiles

| ID | Flow | Steps | Asserts | Server | Status | P |
|---|---|---|---|---|---|---|
| PF1 | Open a profile | Tap a face | Profile opens over a blurred thread; sections; reach buttons | `read_people_and_organizations_now.json`, `read_person_pictures.json` | Built | P1 |
| PF2 | Organization | Tap an organization's face | Its profile shape | `read_people_and_organizations_organization.json` | Built | P2 |
| PF3 | One level deep | On a profile, tap an ask | Profile closes; his bubble in his words; Life's answer with the ask | **new** `ask_main_session_from_profile.jsonl` | Built | P1 |
| PF4 | Read fails | Fake errors on the person read | "Life didn't open it."; Back works | **new** `read_people_and_organizations_failed.json` | Built | P2 |
| PF5 | Dismiss by drag | Drag down | Closes, face returns | as PF1 | Prototype (drag) | P2 |

## Settings block (and pairing)

| ID | Flow | Steps | Asserts | Server | Status | P |
|---|---|---|---|---|---|---|
| S1 | Pair by link | Open `lifelog://pair?life=…&code=…` | Pair sheet names the server; confirm runs OAuth; token checked before kept | **new** `oauth_metadata.json`, `oauth_token.json` | Built | P0 |
| S2 | Bad pairing keeps the old | Pair with a code the fake refuses | Error shown; old pairing still reads | **new** `oauth_token_refused.json` | Built | P0 |
| S3 | A link never pairs alone | Open a link, dismiss the sheet | Nothing stored, origin unchanged | none | Built | P0 |
| S4 | Re-pair empties actions | Pair to a second fake mid-action | Late events of the first apply nothing | two origins | Built | P0 |
| S5 | Settings block opens Settings | "What can I change?" | Block shows; tap opens Settings | **new** `ask_main_session_settings.jsonl` | Built | P2 |
| S6 | Switch in place | Flip a switch in the block | Tick for a second; one write | **new** `change_setting_*.json` (no tool yet) | Prototype | P2 |
| S7 | Setting offer | Life offers "Later means this evening?" | Two pills; answer once; never shown again | **new** `read_thread_settings_offer.json` (G) | v4.1 | P2 |
| S8 | Instruction as switch | "Stop notifying me about newsletters" | That instruction's switch shows; tap undoes it | **new** | Prototype | P2 |
| S9 | Offline notice settings | Offline; unfold the notice | Phone's own settings (pendant, Face ID, appearance); pairing only on the Mac notice | none | Built | P2 |

## The edge and the aura

| ID | Flow | Steps | Asserts | Server | Status | P |
|---|---|---|---|---|---|---|
| E1 | Edge states | Rest; hold mic; ask; go offline | Edge reports rest, speaking, working, still (an accessibility value) | as T3, O1 | Built | P2 |
| E2 | Background work leaves it idle | Under way item, no turn running | Edge at rest | `read_thread` under way | Built | P2 |
| E3 | Aura colour | "Make it teal" | Edge colour changes; held at band end with Life's line ("Make idle crazier") | **new** `ask_main_session_aura.jsonl` | Prototype (DS builds the component) | P2 |
| E4 | Pendant button | Tap; long press | Pendant sheet; long press offers Settings; pause is one tap | `-fakePendant` scenario | Built | P1 |

## Failures and fix asks

| ID | Flow | Steps | Asserts | Server | Status | P |
|---|---|---|---|---|---|---|
| F1 | Fix ask first | Thread with a fix ask and others | Fix ask ranks first; title is the fix; line "since 11:02"; steps body | **new** `read_thread_fix_whatsapp.json` | Built (as an ask) | P1 |
| F2 | Fix away from home | Fix ask, away | Main answer "Remind me when I'm home"; one answer | **new** `read_thread_fix_away.json` (H) | v4.1 | P1 |
| F3 | Notice settles | Mac back | "Back · caught up" once, then gone | as O3 | Built | P2 |
| F4 | Agents' trouble | `read_registered_agents` reports trouble | Home mark shows it, in plain words, no agent names | `read_registered_agents.json` (**new** trouble variant) | Built | P2 |
| F5 | Budget at 90% | Fake returns the budget fix ask | Ask with raise or slow down; one answer | **new** `read_thread_fix_budget.json` | v4.1 | P0 |
| F6 | Unknown enum | Fake sends an unknown state or block | Item hidden or drawn as unknown; app doesn't crash | **new** `read_thread_unknown.json` | Built | P1 |
| F7 | Deleted entry | J blanks an entry | Entry reads empty; no words of it anywhere | **new** `read_thread_deleted_entry.json` (J) | v4.1 | P0 |

## The smallest P0 set for every push

Twelve flows, about 3 minutes on one simulator, run by the pre-push gate only when `apps/lifelog/apps/ios/` or
`fixtures/wire/life/` changed (one heavy job, never beside another):

1. S1 pair by link, S2 bad pairing keeps the old (pairing)
2. C1 send a draft, C5 dropped mid-send (one key, one send), C3 not sent (new key on retry)
3. C10 no Undo on an iMessage send, C16 outdated while open (no stale send)
4. O2 answer offline (survives relaunch), O3 flush once in order, O4 flush after outdated, O7 queue tied to its Life
5. N2 Send from the notification (one send, right origin)

The rest of the P0 rows run nightly, with the P1s. P0s marked v4.1 or Prototype join this set the day they are built.

## The mock: a scenario file that drives the fake server

One fake, a small Bun server in `apps/lifelog/apps/ios/E2E/fake-life.ts` (Hono is already a dependency), serving what the
app calls and nothing else: the OAuth well-knowns and token, and `/mcp` (JSON-RPC, SSE progress). It reads one
scenario file per test. The app's pairing link refuses plain HTTP, so the fake serves HTTPS on `127.0.0.1` with a
throwaway certificate added to the simulator (`xcrun simctl keychain booted add-root-cert`); no Debug exception.

```jsonc
// E2E/scenarios/C5-dropped-mid-send.json
{
  "name": "C5 dropped mid-send",
  "clock": "2026-11-18T10:00:00Z",          // the fake's now; the app gets it by a Debug launch arg
  "pairing": { "code": "123456", "token": "ok" },   // "token": "refuse" for S2
  "cache": "empty",                         // or "warm": the read cache seeded before launch
  "reads": {                                // tool → responses, in order; the last one repeats
    "read_thread": [{ "fixture": "life/read_thread_draft.json", "version": "v1" }],
    "read_inbox": [{ "fixture": "life/read_inbox.json" }]
  },
  "answers": [                              // answer_check, matched in order
    { "match": { "ref": "dec_000000000001", "options": ["send"] },
      "progress": ["chat_checked", "handed"],
      "drop": "before_result",              // close the stream; "none" | "before_result" | "never_answer"
      "then": { "fixture": "life/answer_check_sent.json" } }
  ],
  "asks": [                                 // ask_main_session, matched by his words
    { "words": "When is the dentist?", "lines": "life/ask_main_session_reply.jsonl", "delayMs": 50 }
  ],
  "network": [                              // the fake's reachability over the run, by step name
    { "at": "start", "reachable": true }
  ],
  "pushes": [{ "at": "after:launch", "pushId": "push_1" }],   // sent with `xcrun simctl push`
  "expect": {
    "sends": { "dec_000000000001": 1 },     // one per ref, whatever the keys: the never-twice check
    "answerKeys": "one_per_tap",            // a replay reuses its key; a new tap after a result makes a new one
    "calls": { "read_thread": ">=1" }
  }
}
```

- Dedupe is the fake's: a repeat of the same answer under any key returns the first result and is not counted as a
  send, as Life does (`answerWithResult`). `expect.sends` is checked after every test, P0 or not.
- The fake logs every call (tool, arguments, key, origin) to the test's folder; a test asserts on the log, not on
  timing.
- Network loss is the fake going unreachable (connections refused), not a simulator network switch, so it is
  deterministic.
- Two origins (O7, N6, S4) run two fakes on two ports.
- The XCUITest target (`LifelogE2E` in `project.yml`) launches the app with `-e2eScenario <file>` and
  `-e2eClock`; the app reads them only `#if DEBUG`, and Release must build without them (the Release check in
  `apps/ios/AGENTS.md`).
- New fixtures are written by Life's server tests (`WRITE_WIRE=1`), so a wire change that breaks the app breaks the
  fixture first. `ask_main_session_*.jsonl` is one JSON line per progress event, then the result.
