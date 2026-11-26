# Prototype audit, 26 Nov 2026

Source: `prototypes/shell.html` (S), `settings-board.html`, `answer-components.html`; approved deviations: `2026-11-26-lab-decisions.md`, `2026-11-26-original-components.md`. App: `apps/lifelog/apps/ios/Lifelog` (A). Read-only audit; no Swift edited. Not every file was read line by line: DraftBlock, Pieces, LinkCard, AskParts, IncidentCards, ConnectionPage, EdgeView were only grepped (marked "unread" below).

Global: no approved document allows SF Symbols in place of the prototype's own stroke glyphs. Every SF Symbol standing in for a prototype glyph is a mismatch unless a row says otherwise.

Counts: 64 elements checked, 31 mismatches (27 verified, 4 to confirm).

## Mismatches, ranked by visibility

1. Left count button shows an empty glass circle at 0 (A RootView:248); S hides it (`visibility:hidden`, setCount ~L707).
2. Stop while Life works: separate 44pt glass `stop.fill` above the field (A AskField:14-30); S: one cream 36px disc with a square inside the field row, field disabled.
3. Listening composer: X has a tint disc (A DictationField:112, 452) where S has none; timer, "Slide up to send", "Listening..." text (DictationField:122,143,459) where S says no timer; live mic blue-tinted or `stop.fill` (DictationField:372) where S is cream-filled.
4. Mic, send (`arrow.up`), fold (`chevron.up`), notice marks (`wifi.slash`, `desktopcomputer`), row marks (`bubble.left`, `person`, `circle.dashed`), "Open X" arrow (`arrow.up.right`): all SF Symbols; S draws its own SVGs ("⌃" for fold).
5. Offline notice line always "Nothing is lost - since T" (A Notices:38-42); S offline: "What you do waits - since 15:40" or "N waiting to go - since 15:40" (S L921-929).
6. "Back" confirmation is centred muted text for 4s (A Notices:26); S settles the same notice in place with a green tick: "Back online - N sent" / "Back - caught up".
7. Undo confirm buttons "Delete"/"Keep" (A ThreadComponents:360-361); S: "Delete for both"/"Keep it" (S ~L1372). Sent line has no green tick.
8. "Show earlier" is a plain muted text button (A ThreadView:72); S: 32px tint pill, 13px 650.
9. Row Later pill missing on task rows (A ThreadItemRow, ThreadComponents:207-323); S rowHTML L639 shows it.
10. Extra trailing marks on queued (`arrow.up.circle`) and stopped (`stop.circle`) rows (ThreadComponents:315-319); S draws none.
11. Waiting line "Waiting for a reply" (A ItemRow:79); S "Waiting on Paul's quote - Thu".
12. Reactions through a system context menu (A ThreadView:231); S: 450ms hold or double-tap glass bar of three 40px marks.
13. Profile is a pushed page with system Back, reach buttons at the bottom, no section headings, matter rows (A ProfileView); S: lifted 104px face over a blurred thread, glass 40px back chevron, 50px reach buttons under the line, headings "Needs you / Where things stand / Waiting on X / Coming up / Where / Last time / What X is like" (S L1153-1243). Face and reach sizes use Metrics values to confirm.
14. Pendant sheet switch labelled "Pause" (A PendantView); S "Pendant records" (inverted). Sheet itself approved (lab D). Accessibility label "not recording" vs S "paused".
15. Pendant long press opens an extra Settings menu (A RootView:269); S has none.
16. Fix asks for login lost, pendant stopped, budget ("Sign WhatsApp back in", "Reconnect your pendant", "Raise this month's budget?") not found in A (grep): to confirm in IncidentCards.
17. Failed bubble shows `exclamationmark.circle.fill` + "Not sent. Tap to try again" (A ThreadComponents:93-137); S draws neither.
18. Clock for a waiting bubble sits inside the bubble (A) vs under it with "when you're back" (S `.q`).
19. Down pill `.downp`, "Left for now, still waiting on you" line, "You <did> <Item>" line: not found in A (grep).
20. Held separator uses `.meta` faint (A) vs `.line` 13px muted (S).
21. App-only extras: "Your words" field (AskComponents AskCard), "Charge it soon." (PendantView), "I couldn't answer that." / "Stopped" (ThreadView:245,247), `mic.slash` (DictationField), "Pair Life" button (RootView), OfferBlock default "Yes"/"No", `RoundButton` badge (ThreadComponents:471-491), count-button label "Life can't be reached".
22. Quick-edit chips have no round back arrow after use (A EditChips).
23. No `xmv` lit dot on answers that start work (A QuestionBlock; grep found none).
24. Rating close is SF `xmark` (S X svg).

