# Chat-first Life app: component inventory

Explanation: every UI component the redesigned iPhone app needs, area by area, with what each shows, where its data
comes from, what a tap does, where it appears, what exists today and whether to keep it. An inventory only: not a
design and not a plan. Nothing here is built. Rules come from [`docs/plans/2026-11-23-chat-first-app.md`](../../plans/2026-11-23-chat-first-app.md)
and [`docs/product.md`](../../product.md); today's app from [`docs/handoff/2026-11-23-current-state/app.md`](../../handoff/2026-11-23-current-state/app.md).
Issue #1373 was not readable; its features are taken from the brief and marked "(#1373)".

## How to read it

- **Taps**: act = works in place on the owner's token (`answer_check`, `change_*`), result on the button; open = pushes a
  page or sheet from Life's own reads, no model turn; ask = becomes the owner's words and a turn of the main session.
- **Where**: edge = always-on layer; thread = a block in the conversation; page = pushed with Back; sheet; notification.
- **Today** names a file under `apps/lifelog/apps/ios/Lifelog/` ("ios/") or a board of the previous design canvas
  (Kit boards (a claude.ai copy, since retired): `KitRows`, `KitAnswers`, `KitStates`, `KitToasts`, ...).
  "Sent by Life" means the data is outside data the main session sends, never a ref the app reads.
- Examples use made-up names (Idris, Hélène, Halden house), as the boards do.
- "Unsure" means I did not verify it in code.

## 1. The always-on layer

