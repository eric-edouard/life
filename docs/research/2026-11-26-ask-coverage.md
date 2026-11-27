# Ask coverage: every ask and answer Life can send the iPhone app (26 Nov 2026)

Research only. Server read at `origin/main` c5b2092c0 (same server code as local main d33d134f4 plus one test). App read at `origin/main`, then `~/Work/life-v41-a1` (3ef5a94d5: thread, items, A2 merged) and `~/Work/life-v41-a2` (#1408). Paths: server rows are under `apps/server/src/`; app rows under `apps/lifelog/apps/ios/` (`Kit/LifeConnector/` is `Kit/Sources/LifeConnector/`, `Models/` and `Thread/` and `Items/` its folders; `Lifelog/` omitted when the file is in `Items/`, `Thread/`, `DesignSystem/`, `Settings/`, `Profile/`). Where a1 differs from main it says so; a2 adds nothing a1 lacks.

Status: **drawn+answerable** (OK), **drawn only** (DR: shown, nothing to tap or no wording), **decoded, not drawn** (DEC), **not decoded** (ND: dropped by the Kit), **designed, not on wire** (DES). 'Flow test' says `built` (a scenario in `LifelogE2E/scenarios/`: S1 S2 C1 C3 C5 C10 C16 O2 O3 O4 O7, eleven in all) or `planned` (an ID in `docs/research/2026-11-26-ios-e2e/test-map.md`, nothing built). 'Catalog' is the Debug `DesignSystem/Catalog.swift` page that draws the state (pages: values, blocks, thread, items, asks, settings, aura); the catalog draws components with fixed data, it never decodes a wire fixture except its own one draft card.

Three findings sit under every row. (1) **No ask is listed in the thread.** `ThreadRead` keeps only `kind: "ask"` items and the app draws one only inside an answer's `items` block (`Items/ItemsBlock.swift`), so a card nobody cites (an ending check, a voice, a delivered agent card) is seen only through a push or after 'What's waiting on me?'. (2) The P1 commit 14af8475d deleted every per-kind card body (voice naming, create sheet, pay code, same-as, bulk, plan, context); the Kit still decodes their fields, the app draws none. (3) 2026-11-25-app-v4.html designs payment and call cards but no card for voice naming, new matter, ending, same person, contacts card, at organization or your move. (4) Every group draws as title + question + option buttons; evidence (`said`, `clips`, `needs`, `plan`, `context`) is not shown.


## Check groups (what kind of ask Life holds)

| kind | server (apps/server/src) | app decode | app draw | status | flow test | catalog |
|---|---|---|---|---|---|---|
| group decision | memory/checks.ts:130 | Models/Check.swift:5 | Items/ItemRow.swift (a1: AskCard, AskComponents.swift:69) | drawn+answerable | built C1 C3 C5 C16 O2-O4; test-map C2 C4 C8-C22 | asks page |
| group fix | memory/checks.ts:208 | Check.swift:5 | Items/ItemRow.swift (a1: AskCard, AskComponents.swift:69); steps/context and `beingFixed` not drawn | drawn+answerable | planned F1 F2 F5 | no |
| group ending ('Is this done?') | memory/checks.ts:180 | Check.swift:5 | Items/ItemRow.swift (a1: AskCard, AskComponents.swift:69); `said`/`since` evidence not drawn | drawn+answerable | none | no |
| group new matter (Start / edit goal / dismiss) | memory/checks.ts:240 | Check.swift:5,:52 (role start/decline), goal | Items/ItemRow.swift (a1: AskCard, AskComponents.swift:69); goal and plan not drawn | drawn+answerable | none (Kit decodes answer_check_new_matter_*) | no |
| group guessed person | memory/checks.ts:287 | Check.swift:5 | Items/ItemRow.swift (a1: AskCard, AskComponents.swift:69); `networkIdentity`, `likelyPeople`, `about` not drawn | drawn+answerable | none | no |
| group contacts card | memory/checks.ts:321 | Check.swift:5,:146 | Items/ItemRow.swift (a1: AskCard, AskComponents.swift:69); card not drawn | drawn+answerable | none | no |
| group name (unplaced name) | memory/checks.ts:338 | Check.swift:5,:462 (personOrName) | Items/ItemRow.swift (a1: AskCard, AskComponents.swift:69) (text field); `organization` option is a plain option | drawn+answerable | none | no |
| group same person | memory/checks.ts:358 | Check.swift:5 | Items/ItemRow.swift (a1: AskCard, AskComponents.swift:69) | drawn+answerable | none | no |
| group at organization | memory/checks.ts:361 | Check.swift:5 | Items/ItemRow.swift (a1: AskCard, AskComponents.swift:69) | drawn+answerable | none | no |
| group voice (name a voice) | memory/checks.ts:365 | Check.swift:5,:63 (clips, audio, words) | Items/ItemRow.swift (a1: AskCard, AskComponents.swift:69); clips never played, guesses never shown; the `takes: person` option is hidden on main, a1 opens PersonPicker | drawn+answerable | none | no |
| group your move | memory/checks.ts:366 | Check.swift:5, needs place | Items/ItemRow.swift (a1: AskCard, AskComponents.swift:69); step's place/deadline not drawn | drawn+answerable | none | no |
| group unknown (newer server) | core/names.ts:64 | Check.swift:15 (.unknown) | Items/ItemRow.swift (a1: AskCard, AskComponents.swift:69) | drawn+answerable | planned F6 | no |

## Thread items (read_thread)

| kind | server (apps/server/src) | app decode | app draw | status | flow test | catalog |
|---|---|---|---|---|---|---|
| item kind ask | host/life-thread.ts:233,255 | Items/ThreadItem.swift:46,:75 | only inside an `items` block (Items/ItemsBlock.swift) or a pushed card; the thread itself never lists them | drawn+answerable | built C1; planned T1 T9 | items page |
| item kind entry (his words, Life's answer, `refs`, `answeredAt`, `error`) | host/life-thread.ts:222 | skipped: ThreadRead keeps only kind == ask (ThreadItem.swift:80) | the thread draws the phone's own record (Kit/Thread/LifeThread.swift), never the wire's | not decoded | planned T1 T2 T11 | bubbles from local state |
| entry.follows (late reply under its ask) | host/life-thread.ts:225 | none | none | not decoded | planned T11 | no |
| entry.handed (kind, since, running, estimateMs) | host/life-thread.ts:226 | none | none (ItemRow passes progress 0, estimate nil) | not decoded | planned T10 | still ring + estimate shown |
| entry.reactions (Life's, his) | host/life-thread.ts:228 | none (phone keeps its own ownerReaction) | Thread/ThreadView.swift (local only) | not decoded | planned A8 | reactions + rating |
| page: earlier / version / ifNot | host/life-thread.ts:174 | ThreadItem.swift:75 (earlier, version) | 'Show earlier' not built | decoded, not drawn | planned T2 T9 | no |
| state needs_you | host/life-thread.ts:36 | ThreadItem.swift:10 | ItemRow.swift:45 | drawn+answerable | built C1 C3 C5 | yes |
| state later (until) | host/life-thread.ts:36 | ThreadItem.swift:11 (`later` date decoded) | ItemRow.swift:48 (clock; date and 'Later · tomorrow' wording not drawn) | drawn only | planned C8 | yes |
| state under_way | host/life-thread.ts:36 | ThreadItem.swift:12 | ItemRow.swift:49 (spinner; no progress or estimate) | drawn only | planned C17 C21 | yes |
| state waiting_on_someone | host/life-thread.ts:36 | ThreadItem.swift:13 | ItemRow.swift:50 | drawn only | none | yes |
| state settled | host/life-thread.ts:36 | ThreadItem.swift:14 | ItemRow.swift:51 | drawn only | built C1 C10 | yes |
| state outdated (withdrawn / lapsed) | host/life-thread.ts:59 | ThreadItem.swift:15; Closed.withdrawn:21 (`why`, `replacedBy`) | ItemRow.swift (struck title); `why` and replacedBy not drawn | drawn only | built C16 O4; planned D5 | yes |
| state queued (phone only) | apps/lifelog (phone) | Kit/ActionState.swift, QueuedAnswers (ThreadItem.swift:96) | ItemRow.swift:41 'Goes when Life is back' | drawn+answerable | built O2 O3 O4 O7 | yes |
| state unknown (newer server) | host/life-thread.ts:36 | ThreadItem.swift:16 | drawn as needs_you on a1, no mark on main | drawn only | planned F6 | no |
| closed card: answer (his pick, `note`, `at`) | host/life-thread.ts:149 | none (Closed holds title/question/undo/withdrawn only) | none | not decoded | none | no |
| closed card: `rate` ('How am I doing?': mark bad/okay/good) | host/life-thread.ts:158; memory/decision-lines.ts:167 | none; AnswerRequest has no `rate` | none (RatingRow exists in DS only) | not decoded | planned C20 | rating row |
| closed card: `sent` (at) | host/life-thread.ts:160 | none | none (SentLine driven by `undo`) | not decoded | none | sent line |
| closed card: undo.line (what the other side sees) | host/answer-result.ts:614 | ThreadItem.swift:19 | ItemRow.swift Undo; a1 SentLine confirm (ThreadComponents.swift:195) | drawn+answerable | built C10 (no Undo on iMessage); planned C9 C11 | sent line |

## Option flags and answer inputs

| kind | server (apps/server/src) | app decode | app draw | status | flow test | catalog |
|---|---|---|---|---|---|---|
| option.outgoing | memory/card-request.ts:32 | Check.swift:40 | not used for drawing; Send is a plain option | drawn+answerable | built C1 C5 | no |
| option.ends step|matter (Mark as done, Drop) | memory/card-request.ts:24 | Check.swift:44 | plain option; held for Undo comment only | drawn+answerable | none | no |
| option.looks (I've paid) | memory/card-request.ts:30 | none (flag dropped); `doneSeen` result is decoded | plain option; 'not found' line never drawn | drawn+answerable | none (Kit decodes answer_check_done_seen) | no |
| option.adds (Add to calendar) | memory/card-request.ts:22 | none (flag dropped) | plain option; the `event` need is not drawn, result `added` dropped | drawn+answerable | planned C15 | no |
| option.runs (Run it, Apify) | memory/card-request.ts:34 | none (flag dropped) | plain option; `apify` need not drawn, result `ran` dropped | drawn+answerable | none | no |
| option.takes note | memory/card-request.ts:36 | Check.swift:31 | text field over the answers (ItemRow) | drawn+answerable | planned C12 | no |
| option.takes person | memory/life-checks.ts:34 | Check.swift:32 | a1: Profile/PersonPicker.swift; main: option hidden, so unanswerable | drawn+answerable | planned C13 | no |
| option.takes 'person or name' | memory/life-checks.ts:34 | Check.swift:33 | text field (name); no create sheet since P1 | drawn+answerable | none | no |
| option.takes unknown | life-checks.ts:34 | Check.swift:34 (.unknown) | drawn as a plain option | drawn+answerable | planned C22 | no |
| option.role start|decline (plan card) | memory/checks.ts:116 | Check.swift:52-60 | not used | decoded, not drawn | none | no |
| option.icon (Life's act icons, asker's pick) | memory/card-request.ts:26; records/answer-icon.ts | Check.swift:55 (AnswerIcon) | ItemRow.swift answer(): icon, labels as accessibility only | drawn+answerable | built (ids) | pills |
| answer: Later (phone-originated `options:[later]`) | memory/answer-check.ts:275 | Kit/LifeAPI.swift:22 | Later pill, ItemRow | drawn+answerable | planned C8 | pills |
| answer: Undo (`undo: true`) | host/answer-result.ts:646 | AnswerRequest.undo (ThreadItem.swift:126) | Undo / SentLine | drawn+answerable | planned C9 C11; built C10 | sent line |
| answer: rate (`rate: bad|okay|good`) | host/answer-result.ts:641 | none | none | not decoded | planned C20 | rating row |
| answer: note / person / name | memory/answer-check.ts | AnswerRequest (Kit/LifeAPI.swift) | ItemRow field, picker (a1) | drawn+answerable | planned C12 C13 | no |
| answer: voice 'media' / 'not-relevant' / me | memory/answer-check.ts:584-588 | Check.swift:473-475 | none (the voice card is generic options) | decoded, not drawn | none | no |

## Card parts beyond the question (Ask, memory/card-request.ts)

| kind | server (apps/server/src) | app decode | app draw | status | flow test | catalog |
|---|---|---|---|---|---|---|
| ask (imperative line) | card-request.ts:60 | Check.swift:313 | not drawn; the item shows `question` | decoded, not drawn | none | no |
| recommended | card-request.ts:106 | Check.swift:314 | filled pill (ItemRow) | drawn+answerable | built (C1) | pills |
| follow (up to 3 next asks) | card-request.ts:86 | none | none | not decoded | none | no |
| edits (quick edit chips) | card-request.ts:84 | none | EditChips exists (AskComponents.swift:54), ItemRow never passes edits | not decoded | planned D3 | chips on whatsapp draft |
| changed: deadline | card-request.ts:54 | none | none | not decoded | none | no |
| changed: condition | card-request.ts:54 | none | none | not decoded | none | no |
| changed: option | card-request.ts:54 | none | none | not decoded | none | no |
| changed: message | card-request.ts:54 | none | none | not decoded | none | no |
| changed: edit:tap (redraft by tapped edit) | card-request.ts:54 | none; MainSessionRequest has no `tap` | EarlierDraftRow in DS only | not decoded | planned D3 | earlier draft row |
| changed: edit:words (redraft by words) | card-request.ts:54 | none | EarlierDraftRow in DS only | not decoded | planned D2 | earlier draft row |
| context (Markdown + life: links) / lifeLinks | card-request.ts (ContextMarkdown) | Check.swift:218,284; Kit/ContextMarkdown | no context sheet since P1 | decoded, not drawn | planned A10 | no |
| links | card-request.ts:80 | Check.swift:279 | not drawn | decoded, not drawn | none | no |
| deadline / onSilence | card-request.ts:100 | Check.swift:215-216 | not drawn | decoded, not drawn | none | no |
| plan (steps) / gathered | card-request.ts:40,88 | Check.swift:236,258 | not drawn (Inbox/ plan card deleted in 14af8475d) | decoded, not drawn | none | no |
| replaces (older draft) | memory/checks.ts:122 | Check.swift:225 | not drawn | decoded, not drawn | planned D5 | no |
| merges / keep (draft contest) | card-request.ts:94 | none (server-to-agent only) | n/a | not decoded | none | no |
| doneSeenBy payment|tap, doneSeen looking|seen|not_found | card-request.ts:81; memory/decisions.ts:69 | Check.swift:298-303; AnswerResult.swift:doneSeen | not drawn | decoded, not drawn | none (answer_check_done_seen decoded in Kit) | no |
| notSent (last send that did not go) | memory/checks.ts:122 | none on the card; AnswerResult.send.reason is decoded | 'Not sent' on the draft (DraftBlock.swift:200,218) | drawn only | built C3 | draft 'Not sent' |
| misread / beingFixed (complaint at work) | memory/checks.ts | Check.swift:309,311 | not drawn | decoded, not drawn | none | no |
| confirm (second check beside a draft) | memory/checks.ts | Check.swift:294 | not drawn | decoded, not drawn | none | no |
| importance high / urgency blocks|improves | memory/checks.ts:152 | urgency decoded (Check.swift:19); importance none | not drawn | decoded, not drawn | none | no |

## Needs (what he needs in hand, memory/needs.ts)

| kind | server (apps/server/src) | app decode | app draw | status | flow test | catalog |
|---|---|---|---|---|---|---|
| need account | memory/needs.ts:20 | Models/Need.swift:10 (rows :93-:168) | no view since the inbox's PayCodeBlock/CheckBodies went (14af8475d) | decoded, not drawn | planned C14 (payment) / C15 (event) | no |
| need amount | memory/needs.ts:30 | Models/Need.swift:10 (rows :93-:168) | no view since the inbox's PayCodeBlock/CheckBodies went (14af8475d) | decoded, not drawn | planned C14 (payment) / C15 (event) | no |
| need app | memory/needs.ts:36 | Models/Need.swift:10 (rows :93-:168) | no view since the inbox's PayCodeBlock/CheckBodies went (14af8475d) | decoded, not drawn | planned C14 (payment) / C15 (event) | no |
| need link | memory/needs.ts:78 | Models/Need.swift:10 (rows :93-:168) | no view since the inbox's PayCodeBlock/CheckBodies went (14af8475d) | decoded, not drawn | planned C14 (payment) / C15 (event) | no |
| need text | memory/needs.ts:86 | Models/Need.swift:10 (rows :93-:168) | no view since the inbox's PayCodeBlock/CheckBodies went (14af8475d) | decoded, not drawn | planned C14 (payment) / C15 (event) | no |
| need place | memory/needs.ts:97 | Models/Need.swift:10 (rows :93-:168) | no view since the inbox's PayCodeBlock/CheckBodies went (14af8475d) | decoded, not drawn | planned C14 (payment) / C15 (event) | no |
| need event | memory/needs.ts:68 | Models/Need.swift:10 (rows :93-:168) | no view since the inbox's PayCodeBlock/CheckBodies went (14af8475d) | decoded, not drawn | planned C14 (payment) / C15 (event) | no |
| need qr (PromptPay code) | memory/needs.ts:103 | Need.swift:168; Payment.swift payCode | no view | decoded, not drawn | planned C14 | no |
| need apify | memory/needs.ts:58 | Need.swift:168 (line only) | no view | decoded, not drawn | none | no |

## Draft shapes (memory/draft.ts)

| kind | server (apps/server/src) | app decode | app draw | status | flow test | catalog |
|---|---|---|---|---|---|---|
| draft text, chat (WhatsApp, iMessage, LINE, Telegram, Messenger, Instagram) | memory/draft.ts:22 | Check.swift:114 | DraftBlock.swift:10, ChatLook :295 (a1 via AskCard; main ItemRow shows the bare text) | drawn+answerable | built C1 C3 C5 C10 (iMessage) | whatsapp, imessage |
| draft file | memory/draft.ts:28 | Check.swift:115-119 | DraftBlock.swift fileRow :184 | drawn+answerable | none | no |
| draft reaction (emoji on a message) | memory/draft.ts:45 | Check.swift:131 | DraftBlock.swift:50 | drawn+answerable | none | no |
| draft reply (onMessage, `quoted`) | memory/draft.ts:43 | Check.swift:120 | DraftBlock.swift:106 | drawn+answerable | none | no |
| draft mentions | memory/draft.ts:30 | Check.swift:125 | DraftBlock.swift (@name runs) | drawn+answerable | none | no |
| draft mail (from, cc, subject) | memory/draft.ts:24,46 | Check.swift:135-137 | DraftBlock.swift:153 (mail sheet) | drawn+answerable | none | mail |
| draft GitHub (comment, new issue with subject as title) | memory/draft.ts:111 | Check.swift:137 | DraftBlock.swift:96, default ChatLook (no GitHub look) | drawn+answerable | none | no |
| draft group (`people`), `recent` strip | memory/checks.ts | Check.swift:140,142 | DraftBlock.swift ChatHead :228 | drawn+answerable | none | recent lines |

## Outcomes of an answer

| kind | server (apps/server/src) | app decode | app draw | status | flow test | catalog |
|---|---|---|---|---|---|---|
| sent | host/answer-result.ts:174 | AnswerResult.swift:8 | DraftBlock 'Sent' (:221) | drawn only | built C1 C5 | sent state |
| not sent (reason, canRetry, wrote) | memory/draft-send.ts:133,418 | AnswerResult.swift:9,:17-:21 | failure line + retry (ItemRow) | drawn+answerable | built C3; planned D4 | 'Not sent' |
| may have gone | memory/draft-send.ts | AnswerResult.swift:10 | DraftBlock '?' (:201); no retry | drawn only | planned C4 | state shown in DS only via enum |
| pending / handed steps (chat_checked, handed, confirmed) | memory/draft-send.ts (sendStepsOf) | Models/ChatStrip.swift:178 | DraftBlock ticks | drawn only | built C1 C5 | sent state |
| done-seen (looking, seen, not_found) | memory/decisions.ts:69; host/done-seen.ts:124 | AnswerResult.swift:doneSeen | not drawn | decoded, not drawn | none | no |
| changed.ended (error), changed.until (snoozed) | host/answer-result.ts:497 | AnswerResult.swift:35-45 | not drawn | decoded, not drawn | none | no |
| start (agent started / not started) | host/answer-result.ts:481 | Models/AgentChangeResult.swift | not drawn | decoded, not drawn | none | no |
| done lines (`added` calendar id, `ran` run id, `end`) | host/answer-result.ts:500 | none | none | not decoded | planned C15 | no |
| asker told / why | host/answer-result.ts:487 | AnswerResult.swift:Asker | not drawn | decoded, not drawn | none | no |
| already answered elsewhere (repeat gets first result) | host/answer-result.ts:428 | none (no wording) | none | not decoded | planned C7 | no |
| outdated at flush (answer dropped) | host/answer-result.ts / answer-check.ts | Kit/ActionState.swift | dropped count (Items/Notices.swift) | drawn only | built O4 | notice |
| Undo refused / undone / deleted for both | host/answer-result.ts:677 | ThreadItem.swift:19 | SentLine phases | drawn only | planned C9 C11 | sent line phases |
| withdrawn / lapsed / replaced card | host/life-thread.ts:59,:159 | ThreadItem.swift:21 | struck title; 'replaced by' not drawn | drawn only | built C16; planned D5 | no |

## Answer blocks (records/answer-blocks.ts, catalog 1)

| kind | server (apps/server/src) | app decode | app draw | status | flow test | catalog |
|---|---|---|---|---|---|---|
| block items | answer-blocks.ts:31 | Thread/AnswerBlocks.swift:33 | Items/ItemsBlock.swift | drawn+answerable | planned A2 A3 | items page |
| block pictures | answer-blocks.ts:45 | AnswerBlocks.swift:35 | Items/ItemsBlock.swift PicturesBlock (face opens profile) | drawn+answerable | planned A4 | no |
| block question (answers, recommended) | answer-blocks.ts:57 | AnswerBlocks.swift:37 | DesignSystem/AskComponents.swift:38; tap sends the label as words | drawn+answerable | planned A6 A7 | question block |
| block settings keys | answer-blocks.ts:74 | AnswerBlocks.swift:38 | main: opens Settings; a1: Settings/LiveSettingsBlock.swift | drawn+answerable | planned S5 S6 | settings page |
| block settings offer (one switch) | answer-blocks.ts:78 | none on main; a1 AnswerBlocks.swift (Offer) | a1: LiveSettingsBlock; OfferBlock in DS | not decoded on main; drawn+answerable on a1 | planned S7 | offer block |
| block table | answer-blocks.ts:90 | AnswerBlocks.swift:39 | Thread/BlockViews.swift:76 | drawn only | planned A1 | no |
| block document | answer-blocks.ts:18 | AnswerBlocks.swift:32 | Thread/BlockViews.swift | drawn only | planned A5 | document block |
| block place | answer-blocks.ts:47 | AnswerBlocks.swift:36 | Thread/BlockViews.swift (Maps link) | drawn only | planned A5 | place block |
| block phrase | answer-blocks.ts:33 | AnswerBlocks.swift:34 | Thread/BlockViews.swift PhraseScreen | drawn only | planned A4 | phrase block |
| block newer than catalog / unknown / bad JSON | answer-blocks.ts:119 | AnswerBlocks.swift:81 (init? returns nil) | dropped silently | drawn only | planned F6 | no |

## Ask Life (ask_main_session) lines, requests and reactions (records/main-session-wire.ts)

| kind | server (apps/server/src) | app decode | app draw | status | flow test | catalog |
|---|---|---|---|---|---|---|
| line thinking | main-session-wire.ts:78 | Thread/MainSessionWire.swift:41 | ignored | drawn only | planned T3 | no |
| line step (verb, what) | main-session-wire.ts:79 | MainSessionWire.swift:42 | LiveAnswer step (ThreadView.swift) | drawn only | planned T3 | no |
| line words | main-session-wire.ts:80 | MainSessionWire.swift:43 | AnswerView.swift | drawn only | planned T3 A1 | no |
| line block | main-session-wire.ts:81 | MainSessionWire.swift:44 | AnswerView.swift | drawn only | planned A2-A6 | blocks page |
| line reaction (👀 handed on, 👍 done) | main-session-wire.ts:82 | MainSessionWire.swift:45 | ReactionMark (ThreadView.swift) | drawn only | planned T10 A8 | reactions |
| answer reply (entry, text, refs, reaction) | main-session-wire.ts:56 | MainSessionWire.swift:69 | AnswerView | drawn only | planned T3 | no |
| answer acts (done, agent, card, fix) | main-session-wire.ts:47 | none (reply drops `acts`) | none | not decoded | none | no |
| answer error ('I couldn't answer that.', retry) | main-session-wire.ts:67 | MainSessionWire.swift:70 | ThreadView failed bubble, tap to ask again | drawn+answerable | planned T7 | bubble states |
| request words (+ screen refs, catalog) | main-session-wire.ts:33 | MainSessionWire.swift:19 | AskField | drawn+answerable | planned T3 T4 | no |
| request stop | main-session-wire.ts:31 | MainSessionWire.swift:33 | Stop button | drawn+answerable | planned T5 | no |
| request react (his reaction to Life's entry) | main-session-wire.ts:28 | MainSessionWire.swift:36 | ThreadView hold-to-react | drawn+answerable | planned A8 | reactions |
| request tap:true (words are a tapped edit/answer/offer) | main-session-wire.ts:37 | none (never sent) | none | not decoded | planned D3 | no |
| request key (retry asks once) | main-session-wire.ts:30 | Kit/Thread/LifeThread.swift (answerKey) | n/a | drawn+answerable | planned T8 | no |
| held asks ('While you were in your meeting') | host/life-thread.ts (not on wire) | none | HeldSeparator in DS only | designed, not on wire | planned N9 | held separator |
| settings offer by thread (read_thread settings offer) | not on wire (planned G) | none | OfferBlock in DS | designed, not on wire | planned S7 | offer block |
| aura colour / state ('Make it teal') | no wire kind | none | EdgeView aura + Catalog aura page | designed, not on wire | planned E3 | aura page |
| instruction as a switch (S8) | no wire kind | none | none; in 2026-11-25-app-v4.html only | designed, not on wire | planned S8 | no |
| answered-away bottom line / skipped ask line | no wire kind | none | 2026-11-25-app-v4.html only | designed, not on wire | planned C18 C19 | no |
| payment box / call script (2026-11-25-app-v4.html 'pay', 'call') | needs account/amount/text exist on wire | Need.swift | 2026-11-25-app-v4.html draws them; app does not | decoded, not drawn | planned C14 | no |

## Counts (126 rows)

- drawn+answerable: 48
- drawn only: 24
- decoded, not drawn: 27
- not decoded: 22
- designed, not on wire: 5
- rows with a built flow test: 18 of 126 (eleven scenarios, all P0 send, offline and pairing paths); the rest are planned in test-map.md or have none.

## Keeping the list exhaustive automatically

One test, `scripts/ask-coverage.test.ts`, run by `bun run check` (a bun test, no Simulator), plus one data file it owns, `apps/lifelog/fixtures/ask-coverage.json` (a map from kind to `{fixture, decode, draw, catalog}`, each a file or a named test). It reads:

1. **The server's kinds, from code, never copied.** Import `CheckGroup.options` (`core/names.ts`), `NEED_KINDS` (`memory/needs.ts`), `CHANGES` and `Option.shape` keys (`memory/card-request.ts`), `Object.keys(BLOCKS)` plus the `offer` key of settings (`records/answer-blocks.ts`; export `BLOCKS`), `MARKS` (`memory/decision-lines.ts`), `ItemState` (export a `ITEM_STATES` array beside the type in `host/life-thread.ts`), the `MainSessionLine` and `MainSessionAct` kinds (`records/main-session-wire.ts`: turn the unions into `as const` arrays), the draft keys (`MessageDraft.shape`), and the answer send states.
2. **A fixture for each kind**: walk every JSON in `apps/lifelog/fixtures/wire/life/` and `fixtures/design/` and collect the groups, need kinds, option flags, states and block kinds that occur. A kind in step 1 with no occurrence fails ('add a fixture written by a server test through `wire-fixture.ts`'); the server's own tests are where the fixture comes from.
3. **A Kit decode**: scan `Kit/Sources/LifeConnector/**.swift` for each kind's wire name as a string literal or a `case`/CodingKey (`Check.swift`, `Need.swift`, `ThreadItem.swift`, `AnswerBlocks.swift`, `AnswerResult.swift`, `MainSessionWire.swift`). A kind not found is `ND`; the manifest must say so on purpose (`"decode": null, "why": ...`), so a new server kind cannot be dropped silently. This is what would have caught `edits`, `follow`, `changed`, `adds`, `runs`, `rate`, the settings `offer` and the thread's `entry` items.
4. **A draw and a catalog state**: the manifest names, per kind, a `Lifelog/` file and a `Catalog.swift` call; the test greps that the file exists and holds the symbol, and that `Catalog.swift` mentions the kind. A kind with `"draw": null` must carry `"status": "decoded, not drawn"` and an issue number; the test fails when a status in the manifest disagrees with what step 3 and 4 found (a view added without updating the row also fails, so this file stays the table above).
5. **A flow test**: for every kind marked drawn+answerable, the manifest names a `LifelogE2E/scenarios/*.json` or none with a reason; the test fails if a P0 kind (outgoing, adds, runs, ends, looks, undo, draft shapes) has none.

Swift side, one cheap companion in `Kit/Tests/LifeConnectorTests/`: `AskCoverageTests.swift` decodes every wire fixture and asserts that no card field present in the JSON is missing from the decoded `Check` (Mirror over the model against the keys of the JSON), so a dropped field is a red test on the Mac with no Simulator. The two tests share the manifest.