Approved, not mismatches: pendant sheet as a page (lab D); count becomes a coral mark when out of reach (Settings 2 B); lit/hollow pendant dot (fixed); "Later" first, cream main answer; likelier answer on the right and filled; late reply A; On it with an estimate A; coral only for today/tonight.

## Top pills

| Element | Prototype | App | Match? | Fix |
|---|---|---|---|---|
| Count button, shape | 40px glass circle (S L547) | RootView:238-251, tapTarget glass circle | yes | none |
| Count at 0 | hidden | empty circle (RootView:248) | NO | hide the button when 0 |
| Count glyph | 17px 700 tabular | `.rowTitle` | to confirm | check weight and digits |
| Count tap | asks "What's waiting on me?" (S L977) | `thread.ask` same | yes | none |
| Count a11y | "N waiting on you" | "What's waiting on me" | NO | use "N waiting on you" |
| Out-of-reach state | none | coral `exclamationmark` | approved (lab Settings 2 B) | none |
| Pendant dot recording | 9px cream, breathing | `StateDot(isLit)` (RootView:259) | yes | none |
| Pendant dot paused | hollow 1.6px muted ring | same (RootView:261) | yes | none |
| Pendant tap | toggles pause (S L978) | opens sheet (RootView:255) | approved (lab D) | none |
| Pendant long press | none | Settings menu (RootView:269) | NO (extra) | remove or ask owner |
| Pendant a11y | "Pendant, paused" | "Pendant, not recording" | NO | rename |

## Composer

| Element | Prototype | App | Match? | Fix |
|---|---|---|---|---|
| Field shape | capsule radius 26, min 52 (S L46-61) | AskField glass rect `Radius.sheet` | to confirm | compare radius |
| Placeholder | "Ask Life or hold to talk" | same (AskField) | yes | none |
| Mic glyph | 36px tint disc, stroke SVG | SF `mic` 17pt | NO | draw the SVG |
| Send | 36px cream disc, SVG arrow, 35% when empty | SF `arrow.up` 16, tinted fg 0.35 | NO (glyph) | draw the SVG |
| Suggestion rotation | 3s, inked, ring arrow at end | present (spec) | to confirm | not read |
| Listening X | 28px, no background | tint disc 36/28pt (DictationField:112,452) | NO | remove background |
| Listening words | inked above, 16.5px 500 | present | to confirm | none |
| Listening timer | none | present (DictationField:459) | NO | remove |
| Listening helper text | none | "Slide up to send", "Listening..." | NO | remove |
| Live mic | cream fill, black glyph | blue tint / `stop.fill` | NO | cream fill |
| Working: stop | cream 36px disc inside field row, field disabled | separate 44pt glass `stop.fill` (AskField:14-30) | NO | move into the field row |
| Refused mic | none | `mic.slash` | NO (extra) | drop |

## Home thread

| Element | Prototype | App | Match? | Fix |
|---|---|---|---|---|
| His bubble | cream 11%, radius 20/6, 15px | HisBubble (ThreadComponents:93) | to confirm | compare numbers |
| Waiting bubble clock | under bubble, "when you're back" | inside, SF `clock` | NO | move under, add words |
| Failed bubble | not drawn | icon + "Not sent. Tap to try again" | NO | remove or approve |
| Life's words | no bubble, 15.5px, inks in | present | to confirm | none |
| Quiet line | 13px muted | `.line` | yes | none |
| Day separators | 12px "Yesterday", "Today" | ThreadView:86-90 | yes | none |
| Show earlier | tint pill 32px | plain button (ThreadView:72) | NO | pill |
| Held separator | `.line` | `HeldSeparator` `.meta` | NO | match style |
| Steps line | spinner or three-dot, shimmer, 18px face | StepsLine (ThreadComponents:60-82) | partly (dots rise, not circle) | to confirm |
| Reactions | 450ms hold/double-tap bar of 3 | context menu (ThreadView:231) | NO | glass bar |
| Reaction mark | 24px round at corner | `Palette.card` circle | yes | none |
| Rating | "How am I doing?", 3 marks, X, "Thanks" | RatingRow (ThreadComponents:381-417) | yes except X glyph | draw X |
| Down pill | 38px, arrow down | not found | NO (missing) | add |
| "Left for now" line | present | not found | NO (missing) | add |
| "You did X" line | present | not found | NO (missing) | add |
| Failure texts | none | "I couldn't answer that.", "Stopped" | NO (extra) | approve or drop |