| Name | What it shows | Its data | Taps | Where | Today | Verdict |
|---|---|---|---|---|---|---|
| Edge glow | Life is there: rest (slow drift, breath), owner speaking (bright, flickering), Life answering (one light running round), answer landed (one breath), unreachable (still, dim) | The phone's own state: dictation level, the `ask_main_session` stream lines (`thinking`, `working`, `words`, `answer`), `LifeConnection.lost`; Reduce Motion | none | edge | new. Nearest: `AskLifeMark`, `AskLifeLightLine`, `WorkingArc`, `AskLifeVeil` in `DesignSystem/AskLifePieces.swift` (unsure how much is reusable); needs the brand exception first (plan) | new |
| Text and voice field | The owner's words field with mic; hold to talk, slide up to send; live words while listening | Local dictation (`Dictation/DictationCapture.swift`); sends `MainSessionAsk` with `screen` refs | mic = act (local); Send = ask | edge | `DesignSystem/DictationField.swift` (`DictationMic`, `SendKey`, `LiveWordsText`, `ListeningLine`); boards `KitDictation`, `DuoFoldDictRest/Ask/Filled` | keep (becomes the one field; merge `AskLifeButton`, `AskLifeControl` strip and stage into it) |
| About-this-page chip | What the next words are about (the open page's name), removable | `MainSessionScreen` (`open`, `visible` up to 20 refs; `AppRouter.mainSessionScreen`) | x = act (local, drops the context) | edge, above the field | partly: board `NavV3AskTell` ("Tell Life..." with the ask as a context chip) | new |
| Waiting-on-you pill | Count of what blocks the owner; gone when zero (never says all is well) | `blockingCountOf` / `read_inbox` badge (`memory/check-urgency.ts`); same words as the shortcut bubble | open: plays the shortcut (a code-built bubble pair "What's waiting on me?" + rows, never a model turn) | edge | `AskLifeWaitingPill` (`DesignSystem/AskLifePieces.swift`, meaning unsure); `CountBadge`; board `NavV3HomeZero` for zero | keep (change role) |
| Pendant pill | Pendant state: recording dot, flag when something needs the owner (not paired, offline, battery low, not recording) | `CaptureStore` / `PendantReading` on the phone; no server read | open: Pendant sheet (instant, local). Never a turn | edge | `Shell/TopBar.swift` `PendantItem`; board `VisFoldPendant` | keep |
| What is wrong first | One plain line of what is broken plus the one button that fixes it, before the waiting pill; thread opens on it | Phone judges its own part (pendant, network, Mac reachable); Mac part from `read_life_status`, `agentHealthOf`/`deskHealthOf`, messaging status, `ConnectionSummary` | one button = act (fix) or open (Settings page/sheet) | thread top (opens on it) + edge when unreachable | new. Pieces: `Pendant/IncidentCards.swift`, `Shell/ReadScreen.swift` (`Notice`, `SyncNote`), `Connection/ConnectionSummary.swift` | new (merge those three into it) |
| Suggestion buttons | A few buttons under Life's answer or on the empty thread ("What's waiting on me?", page-specific asks) | Code for the fixed ones; the session for others (open question in the plan) | ask (the button's words become the owner's words) except "What's waiting" = open (shortcut) | thread, above field | new. Nearest: `FilterChip`, `QuietChip` (`DesignSystem/Pieces.swift`) | new |
| Back bar | "Back" on the first page, destination name from the second ("‹ Boiler repair"); title pill when scrolled | Router stack | open (pops) | page | `Shell/TopBar.swift` `ShellBar`; board `NavV3ThreadPill` | keep (rewrite: today's bar carries pendant and Ask Life buttons) |
| Reachability mark | "Showing what was last read, 10 min ago" / "Life can't be reached" | `ReadState.Shown` (stale/unreachable), `LifeConnection` | tap = act (retry) | edge line / top of page | `Shell/ReadScreen.swift` `SyncNote`, `Notice`; boards `KitMissing`, `DuoFoldSyncOffline`, `NavV3DrawerOffline` | merge into "What is wrong first" and the edge's dim state |

## 2. The thread: the owner's words and Life's answer parts

| Name | What it shows | Its data | Taps | Where | Today | Verdict |
|---|---|---|---|---|---|---|
| Owner bubble | His words (typed or dictated), marked with where they were asked when asked on a page | The phone's own text; page ref | none (long press copy: unsure) | thread | `AskLife/AskLifeStage.swift` shows the caption; no bubble | new |
| Shortcut bubble | The tap said aloud ("What's waiting on me?"), not his words | Built by code; reaches the session as a screen event, never as `said` | none | thread | new | new |
| Life's words | Text with `life:<ref>` links (matter, person, appointment, message...), Markdown | `MainSessionAnswer.words`; refs resolved by `fetch` (`LifeLinkRead`) | link = open (sheet or page) | thread | `DesignSystem/ContextSheet.swift` (`ContextView`, `LifeLinkPage`), `Kit/ContextMarkdown`; `AskLifeAnswerView` | keep (merge `ContextView` and answer text) |
| Working line | "Checking the chat..." per tool call; thinking | `MainSessionLine` `thinking`, `working{id,title,state}` | none | thread (live, replaced by the answer) | `AskLifePieces` `AskLifeStrandRow`; `SessionLineView` is the agent session's, not this | keep (`AskLifeStrandRow`) |
| Why line / sources | One line of why and up to 5 source refs | `answer` extras `why`, `sources` | source = open | thread, under words | `AskLifeAnswerView` (unsure of the exact look) | keep |
| Question with answers | Life's question with 2 to 4 tappable likely answers | `kind: question`, `answers` | each = ask (words become the owner's) | thread | `AskLifeAnswerView` | keep |
| Done line | What Life did on his words: a correction, an agent told, a card asked, a complaint received (`done`/`agent`/`card`/`fix`), with a link to it | `MainSessionAct` | link = open (matter, agent page, card) | thread | `AskLifeAnswerView` chips ("open the card/matter"); board `DuoFoldFixList`, `DuoFoldFixApplied` | keep; agent shown without its name (product.md rule 8, see section 9) |
| Note with See | "Answer ready" when he is on another page; goes after 8 s, answer waits in thread | Answer arrival | See = open (back to thread at the answer) | edge / over page | `AskLifePieces` `AskLifeNote` (unsure) | new (proposed in plan) |
| Error line | What failed; his words kept, Try again | `kind: error`, `what` | Try again = ask (same key) | thread | `AskLifeAnswerView`; `KitStates` failed pattern | keep |
| Offline line | "Goes as soon as it's back" (queued) | Phone state (`offline` is never on the wire) | Cancel = act (local) | thread | `AskLifeStage` stage `offline` | keep |
| Cancelled / Undo | "Nothing sent. Undo" for 4 s | Local | Undo = act (local) | thread / toast | `AskLifeControl` | keep (merge into toast) |
| Show more | "Show the other 6" expands in place | Block's refs | act (local) | thread | `DesignSystem` `LimitNote` (unsure); `KitRows` "Show more" not found | keep |
| Empty thread | Nothing, or What is wrong first, then the pill. No "all is well" | n/a | none | thread | `InboxScreen` `InboxZero`; board `NavV3HomeZero` | drop the message, keep as nothing |

## 3. Cards (decisions and checks) as they render

A card is a `Check` (`LifeConnector/Models/Check.swift`, group `CheckGroup`). Today one `CheckCard` draws all of them
from parts (`Inbox/CheckCard.swift`, `CheckBodies.swift`, `CheckActions.swift`), a pager shows one at a time. In the
thread each card is a block; the parts below are its components.

### 3.1 Card shell and its parts

| Name | What it shows | Its data | Taps | Where | Today | Verdict |
|---|---|---|---|---|---|---|
| Card block | Matter chip, title, question, why-now line, thing tile, deadline, answers | `read_inbox` check; `request_decision` shape `Ask` (`memory/card-request.ts`) | see parts | thread, page (matter, person), notification expanded | `Inbox/CheckCard.swift`, `CardView.swift`; boards `KitRows`, `NavV3HomeFold` | keep (drop `CardPage` pager) |
| Answer buttons | First answer full width, others in a row, two rows max; icon per verb; his own words last | `options` (id, label, icon, `takes`, `outgoing`, `ends`, `adds`, `runs`, `looks`) | each = act (`answer_check`); "Tell the agent..." = act with `note`; `takes` person/name opens the picker | card | `Inbox/CheckActions.swift`; `ActionCopy.swift`; boards `KitAnswers`, `GlassSendA` | keep |
| Answer states | Working step ("Checking the chat...", "Sending on WhatsApp..."), Undo ring 4 s, Sent (green), not-done with reason in flag | `AnswerResult` (`host/answer-result.ts`), send steps (`sendStepsOf`) | Undo = act | card | `Inbox/AnswerResultView.swift`, `ResultButtons`; boards `KitAnswers`, `GlassDone`, `GlassDropUndo`, `NavV3HomeSent`, `NavV3HomeFailed` | keep |
| Deadline line | "by Thu 18:00" in flag when near | `deadline` (`DeadlineWords`) | none | card | `CheckActions` | keep |
| Why it asks | One line, opens the context sheet | `context` Markdown with `life:` links | open (sheet) | card | `DesignSystem/ContextSheet.swift`; board `NavV3ThreadWhy`, `DuoFoldTextButtonsCard` | keep |
| Source chip ("gathered") | Where the evidence came from | `gathered`, `links` | open (message, call, file) | card | `PlanBlock` footer; board `KitSources` | keep |
| "Wrong..." | Life's own card was misread; opens a complaint | `check.misread`; `complain` via main session | ask (complaint to the caretaker, `complainThroughAskLife`) | card | `CheckActions` | keep (becomes an ask) |
| Being fixed line | Caretaker is on it | `beingFixed` (`withComplaintFields`) | none | card | board `DuoFoldFixList` (unsure of code) | keep |
| Replaces-older-draft line | "Replaces an older draft" | `check.replaces` | none | card | `DraftBlock` (marked ponytail: placeholder) | keep, design |
| Looking / seen line | "Looking..." then "Paid, 4,500 THB" / "Not found yet" | `doneSeen` (`host/done-seen.ts`) | "Looking" option = act (`looks`) | card | `CheckBodies.swift` `DoneSeenLine` | keep |
| Bulk card | Several ticked-by-Life checks folded in one | `Inbox` bulk | act / open | thread | `Inbox/BulkCard.swift` | unsure: product.md says settle what Life can read; probably drop (see section 12) |
| Card in a notification | Title, subtitle, body (40/40/110), whole draft as text, Send / Reply... | `CardNotification` | see section 11 | notification | `NotificationService/`, `NotificationContent/` | keep |
| Card answered | The row reads "Sent at 9:14"; count down by one | answered-card memory (`AnsweredCards`) | open (card) | thread | `LifeStore` `AnsweredCards` | keep (new look) |

### 3.2 Card kinds (`CheckGroup`)

| Name | What it shows | Its data | Taps | Where | Today | Verdict |
|---|---|---|---|---|---|---|
| Decision (agent question) | Question, options, optional draft, needs, plan | `decision` check | answers = act | thread, matter page | `CheckCard` | keep |
| Plan card | Steps (his in bold, the agent's with its program mark), Start the plan / Decline | `plan` steps, `PLAN_OPTIONS` (`start`, `decline`) | act | thread | `CheckBodies.swift` `PlanBlock`; boards `NavV3HomePlan`, `DuoFoldStackPlan`, `DuoFoldStackPlanLong` | keep, but the agent's mark must go (rule 8; unsure whether program mark counts as a name) |
| Ending check | "Is this done?" Yes / still open; shown on the matter page only | `ending`; `isInboxCheck` false | act | matter page | `EndingBlock`; boards `NavV3ThreadLooksDone` | keep (page section) |
| Name check | Who is this name (a name Life cannot place) | `name` | pick person/new = act via picker | thread | `NameBlock`, `CreateSheet`; boards `DuoFoldOrgNameCard`, `DuoFoldPersonCreate` | keep |
| Voice check | Name an unnamed voice, with Life's guess and a clip | `voice`; `VoiceBlock`; queue by lifelog | play = act (local); Yes / pick / new = act | thread | `VoiceBlock`, `NameVoices.swift` (`NameVoicesRun`), `Playback/` | keep |
| Contacts card check | Add this Contacts card to someone | `contacts card` | act | thread | `ContactsCardBlock` | keep; unsure whether Life can settle most of these unseen |
| Guessed person | "Are these the right people?" Yes / No per guess | `guessed person`; `GuessRows.swift` (`YesNo`) | act per row | thread | `PersonIdentityBlock`, `GuessRow` ; board `GuessNetworks` | keep |
| Same person | Are A and B the same | `same person`; `SameAsSheet` | act; pick = sheet | thread | `SamePersonTile`, `SameAsSheet.swift` | keep |
| At organization | "Is X at <organization>?" with the role | `at organization` | act | thread | `CheckBodies` (unsure which struct), board `DuoFoldPersonCreateOrg` | keep |
| New matter | Start / Dismiss, edit goal | `new matter` | act; goal edit = act | thread | `NewMatterBlock` | keep, probably rare (hand-out) |
| Your move | A step of his on a matter: Mark as done, Not now, Drop, Hand over | `yourMovesOf` | act | thread, matter page | `Inbox/MovesList.swift`; `MovesList` swipe | keep |
| Unknown kind | Life's `line` | `UnknownTolerant` | none | thread | `CheckCard` fallback | keep |

### 3.3 Needs (`memory/needs.ts`) as they render (`NeedsBlock`, `Need.swift`, `Check.payCode`)

| Name | What it shows | Its data | Taps | Where | Today | Verdict |
|---|---|---|---|---|---|---|
| Account need | Bank, number (copy), holder to check | `account` (scheme picks bank app) | copy = act (local, this phone only) | card | `CheckBodies.swift` `NeedsBlock`; `BankAppChoice` in `AppsPage.swift`; `BankTrip` | keep |
| Amount need | Big figure, copy plain number | `amount` | copy = act | card | `NeedsBlock` | keep |
| Link need | Vendor, host in full, open | `link` (https only) | open (Safari) on his tap | card | `NeedsBlock` | keep |
| App need | App name, open its https link | `app` | open | card | `NeedsBlock` | keep |
| Event need | Title, time, where, reminders; "Add to calendar" is the card's `adds` answer | `event` | `adds` = act (`addEventByHisWord`) | card | `NeedsBlock`; `KitCalendarAdds`; `DuoFoldToast` | keep |
| Place need | Name, Google Maps, Apple Maps, Bolt ride | `place` | open | card | `NeedsBlock` | keep |
| Text need | A fact in hand (reference, code), optional copy | `text` | copy = act | card | `NeedsBlock` | keep |
| QR need | The QR drawn from `payload`, saved to photos; else `source` words | `qr`, `Check.payCode` | save = act (local); source chip = open | card | `Inbox/PayCodeBlock.swift`, `DesignSystem/QRTile.swift`; boards `DuoFoldStackPayQr` | keep |
| Apify need | Which actor, estimate, cap, input; "Run it" is the `runs` answer | `apify` (`APIFY_RUN_MAX_USD` 20) | `runs` = act | card | Need.swift returns no rows for `.apify` (`Life's line` only), so no dedicated view | new |
| Payment card | Account + amount + "Looking" + bank trip | account, amount, `doneSeenBy` | bank app = open; Looking = act | card | boards `DuoFoldStackPay`, `DuoFoldStackPayQr` | keep |
| Call card | A call with what to say | unsure (a need kind? `text` points) | open (`tel:`) | card | board `DuoFoldStackCall` | unsure |
| Card-only-you | "Only you can do it" card | card with no agent step | act | card | board `DuoFoldStackOnlyYou` | keep |

### 3.4 Drafts per channel (`DraftBlock`, `ChatHead`, `ChatLook.of(channel)`)

| Name | What it shows | Its data | Taps | Where | Today | Verdict |
|---|---|---|---|---|---|---|
| Chat draft (WhatsApp, LINE, Messenger, Instagram, LinkedIn, Telegram, iMessage) | Chat head (name, network mark), last messages as context, the drafted bubble in the platform's look, mentions, quote | `Check.draft` (`StoredDraft`: `channel`, `recent`, `quoted`, `text` runs) | Send = act (outgoing option; sends exact stored draft); "Adjust" = ask (new, #1373) | card, notification expanded, agent's chat (new, #1373) | `DesignSystem/DraftBlock.swift`, `ChatHead`, `Drafted`; boards `DuoFoldDraftWhatsApp` | keep |
| Reply / quote part | The message replied to, in the platform's quote | `quoted` | none | draft | `DraftBlock.quote` | keep |
| Reaction draft | The message reacted to, emoji on its corner | `reaction`, `quoted` | Send = act | draft | `DraftBlock`; board `DuoFoldDraftReaction` | keep |
| File draft | File row (name, size, kind glyph) with or without caption | `file` (real path, digest) | Send = act | draft | `DraftBlock.fileRow` | keep |
| Mail draft | From, To (~ when guessed), Cc, Subject, body, attachment, last message of thread | `draft.isMail`; `mailSheet` | Send = act | card | `DraftBlock` mail; board `DuoFoldDraftMail` | keep |
| GitHub draft | Comment, or new issue with title; text only | `draft.subject` (title) | Send = act | card | `DraftBlock.draftContent` shows subject; no GitHub look (unsure) | keep; check look |
| Draft sent / not sent | Ticks in place; "not sent" reopens; "may have gone" stays | `DraftDelivery`, send outcome | Try again = act | draft | `DraftDelivery`; board `DuoFoldDraftSent`, `NavV3HomeFailed` | keep |
| Draft preview in an agent's chat (#1373) | The draft with Send inside the agent's own thread | Same as chat draft; thread of the agent | Send = act | agent page | new (today `AgentSessionPage` is read-only) | new |
| Adjust (#1373) | "Make it shorter / warmer" on a draft; rewrites in place | Main session turn then new card | ask | draft | new (today "Tell the agent..." field) | new |
| "Draft an answer for X?" (#1373) | Before an agent starts: a short yes/no card naming the person and message | Arrival reader (`confirmedArrivalsOf`); unsure server side | Yes = act; No = act | thread | new | new |

## 4. Rows and lists

| Name | What it shows | Its data | Taps | Where | Today | Verdict |
|---|---|---|---|---|---|---|
| Matter row | Matter icon, name, next step, flag dot if it waits on him, spinner if Life works | `read_matters` (`MatterRow`; icon by `iconNow`) | open (matter page); swipe: main answer; long press menu | thread (list block), project page, person page | `Matters/ProjectsList.swift` `MatterRowView`; board `KitRows`, `NavV3SwipeMain`, `NavV3DrawerMenu` | keep (swipe/long press: keep only if discoverable, unsure) |
| Matter list | A cut list (up to 50 refs) with a label and Show more | `show` list `matters` (`MainSessionShow`) | open row | thread | `Shell/HomeList.swift`, `Matters/ProjectsList.swift`; board `NavV3DrawerCut` | keep (becomes a block) |
| Person row | Picture, name, standing, dot if he waits on them | `read_people_and_organizations`, `read_person_pictures`, `partyOf` | open (person page) | thread, lists | `People/PeopleScreen.swift` `PersonRowButton`; `DesignSystem/PersonPieces.swift`, `PartyPieces.swift` (`PartyDisc`, `PartyChip`) | keep |
| Organization row | Square avatar, name | same | open | thread | `OrgPage`, `PartyDisc` square; board `NavV3PeopleOrgs`, `KitPeople` | keep |
| People list | cut list (50 refs) with label | `show` list `people` | open row | thread | `People/PeopleScreen.swift` | keep (drop A-Z index, search, columns: `PeopleColumns`) |
| Check row | One waiting ask as a row (flag dot, question, deadline) | `checks` list | open card (inline expand) | thread (the "what's waiting" answer) | `Inbox/CheckList.swift`; boards `NavV3DrawerMenu`, `NavV3NoMatterA` | keep |
| Appointment row | Time, title, place, "(Life)" mark, from which message | `read_appointments` (`Appointment.swift`) | open (appointment sheet) | thread, matter thread | `Shell/AppointmentSheet.swift`; `ThreadLines` `.event`; boards `DuoFoldCalendarSheet` | keep |
| Payment row | Merchant, amount (EUR too), category, day | `read_payments` / `Payment.swift` | open (unsure what) | thread | `LifeConnector/Models/Payment.swift`; no list view found | unsure: new row if payments must be shown |
| Spending row / figures | Billed today and this month, trend, by provider and kind, top matters | `read_spending` (`ModelSpending.swift`) | open (sheet) | thread (on ask) | `Settings/SpendingPage.swift` (`SpendFigures`, `SpendingLine`); board `NavV3SpendingFold` | keep (reached by asking) |
| Agent work line (no agent name) | "Life is working on it", what it is doing, a spinner | `read_registered_agents` assignments per matter (`MatterRow` spinner) | open (matter) | matter page, thread | `Matters/MatterThreadPage.swift` ("Life is on it"); today's `AgentRow`, `AgentListRow` show agent marks and names | merge into matter row/page; drop agent list |
| Open to-do item row | A to-do with due day, tick | `read_open_todo_items` | tick = act (`change_todo_item`) | thread | none in app (to-dos appear as thread lines only) | new if asked |
| Place row | Visited place, time | `read_places_visited` | open (map: unsure) | thread | none | new if asked (unsure) |
| Day row | A day's summary | `read_day` | open | thread | none | new if asked (unsure) |
| Message / chat line | A quoted message from a chat, with who, when | `fetch msg:...`, `read_chats`, `ChatStrip.swift` | open (message sheet via `life:` link) | thread | `LifeLinkPage`; `Matters/ThreadLines.swift` | keep |
| Row group / row | Rounded group with rows 56+, trailing state | design system | n/a | page | `DesignSystem/Components.swift` (`Row`, `RowSwitch`...); board `KitRows` | keep (settings and page sections) |

## 5. Page headers and page sections (pushed with Back)

| Name | What it shows | Its data | Taps | Where | Today | Verdict |
|---|---|---|---|---|---|---|
| Matter header | Icon, name, goal (editable), next step (editable), people line, project, span, Life's line, flag | `read_matter` (`goal`, `nextStep`, `MatterView`) | icon = open sheet; goal/next step edit = act (`correct_memory` direction); people chips = open | page | `Matters/MatterThreadPage.swift` (`Goal`, `NextStep`, `EditableLine`, `People`); boards `NavV3ThreadFold`, `NavV3ThreadEditNext` | keep |
| Matter status actions | Mark done, Drop, Reopen, Let Life work on it, Important | `correct_memory` matter kinds | act | page | `DoneButton`, board `NavV3ThreadDoneUndo`, `NavV3ThreadClosed`, `NavV3ThreadNoLife` | keep |
| Matter thread | Day-by-day lines (messages, calls, voice, payments, events, to-do items), day rules, asks with answers | `fetch <id>/thread` (`readMatterThread`), paged by whole days | line = open; ask = act | page | `Matters/ThreadLines.swift` (`DayRule`, `ThreadLineView`); `OlderAsk` | keep |
| Matter waiting asks | Open cards of this matter | `checksOnMatterOf` | act | page | `MatterThreadPage`; boards `NavV3ThreadAsksNext` | keep (same card block) |
| Matter cost line | What Life spent on it | `readMatterSpending` | none | page | board `NavV3ThreadFold` | unsure; likely drop (rule 8) |
| Person header | Picture, name, standing, reach tiles per app | `read_people_and_organizations` one, `fetch reach` (`reachOf`) | picture = open (Pictures sheet); tile = open the app/chat link | page | `People/PersonPage.swift` (`Who`, `HeadPicture`, `ReachTiles`); boards `NavV3Person`, `DuoFoldPersonReachMenu`, `DuoFoldPersonReachStates` | keep |
| Person: open matters | Matters with this person | `read_matters` (person) | open | page | `OpenMatters` | keep |
| Person: lately | Recent exchanges summary | `now` part | none | page | `Lately` | keep |
| Person: details | Birthday, home, work, family, handles | `detailsOf` | open (call/mail link) | page | `Details`, `DetailRow` | keep |
| Person: what Life knows | Prose page | `fetch` part `page` | open (full page) | page | `Knows`, `ProsePage` | keep |
| Person: latest exchanges | Latest chats/mail/recordings | `readPersonUnits`, `fetch latest` | open | page | `Latest`, `LatestScreen`, `ExchangeView` | keep |
| Person: how each writes | Communication style (for drafting) | `readCommunicationStyle` | open | page | `WritingPage` | keep (unsure if shown to owner) |
| Person: ask on this person | Asks about this person (no-matter cards) | `noMatterChecksByPartyOf` | act | page | boards `NavV3NoMatterPerson`, `NavV3NoMatterPersonDone` | keep |
| Person: change picture / name | Picture grid, create person, same-as | `change_directory_entry` | act | sheet | `PicturesSheet`, `CreateSheet`, `SameAsSheet` | keep |
| Organization page | Members now and before, matters, last exchange, domains | as person | open | page | `People/OrgPage.swift` (`MemberRow`, `Domains`); board `NavV3Org` | keep |
| Project page | Situation, status menu (Underway / Parked / Done), goal it serves, its matters, details (people, chats, repos) | `read_project` | status = act (`change_directory_entry`); open matter | page | `Matters/ProjectHead.swift`, `ProjectDetails.swift`, `ProjectAsk`; board `NavV3Project` | keep |
| Project list | Underway projects, areas as chips, parked/done | `read_projects` | open | thread (cut list) | `ProjectsScreen`; board `NavV3Projects` | keep list only; areas chips drop |
| Area page | An area's page | `read_area_page` | open | page | none found (areas shown as chips) | new if asked (unsure) |
| Agent page | State, wakes, moves; Start/stop/resume/hand over; Continue on your Mac | `read_registered_agents`, `read_agent_session` | act (`change_registered_agent`) | page, only in diagnostics | `Matters/AgentPage.swift`, `AgentSessionPage.swift`, `AgentSheet`, `StartAgentSheet`; boards `NavV3DiagWorker`, `MacOpenAction` | merge into diagnostics (rule 8) |
| Nightly page | Done, Moved, Agents, people, birthdays, code, health | nightly report (mail today) | none | not an app page today (board proposals `DuoFoldNightly*`) | unsure: proposals only | unsure, see section 12 |

## 6. Outside-data blocks (sent by Life; session picks, app lays out)

Planned in the chat-first plan ("Designed shapes for outside data"); capped in count and length, shown as data, links
open only on the owner's tap. None exists in the app today.

| Name | What it shows | Its data | Taps | Where | Today | Verdict |
|---|---|---|---|---|---|---|
| Choices with links | Options from a web search (e.g. three trains, each with time, price, link) | sent by Life (`show` block, capped) | link = open (Safari, host shown in full) | thread | new. Nearest: `NeedsBlock` link row | new |
| Key facts | A few label/value lines (a flight, an address) | sent by Life | copy = act (local) | thread | new. Nearest: text need row | new |
| Comparison | Two or three options side by side | sent by Life | none / open | thread | new | new |
| Simple chart | A small chart (e.g. spending by day) | sent by Life, or `read_spending` days | none | thread | new. Nearest: `SpendFigures` | new |
| Map / place card | A place with map links | sent by Life or `read_places_visited` | open (Maps) | thread | Place need rows only | merge into Place need |
| "No block fits" miss | Life answers in words and records the miss | n/a | none | n/a | n/a | not a component |

## 7. Toasts, undo, notices

| Name | What it shows | Its data | Taps | Where | Today | Verdict |
|---|---|---|---|---|---|---|
| Toast: done | A check, what he did, optional Undo (4 s) | `SaidBack` (`LifeStore.saidBack`) | Undo = act | over page | `DesignSystem/Pieces.swift` family `Toast`, `SaidBackToast`; board `KitToasts` | keep |
| Toast: event | Something happened without his tap (event added to calendar; Life did X) | `calendar.added` push, `ActionBook` | open | over page | `Toast`; boards `DuoFoldToast`, `DuoFoldPushCalendar` | keep |
| Toast: trouble | A filled flag dot: trouble that asks nothing of him now | local | none | over page | `Toast` | merge into What is wrong first |
| Toast: filter | "Showing 3 matters" with X | Ask Life cut | X = act (local) | over list | `CutToast`; board `NavV3DrawerCut` | drop (no lists to cut: the block is the list) |
| Sync mark | "Showing what was last read" | `SyncMark` | none | over page | `SyncNote` | merge into reachability mark |
| Inline flag line | The reason a write failed, above the same answers | `ActionKey` result | none | card | `ProblemLine` | keep |
| Pill (busy) | A spinner pill | local | none | any | `InlinePill`, `Spinner` | keep |

## 8. Empty and error states

| Name | What it shows | Its data | Taps | Where | Today | Verdict |
|---|---|---|---|---|---|---|
| Loading | One word, a spinner, no skeleton | `ReadState.loading` | none | page, block | `Placeholder`, `RowsPlaceholder`; `KitStates` | keep |
| Empty | Status word, one note, at most one quiet button (never "all is well") | `ReadState.empty` | optional act | page | `Placeholder`; `InboxZero` | keep (rule 9: a page may be empty) |
| Stale | The last good read, marked | `ReadCache` | none | page, block | `ReadScreen`, `SyncMark` | keep |
| Unreachable | "Life did not answer in 10 s" + Try again | `LifeConnection` | Try again = act | page, edge | `ReadScreen`; `KitMissing` | keep |
| Failed | Label in flag, note, Try again | `ReadState.failed` | act | page, block | `ReadScreen`; `KitStates` | keep |
| Not paired | "This phone is not paired" + Pair with Life | `ReadState.notPaired` | open (pairing) | page, thread | `ReadScreen`; `Settings/PairSheet.swift` | keep |
| Part did not load | "<part> didn't load" + retry inside a page | per-part read | act | page section | `People/PersonParts.swift` `PartRetry` | keep |
| Dead link | A `life:` link that no longer opens | `fetch` error | none | thread | unsure | unsure |

## 9. Pickers and sheets

| Name | What it shows | Its data | Taps | Where | Today | Verdict |
|---|---|---|---|---|---|---|
| People picker | Pick a person for a card's `takes: person` or for "same as" | `read_people_and_organizations` | pick = act | sheet | `Inbox/SameAsSheet.swift`; `PartyPick`; board `DuoFoldPeopleSheet` | keep |
| Create person / organization | Name, kind; or a name Life cannot place | `answer_check` (`addDirectoryEntryByHisWord`) | act | sheet | `Inbox/CreateSheet.swift`; boards `DuoFoldPersonCreate`, `DuoFoldOrgCreate` | keep |
| Voice naming run | One voice at a time with clip | lifelog voices | act | sheet / thread | `Inbox/NameVoices.swift` | keep |
| Calendar / appointment sheet | When, where, source message, matter; Open in Calendar, Remove / Undo | `read_appointments`, `change_appointment` | Remove = act; Open = open | sheet | `Shell/AppointmentSheet.swift`; boards `DuoFoldCalendarSheet`, `DuoFoldCalendarSheetRemoved` | keep |
| Date / time choice for "Remind me..." (#1373) | Several choices (this evening, tomorrow, in a week, pick) | Life proposes, he picks | pick = act (`change_todo_item` or card) | thread / sheet | new; unsure what exists server side (handoff: no owner-facing timed reminder found) | new |
| Icon grid | 72 symbols, "Let Life pick" gives it back | `correct_memory` `matter-icon` | act | sheet | `Matters/MatterIconSheet.swift`, `DesignSystem/MatterIconPieces.swift` (`IconGrid`); board `KitRows` | keep |
| Pictures sheet | A person's picture choices | `change_directory_entry` | act | sheet | `People/PicturesSheet.swift` | keep |
| Context sheet | A card's context or any `life:` link, Markdown | `fetch` | link = open | sheet | `ContextSheet`, `LifeLinkPage` | keep |
| Pair Life | Confirm pairing from a link or code | `lifelog://pair?life=...&code=...`; OAuth | act | sheet | `Settings/PairSheet.swift` | keep |
| Pendant sheet | State, battery/storage, what is not on the Mac, pair / replace, recovery cards | `CaptureStore`, `SyncStore` | act | sheet | `Pendant/PendantView.swift` (+ `PairPendantSheet`, `ReplaceSheet`, `IncidentCards`, `OmiCustodyCard`) | keep |
| Start agent sheet | Program and model for a matter | `change_registered_agent` start | act | sheet | `Matters/StartAgentSheet.swift` | drop from main path ("Let Life work on it" replaces it; board `NavV3ThreadNoLife`) |

## 10. Settings and diagnostics (still needed, reached by asking)

By product.md rule 4 each is reached by "show me my settings"; no Profile row. Today they live under `Profile/ProfileScreen.swift`
and `Settings/`.

| Name | What it shows | Its data | Taps | Where | Today | Verdict |
|---|---|---|---|---|---|---|
| Settings page | Needs-you rows, permissions (location, notifications, dictation), Face ID before Send, transcribe, pendant options, look, appearance, help | server `settings`, `OwnerSettings` | switches = act | page | `Settings/SettingsView.swift` (512 lines); `RowSwitch`, `RowValue` | keep |
| Connection | Address, pair/unpair Life and the Voice host, queue waiting, refused edits, check | `ConnectionCheck`, `LifePairing`, `ServerAPI` | act | page | `Settings/ConnectionPage.swift`, `Connection/` | keep |
| Notification levels per kind | off / quiet / normal / urgent | server `notifications` setting | act | page | unsure: no iOS view found | unsure |
| Spending page and budget (#1373) | Month, soft cap amount, burn rate projection, prepaid balance | `read_spending`; budget not in server code (handoff section 6: "none found") | act (set cap) | page / card | `Settings/SpendingPage.swift`, board `NavV3SpendingFold` | keep + new (budget) |
| Diagnostics | Checks, agents' health by project, Copy a report | `read_registered_agents`, `agentHealthOf`, `read_inbox` | act | page | `DiagnosticsView.swift`; boards `NavV3Diagnostics`, `NavV3DiagWorker`, `NavV3DiagSession` | keep (the only place the technology shows) |
| Agent session viewer | What Life sent, tool calls (code type) | `read_agent_session` | none | page (diagnostics) | `Matters/AgentSessionPage.swift` | keep (diagnostics only) |
| Live logs | Life's log lines, level filter, detail sheet | `read_log_lines` | open line | page | `Settings/LiveLogsPage.swift`, `LogPieces.swift`; boards `DuoFoldLogs` | keep |
| Vocabulary | Words for dictation | local | act | page | `Settings/VocabularyView.swift` | keep |
| Apps | Apps for payments (bank apps) | local | act | page | `Settings/AppsPage.swift` | keep |
| Backup / restore | Library backup | `BackupStore` | act | page | `Export/BackupView.swift` | keep |
| Light guide | Pendant light meaning | local | none | page | `Settings/LightGuide.swift` | keep |
| Ask Life look | Choice of look | `@AppStorage` | act | page | `AskLife/AskLifeSettings.swift` | drop (the look is the redesign) |
| Mac admin access card (#1373) | "Confirm Mac admin access to do X": what, why, one Confirm | no server support found (handoff section 8: none) | act | thread, notification | new | new; server side missing |

## 11. Notifications and Watch

| Name | What it shows | Its data | Taps | Where | Today | Verdict |
|---|---|---|---|---|---|---|
| Card notification | Title, subtitle, body written by the phone from the card; draft as text | APNs payload `pushId`, `CardNotification` | tap = open card in thread | notification | `NotificationService/`, `Lifelog/IncidentNotifier.swift` | keep |
| Reply... action | Text input, sends the words as the answer | `answer_check` with `note` | act | notification, Watch | category `life.card` | keep |
| Send action | Send button on a draft card, under the whole draft; needs unlocked phone / Watch (Face ID by setting) | `answer_check` outgoing option | act | notification, Watch | category `life.card.send` | keep |
| Expanded notification | The draft block and the card's one-tap options | card kept in payload | act | notification | `NotificationContent/` (`DraftBlock`) | keep |
| Appointment push | "Life added X to your calendar": Remove, Open in Calendar | `calendar.added` | Remove = act | notification, Watch | category `life.calendar`; boards `DuoFoldPushCalendar*` | keep |
| Removed cards | Silent push removes notifications of cards that left | `removed` | none | notification | `NotificationRoute.removed` | keep |
| Pendant incident | Recording stopped, storage low, disconnected, battery low, Bluetooth off, transfer incomplete... | `CaptureCondition` (phone) | tap = open Pendant sheet | local notification | `IncidentNotifier.swift`, `Kit/Incidents` | keep |
| Life or Voice host unreachable (#1373) | "Life can't be reached" / "The Voice host can't be reached" | Phone-judged (a push needs the Mac, which is what is down); handoff section 5: no condition today | tap = open What is wrong first | local notification | new (no `CaptureCondition` for it) | new |
| Standing-intention nudge (#1373) | "It's time to call Sam" with a draft and Send | card with draft; server mechanism not found (handoff section 7) | Send = act | notification | new | new |
| Budget warning (#1373) | Burn-rate warning, once, with raise / slow down | `read_spending`; no server budget | act | notification, thread | new | new |
| Watch notification | Same actions | same | same | Watch | Watch app is recording remote only (`Watch/`) | keep |
| Watch recording remote, complication, widgets | Recording control, state | `SnapshotPublisher` | act (pause/resume) | Watch, widgets | `Watch/`, `Widgets/` | keep (outside the chat) |

## 12. Pairing and onboarding

| Name | What it shows | Its data | Taps | Where | Today | Verdict |
|---|---|---|---|---|---|---|
| Not-paired state | "This phone is not paired with a Mac", Pair with Life | `ReadState.notPaired` | open | whole app (thread cannot work) | `ReadScreen` | keep (this is the empty app) |
| Pairing link / code | Confirm sheet from a link | `PairOffer(link:)` | act | sheet | `Settings/PairSheet.swift`; `onOpenURL` | keep |
| Pair the Voice host | Separate pairing of the lifelog server | `DeviceToken`, `ServerAPI` | act | page | `ConnectionPage` | keep |
| Pair a pendant | Looks nearby, takes the first found, checks | `CaptureStore` | act | sheet | `Pendant/PairPendantSheet.swift` | keep |
| Permission asks | Location, notifications, Bluetooth, dictation, Health | OS | act | page | `Pendant/Permissions.swift`, `SettingsView` | keep |
| Monthly amount at setup | "Set a monthly amount for Life's paid services" | product.md Money; no server | act | setup | new | new |
| First launch / welcome | None found | n/a | n/a | n/a | none | unsure whether needed |

## Two lists

### (1) Features or server capabilities with no component in the tables

- `read_day` (a day's plan), `read_places_visited`, `search`, `read_observation`, `read_area_page`, `read_open_todo_items`,
  `read_chats`: the main session can read them, but no block shows them (only through `life:` links or words). Needs a
  decision which get a block (rows are marked "new if asked").
- `tell_life` and "what he told Life": no component for showing or undoing what he told Life.
- `tell_agent` and the owner's words to an agent: no component for "I told Hélène's matter's agent" beyond the Done line.
- The nightly report (mail today; boards `DuoFoldNightly*` are proposals only): no page or block.
- Calls and recordings: a conversation's turns and clips (`PlaybackStore`, `Playback/`), voice conversation summaries: no
  block; today reachable only through lifelog's views (unsure).
- A timed "Remind me..." and standing intentions ("call Sam once a month"): handoff section 7 found no server mechanism;
  the components are drawn but need a server capability.
- Budget soft cap, burn-rate warning, prepaid balance: not in server code (handoff section 6).
- "Mac admin access" confirmation: no server mechanism (handoff section 8).
- Notification when Life or the Voice host cannot be reached: no condition today.
- Contest between agents' drafts ("another card waits on the open card", `draft.contested`): never in his inbox, so
  nothing to draw (unsure it needs one).
- Matter agent hand-over and "Continue on your Mac": exist as `AgentPage`/`MacOpenAction` boards; where they live in the
  chat-first app is not decided (diagnostics only is my assumption).
- Appointments Remove/Undo from the main session's door: only the sheet; a block of "appointments Life added today" is
  not drawn.
- Apify card need: no dedicated view even today.
- Card `links` (extra links on a card) and the `merges` / `kept` contest results: unsure how the app draws them.
- Widgets and Watch app: outside the chat but must be kept.

### (2) Components that exist today and look unneeded under the new rules

- Tab model and list shell: `Shell/NavShell.swift`, `AppRouter.Tab`, `Shell/HomeList.swift` (the Projects/People/Profile
  rows), `ListButton`, `ProfileButton`, the Duo's poses (stacked, upright, sideways) and `DuoPose` fixtures.
- The drawer boards `NavV3Drawer*` and the drawer's order switch (`drawerOrder`: Priority or Latest), long press menu and
  swipe rows (`RowSwipe`): unsure whether to keep swipes.
- Top bar buttons of today (`Shell/TopBar.swift` `ShellBar`: Ask Life button, list button) except `PendantItem`.
- `AskLifeControl` (round button), the strip card and the full-screen stage (`AskLife/AskLifeStage.swift`, `AskLifeForm`
  `away/strip/full`), `AskLifeSettings` (look choice).
- The pager: `CardPage`, `Pager`, `PagerDots`, `AskPlace`, "Keep for later" ordering, `AnswersBackdrop`.
- `ProfileScreen` and its rows as a place; `PeopleScreen` search, A to Z index, People/Organizations switch, `PeopleColumns`;
  `ProjectsScreen` area chips, `FilterChip` filtering of lists, `CutToast`, `ShownList.cut`, `pendingList` nudge.
- Agent lists and names: `AgentsScreen`, `AgentListRow`, `AgentRow`, `AgentLabel`, `AgentMark` on matter pages and plan
  steps (product.md rule 8: no agents list or role names; unsure whether a program mark counts as showing the agent).
- `StartAgentSheet` as a main path (replaced by "Let Life work on it").
- `Notice` / `SyncNote` as separate marks (fold into What is wrong first and the edge).
- `BulkCard` and ending cards in the inbox (Life settles what it can read; unsure).
- Matter cost line and per-agent spending on pages (technology on screen).
- Debug fixtures (`Fixtures/`) are not UI to ship; keep only for tests.

## Review: what the inventory missed (added 23 Nov 2026)

- **Stop while Life answers.** The field needs a Stop (and later steer: words added mid-turn), since Ask Life will be
  cancellable (pi audit). Today the field has no answering state.
- **Earlier conversation.** The thread opens empty: a fold or a "Earlier" row to reach past exchanges, and day
  separators inside it.
- **"Asked on <page>" marker.** A page's ask kept in the conversation is marked with where it was asked (flow 2).
- **What Life did.** Rule 4 of `product.md` ("found when asked"): one list of Life's own acts (a to-do ticked, an event
  added, a fact corrected, an agent started), each with Undo where it can be undone. No row covers it.
- **Life is working on N things.** The plain line that replaces any agents list ("Life is handling 3 things"), opening a
  list of matters in progress. Today only per-answer Working lines exist.
- **Standing intentions.** Beside the nudge: a list of what the owner asked Life to keep an eye on ("call Sam once a
  month"), to change or stop one.
- **What the owner told Life** (`tell_life`): shown and removable when asked (list 1 names the gap; it needs a row).
- **Budget gauge.** The month's spend against the amount, with the projection; the warning card links to it.
- **Deferred asks.** If the main session orders and defers what reaches the owner (#1373), a "Later" group of asks it
  held back, so nothing is lost.
- **Live Activity / Dynamic Island** while the pendant records or Life works with the app closed: unsure, a decision.
- **Both themes.** Every component in dark and light (the brand has both): a rule for the drawings, not a component.

## Proposed structure

The tables list about 180 rows, but most are variants of a few parts. Drawn as families, the set shrinks to roughly
25 things to design:

| Family | What it holds | Built from |
|---|---|---|
| 1. Shell | edge, field (rest, typing, dictating, answering with Stop), waiting pill, pendant pill, what's-wrong line, Back bar, page chip, suggestion doors | always on, every screen |
| 2. Conversation parts | owner bubble, shortcut bubble, Life's words (with `life:` links), working, done, error, offline, note with See, "Asked on" marker, separators, Show more, Earlier | the thread only |
| 3. The card | one shell with slots: header, question, why, needs (9 kinds), draft (one look per channel), answers (buttons, Remind me, Adjust, Wrong…), states (open, sending, answered, being fixed, withdrawn) | every card kind is content in this shell, not a component |
| 4. The row | one anatomy (leading mark, title, line, trailing state, tap = open) with variants: matter, person, organization, check, appointment, payment, to-do, place, message line, Life's act | lists are rows plus Show more |
| 5. Page parts | headers (matter, person, organization, project) and sections, each section made of rows, cards and Life's words | pages are stacks of families 2 to 4 |
| 6. Outside data | choices with links, key facts, comparison, chart | sent by Life, capped |
| 7. Feedback | toast with Undo, inline flag, loading, empty, stale, failed | shared by all |
| 8. Sheets and pickers | people picker, create person or organization, calendar, date and time (Remind me), icon grid, pictures, pendant sheet | opened from cards and pages |
| 9. Off the thread | notifications and their actions, Watch, widgets, settings and diagnostics, pairing and setup (incl. the monthly amount) | outside the conversation |

Suggested design order: 1 (already started), then 3 and 4 (most of what the owner sees), then 2, 5, 6, 7, 8, and 9 last
(settings and diagnostics can largely reuse native lists).