## Item row

| Element | Prototype | App | Match? | Fix |
|---|---|---|---|---|
| Leading disc | 40px initial or mark | SF `bubble.left`/`person`/`circle.dashed` (ItemRow) | NO | initial or drawn mark |
| Title / line | 16px 650 / 13.5 muted | present | to confirm | none |
| Coral "today" | yes | yes | yes | none |
| Later pill | 32px tint on task rows | absent | NO | add |
| Queued | clock + "Goes when you're back", no trailing mark | text matches, extra `arrow.up.circle` | NO | drop mark |
| Stopped | none | extra `stop.circle` | NO | drop mark |
| Underway | spinner + text + "Undo" | StillRing + estimate | approved (lab) | none |
| Settled | green tick + text | SF `checkmark` green | glyph only | draw tick |
| Later line | "Later - tomorrow 9:00 - Undo" | similar | to confirm | none |
| Waiting line | "Waiting on Paul's quote - Thu" | "Waiting for a reply" | NO | use who and thing |
| Outdated | present | "Out of date" | to confirm | none |
| Fold button | 30px tint, "⌃", 16/16 | `chevron.up` in tint circle | NO (glyph) | draw "⌃" |
| Unfolded hero | disc 48, title 19, wash 6% | to confirm | to confirm | none |

## Ask cards, questions, answers

| Element | Prototype | App | Match? | Fix |
|---|---|---|---|---|
| Main answer | 50px cream | AnswerPills recommended filled | yes | none |
| Later | first, quiet | first | yes | none |
| Edit chips | 30px, "Warmer/Shorter/In French", back arrow | EditChips, no back arrow | NO | add arrow |
| Draft open-chat pill | "Open WhatsApp ↗" | "Open <network>" with `arrow.up.right` | glyph only | draw arrow |
| Question pills | two 44px, likelier right, cream | QuestionBlock | yes | none |
| Work-starting dot `xmv` | 6px lit | none | NO | add |
| Words question | no control, mic pulses | to confirm | to confirm | not read |
| Free field | none | "Your words" | NO (extra) | drop |
| Offer defaults | none | "Yes"/"No" | NO (extra) | drop |
| Payment box | amount 34px, "Open your bank ↗" | AskParts (unread) | to confirm | none |
| Link card | per-site card (lab B v2) | LinkCard | approved | none |

## Notices and failures

| Element | Prototype | App | Match? | Fix |
|---|---|---|---|---|
| Offline title | "You're offline" | same | yes | none |
| Offline line | "What you do waits - since 15:40" | "Nothing is lost - since T" | NO | change words |
| Mac title | "Your Mac isn't answering" | same | yes | none |
| Mac line | "Nothing is lost - since 14:10" | same | yes | none |
| Marks | muted SVG in disc | SF `wifi.slash`, `desktopcomputer` | NO | draw SVGs |
| Settled | in place, green tick | centred text 4s | NO | settle in place |
| Settings block keys | offline: faceid, appear; mac adds pair again | ["faceid","pair"] (Notices) | NO | add appearance |
| Login / pendant / budget asks | fix asks, ranked first | not found | NO (to confirm) | check IncidentCards |
| Queued bubble | clock + "when you're back" | present | partly | see Home thread |

## Pendant sheet, Settings, Profile

| Element | Prototype | App | Match? | Fix |
|---|---|---|---|---|
| Pendant page | none (lab D approves a page) | PendantView | approved | none |
| Switch label | "Pendant records" | "Pause" | NO | invert label |
| "Charge it soon." | none | present | NO (extra) | approve or drop |
| Settings rows | block in thread (S L1378-1394) | SettingsPage sheet, SettingSwitchRow | approved layout, words to confirm | compare words |
| Settings tick | green, 1.4s | SF `checkmark` green | glyph only | none |
| Profile face | 104px | `Metrics.profileFace` | to confirm | check value |
| Profile back | glass 40px chevron, drag to dismiss | system Back | NO | custom |
| Profile reach | 50px, top, app logos | `Metrics.disc`, bottom | NO | move, resize |
| Profile headings | seven headings | none | NO | add |
| Profile matter rows | none | present | NO (extra) | drop |
| Notification | "L" mark, title, draft, two actions | IncidentNotifier (partly read) | to confirm | none |
| Edge states | rest, listen, work, still | EdgeView states | yes | none |
