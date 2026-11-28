# App v4's components: how each is designed, and why

Reference: the principles behind the owner's approved prototype, app v4, above all low cognitive load, written as
rules a designer agent can apply to a new row, card or block; then how the prototype draws each component, folded and
unfolded, in every state. It is one agent's reading of the prototype, for the owner to confirm or correct: where the
reason for a choice is not written down, the note says **Unsure why** or **Inference** instead of guessing.

Source: `docs/design/2026-11-23-chat-first/2026-11-25-app-v4.html` on `origin/main` (commit 8300231b5). Line numbers below are
that file's (`2026-11-25-app-v4.html:639`, or just `:639`); the copy `app-v4-original.html` in the design-cards worktree is the
same file with one extra line at the top, so its numbers are one higher. Reasons come from
[the philosophy and guidelines](../philosophy.md) (the spec, the log and the answer components),
[`2026-11-25-app-v4-design-system.md`](2026-11-25-app-v4-design-system.md) (his 11 answers of 26 Nov),
[`../../product.md`](../../product.md) and [`../../brand.md`](../../brand.md). Sizes are the prototype's CSS
pixels; his answers of 26 Nov say the phone builds from `tokens.css` and the seven-size type scale, never from the
prototype's literal greys. Read from the code; the prototype was not rendered (the Mac's load was above 40).

## Low cognitive load: the principles

### Start from his seat (his word, 26 Nov)

He uses Life so that it lowers his cognitive load and does things for him. He switches context all day, between
people, apps and AIs, so every screen is handed to him on a silver platter. Before anything else, a card or row must let
him answer two questions at a glance, with no prior context: **what is this about?** and **what is asked of me?** If a
plain sentence would answer them better than the drawn component, the sentence wins.

Rules he set on 26 Nov, which win over anything below:

- **Every fact once.** Never say the same thing twice on one card: a person's name, a "voice at lunch" title and a "heard
  at lunch" line, the same icon in two places. Each element has one purpose, or it goes.
- **No numbers he doesn't need.** No word counts, durations or "heard at 2 lunches": what matters is that Life grouped
  right and guessed right, so he just says yes.
- **Where the original prototype already draws something, the original wins**: no variants for it.
- **An ask does not show its matter**, for now (no matter header, no matter line on an ask).
- **The recommended answer is on the right**, in cream, where the thumb is.
- **A message's source looks like its app:** the app's mark in its brand colour and its link ("Open WhatsApp"), one
  component everywhere a message is quoted (prototype `chatHTML`, `:646`).
- **Voice is read, not drawn:** no waveforms, no duration. The words show dim; when he taps play (with a loading state on
  the button) each word turns white as it is spoken, the way Life's own words ink in (`.w.on`, `:356`).
- **A closing check opens with the matter's name, then why Life thinks it is done, then the question.**
- **Scored by fresh eyes:** a new or changed card is shown, as a screenshot only, to a reviewer with no context
  (as the 26 Nov fresh-eyes review did) before it goes to him.

The goal under every choice (product.md: the bar is "a 70-year-old who doesn't know how to use an iPhone"; brand.md
Wording: "Removing the person's load comes first"). Each principle: where it comes from, how the prototype applies it,
and how to apply it to something new.

### 1. Show only what's needed

- **From:** his words of 23 Nov 2026, "Never show anything useless to the user. Only show what actually needs them, or
  what they asked for" (product.md); the log's "Not everything is shown, but everything stays reachable by asking".
- **In the prototype:** a row is a face, a title and one line, nothing else (`rowHTML`, `:639`). The why is one line
  (`:651`). A reply's chat shows only the messages the matter cites, the rest as one count, "3 unrelated messages"
  (`:646`). A matter waiting on someone has no answers, just "Nothing to do: Life will bring it to you when it
  arrives." (`:650`, `:621`). A notice has no body and no tap (`:921-923`). Asks that arrive in a meeting are not
  shown or counted until he is free (`:1421-1428`). An empty list says "Nothing waits on you." and nothing more
  (`:975`). There is no "more details" control anywhere.
- **When details appear:** on his tap, by unfolding the row in place (the body: draft, options, IBAN); everything else
  only when he asks in the field ("What did Ben say?").
- **Apply it:** list every element of the new component and remove each one he would not act on or need to decide.
  Put what he needs to decide in the unfolded body; leave the rest behind the field. A "show all", a count he can't act
  on or a label "just in case" serves the builder (log, 23 Nov: say so before building it).

### 2. One recommended next step, from Life

- **From:** product.md rule 6, "The likely answer ready to tap"; the log, "The page keeps one wide button for the
  recommended answer (the card's first option)"; the spec's "the recommended one full width".
- **In the prototype:** the agent's first option is the wide button ("Send both", `:588`). In a pick, Life's pick is
  preselected (`picked:0`, `:591`) and the button names it, "Contact Dr. Ink" (`:663`). In a question, the likelier
  answer is drawn cream and on the right (`rec`, sorted last, `:1009`). A fix ask's main answer is written for where he
  is: at home "Done, it's linked", away "Remind me when I'm home" (`:605-606`). Even the empty field offers Life's
  three likeliest next asks (`suggNow`, `:780-790`).
- **Apply it:** Life (the agent or code) decides the recommendation before showing anything; preselect it; make it the
  one button; name the button by what it does. If Life cannot recommend, the thing is not ready to show, or it is a
  question with equal answers (a value, a person).

### 3. The positive path is always the white (cream) button

- **From:** the log, "The cream fill (`fg` as a background) is the one main answer button. Nothing else takes it"; his
  bubble was moved off cream because "the full cream bubble was too loud" (log, 23 Nov).
- **In the prototype:** one `.prim` per unfolded ask, full width, 50 px, with the result's mark ("Send to Jade ↑",
  `:667`, `:400`); every other answer is an equal quiet `tint` pill under it: Later, the alternative, Drop it
  (`:664-666`). His bubble is cream at 11 %, not filled (`:331`). In a question's two pills, only the recommended one is
  cream (`:254`).
- **Confirmed by the owner (26 Nov):** the cream fill also marks a chosen value (an on switch, a selected value pill, `:496`,
  `:499`), the live microphone and Send in the field (`:53-54`), and "Delete for both" in the Undo confirm (`:1374`).
  I read the rule as "one cream fill per card or block, on the act he is most likely to take", with a chosen setting
  as a separate use of cream.
- **Apply it:** exactly one cream button per card, on the positive act Life recommends; never on Later, a dismissal or
  an alternative; never two.

### 4. Reuse patterns, so everything feels familiar

- **From:** the log, "A standard way to show what an ask is about matters more than a layout that suits one kind";
  the spec, "the thread has one shape for anything Life puts in front of him"; the app v4 plan as quoted in the
  prototype, "Every new piece is an item with a state, a fenced block in Life's Markdown, or a mark on a message"
  (`:1246-1248`).
- **In the prototype:** the same row draws an ask, a matter, an item in an answer, a place, a profile's "Needs you",
  and (as its header only) a notice (`:639`, `:996`, `:1004`, `:1198`, `:921`). The unfolded header is the row, only
  larger: "the page opens with exactly the row" (`:642`). Every ask kind shares header, why, body, answers (`:672`,
  `:661`). Every act reads the same way (`runAct`, `:713-715`). Every Undo says "Undoing…" then its outcome
  (`:725-731`, `:1375`). A follow-up lands like any ask Life brings (`:856`). Settings are a block in Life's answer, not
  a page (`:1377`).
- **Apply it:** start from the row, the ask shape or an answer block. A new kind of ask is a new body inside the same
  header and answers, never a new card. A new state is a new line of the row, never a new look. If nothing fits, say
  so before inventing (answer-components.md: a miss is recorded).

### 5. Life does what it can without him

- **From:** product.md, "Do everything that can be done without the person", and its ladder of acting without asking;
  his words of 22 Nov, "Life takes care of shit for you in the background".
- **In the prototype:** after "Contact", Life drafts the booking itself and only the send comes back to him
  (`followUpOf`, `:851-853`). Long work is handed off with 👀 and an estimate, and he carries on (`:1320-1332`).
  A fix ask offers only steps Life can really do, and away from his Mac only a reminder (`:668-671`). Offline, his
  words and answers queue and go by themselves when he is back (`:930-937`).
- **Apply it:** before making something an ask, check the ladder: if Life can do it, it is an item under way or
  nothing at all; ask only for what is his (a send in his name, money, something only he can do).

### 6. Spoon-feed: what, why, and what each answer does

- **From:** product.md rule 6, "One decision per card: what, why, and what each answer does"; his direction of 22 Nov,
  "we spoon-feed it to you".
- **In the prototype:** the title says what ("Pick a clinic for the tattoo"); one line says why ("For your tattoo and
  Nora's scars… Prices… may be out of date", `:590`); a foot line says what the answer leads to ("Life then drafts one
  booking message to the clinic, for your yes.", `:592`); the button names the act. The WhatsApp Undo says what the
  other side will see before he deletes (`:1268`, `:1374`). A fix spells out numbered steps for where he is (`:605`).
- **Apply it:** one decision per card. If an answer has a consequence he can't guess, say it in one line before he
  taps, never after.

### 7. Words only where the decided rules allow

- **From:** brand.md "Minimal" ("a control shows a mark or a number, never a word label, wherever a mark or a number
  can say it"); his answer 8 of 26 Nov: words only on an ask's and a question's answers, a confirm's two choices, a
  draft's quick-edit chips, and "Later".
- **In the prototype:** Send is an arrow, dictation a microphone, what waits a number, the pendant a dot, fold a ⌃,
  profile reach buttons app logos (`:547`, `:761`, `:298`, `:1196`); words on answers ("I paid it"), chips ("Warmer"),
  and Later (`:1358`, `:664`). Words a mark replaces go to VoiceOver (`aria-label` throughout).
- **Apply it:** a new control gets a mark; it gets a word only if it is one of those four kinds, three words at most
  (brand.md Wording).

### 8. One accent colour, for urgency only

- **From:** brand.md, "Make colour useful: status only" and "Urgency is a `flag` dot and `flag` words"; the log,
  "coral only for today".
- **In the prototype:** coral appears on one word, "today", in a line (`:638`), and leaves once settled (`:303`).
  Green only says "it worked" (the tick, the done button, `:304`, `:404`); Life's blue only marks Life's own reading
  (`:227`, `:261`). The rest is cream on black.
- **Apply it:** no colour unless it means urgency (coral), success (green) or Life's own guess (blue), plus the three
  exceptions of his answer 5 (an app's colour on its draft, a face's hue, the aura). Colour never decorates.
- **Settled (answer 1):** "tonight" is coral like "today".

### 9. Nothing moves or disappears behind his back

- **From:** the spec, "An item changes state where it is. It never moves or vanishes"; brand.md Motion, "Nothing
  jumps"; the log, an ask he skips is "closed, never left with live buttons".
- **In the prototype:** an answered item folds back into its row with its new line (`refreshLive`, `:708-712`); a
  sent reply stays in its list; Later shows on the row. Buttons that retire fade out (`:674`). An ask he skipped gets a
  closing line, "Left for now, still waiting on you" (`:818`). A follow-up never lands while he types, speaks or has an
  ask open (`isFree`, `:850`), and if he has scrolled up a down pill shows instead of a jump (`:855-861`). Unfolding
  scrolls just enough, never pushing the header under the top (`:878`).
- **Apply it:** every change happens where the thing is, animated; nothing is removed from a list he is reading; when
  something can't be in place, one quiet line says where it went.

### 10. No technical words, no agent names

- **From:** product.md rule 8, "Life's insides never show"; his decision of 22 Nov that he sees "Life working, never
  which agent"; brand.md Wording, none of the system's own words.
- **In the prototype:** the steps line says "Reading your chat with Tomas", "Checking your payments" (`:1082-1101`),
  never a tool; an item under way says what is being done, "Contacting Dr. Ink"; the edge shows that Life works, with
  no words. A failure is "WhatsApp signed Life out, so I can't send there" (`:604`).
- **Apply it:** write every word as a good human assistant would say it; never a tool, an agent, a step id, a count of
  facts or a confidence.

### 11. Every tap shows its result

- **From:** his memory note of 18 Nov ("Every tap shows its result": loading, then a green result or a clear failure);
  the log, every action "shows the owner that Life did it and recorded it".
- **In the prototype:** an answer turns "Sending…" with a spinner, then green "✓ Sent" for one second, then the item
  takes its state (`:713-715`). A setting shows a green tick beside its title for 1.4 s (`:1395`). A reaction lands
  with a small spring (`:450`). Undo shows "Undoing…" then its outcome (`:728-731`).
- **Apply it:** every control has a doing state and a done state, in place on the control itself; a failure shows
  there too ("Not sent", spec).

### 12. What is broken comes first, so silence can be trusted

- **From:** product.md rule 2, "Silence must be trustworthy… what is wrong and needs the person comes before anything
  else"; the spec, a fix "ranks first in what waits".
- **In the prototype:** a fix ask is put at the top of what waits (`ASKS.unshift`, `:942`); something he can do nothing
  about is a notice, one per problem, updated in place and settled when fixed (`:925-928`); the edge goes still while
  Life can't be reached (`:759`). Nothing says that all is well.
- **Apply it:** a new failure is a fix ask (if he can fix it) or a notice (if not), never a banner or a red screen;
  never a message saying everything works.

### 13. Every question can be left, and his own words always answer

- **From:** brand.md Wording, "Every question can be left for the next one"; the spec, "Typing or speaking always
  answers too".
- **Confirmed by the owner (26 Nov):** one principle: nothing traps him in a step.
- **In the prototype:** Later sits on every ask (`:664`); a question has no closing line if he does something else
  (spec); typing a change to a draft redrafts it (`v4Route`, `:1433`); a "words" question has no control at all, only
  the microphone calling softly and suggestions in the field (`:1130`).
- **Apply it:** every new ask has a way to put it off; every new question accepts his own words.

## The checklist: test a new component against the principles

1. Does it show anything he doesn't need to act or decide? Remove it, or move it into the unfolded body or behind the
   field. (1)
2. Could Life do this without him? Then it is not an ask. (5)
3. Is there exactly one cream button, and is it Life's recommendation, named by what it does? (2, 3)
4. Is everything else a quiet pill, with Later (or the card's own word) first? (3, 13)
5. Is it built from an existing pattern: the row, the ask shape (header, why, body, answers), an answer block, a mark
   on a message or a notice? If not, why not? (4)
6. If it is a row: a face (an initial for someone, a mark for a thing), a verb-first title, a "who · when" line, at
   most one trailing pill, and no card, divider, chevron or badge? (1, 4)
7. Does it say what, why in one line, and what the answer leads to? One decision only? (6)
8. Does every word sit where the rules allow words, and every other control show a mark? (7)
9. Is every colour coral for urgency, green for done or blue for Life's guess, or one of the three exceptions? (8)
10. Does every state (needs you, later, under way, waiting, settled, queued, outdated, failed, and any new one) have
    its line, its tap and its Undo, and does it change in place without moving or vanishing? (4, 9)
11. Does every tap show doing, then done or failed, on the control itself? (11)
12. Is there any technical word, agent name or number he can't act on? (10)
13. If something breaks, is it a fix ask ranked first or a notice? (12)
14. Can he leave it, and does typing or speaking answer it? (13)

## The rules in detail

The principles above, broken into concrete rules with their evidence. Where a table repeats a principle, the
principle wins.

### Wording

| Rule | Example in the prototype | Why (where known) |
|---|---|---|
| An item's title is what he must do, verb first, short | "Send Ben the call recap", "Pick a clinic for the tattoo", "Call the bank" (`2026-11-25-app-v4.html:583-619`) | Log, "Tried on the owner's real asks": a name alone does not read as something waiting; Life's card titles were news. |
| A thing that is not an ask may be a noun | "Boiler repair", "Dentist cleaning" (`:620-622`), both waiting on someone | Unsure why: these are matters, not asks; the spec gives matters the same row but no title rule. |
| A question as title ends with "?" | "Raise this month's budget?" (`:611`), "Keep looking for a physio?" (`:1345`) | brand.md Wording: the first line is the question. |
| The line is who, then when, joined by " · " | "Ben · tonight", "Paul, for the leak · Fri", "Confirm your new card · this week" (`:638`) | Log: "Its line is who it is about and when it is due". |
| The "who" part may say what it is about instead of a person | "Confirm your new card", "For you and Nora", "From Ms Hale's mail" | Unsure why it is sometimes the purpose, sometimes the person; the rule seems to be "whatever tells him which one this is". |
| A state replaces the line; it never adds to it | "Later · tomorrow 9:00 · Undo", "✓ Sent to Jade" (`:632-638`) | Spec: "The item says how it stands, so no line repeats it". |
| Amounts go in the line or body, never in a spending ask's title | "About 1 € more · 1 € so far" (`:1347`) | His answer 1-11 table: "Amounts in a line, never in the title". |
| Life speaks as "I" in sentences, never on a button | "I'm on it. It takes a few calls…" (`:1330`); buttons say "Send to Jade", "I paid it" | His answer 7. Note "I paid it" is his voice, not Life's. |
| A button says what it does, in his words | "Send to Jade", "Contact Dr. Ink", "Done, it's linked", "Remind me when I'm home" | Spec, "One shape for every ask". |
| One quiet line for what happens between items | "You sent **Send Ben the call recap**", "Left for now, still waiting on you" (`:818`, `:899`) | Spec: Life's lines are only for what happens between items. |

### Colour

| Rule | Example | Why |
|---|---|---|
| Coral (`--flag` #f0896f) only on the word "today" in a line, and on a needs-you dot | `when==='today'?'<em class="td">today</em>'` (`:638`); "Reply to Jade · *today*" | Spec: "coral only for today". "tonight" and "Tue" stay muted. **Settled (answer 1):** "tonight" turns coral too. |
| Coral leaves once settled | `.fr.settled .td{color:inherit}` (`:303`) | Log: once settled "its due date no longer coral". |
| Green (`ok` #30d158) only for "it worked" | the tick in a settled line (`:304`), the done button (`:404`), a saved setting (`:492`) | brand.md: `ok` it worked. |
| Life's blue only for Life's own reading or pick | "Life's pick" on a question's option (`.xbest`, `:261`), "What Ben is like" on a profile (`.plike`, `:227`), the aura while working | brand.md: `ai` an agent or a guess of Life's. **Settled (answer 3):** blue everywhere, the pick cards included. |
| An app's own colour only on its own draft | WhatsApp green on the chat's bubbles, draft and "Open WhatsApp ↗" (`:439-443`); Messages blue for iMessage (`:471-474`) | Log, "A draft": branded per app so he sees where it goes. His answer 5. |
| Emoji in monotone | `filter:grayscale(1)` on reactions and the rating (`:451`) | His answer 6: emoji add no colour. |
| Everything else is cream on black, with `muted` for the line | `.fr small{color:var(--muted)}` (`:144`) | brand.md: hierarchy by size and weight, not colour. |

### What is never shown

Beyond principles 1, 7 and 10 (no "more details", no word where a mark says it, no agent or tool):

| Never | Evidence | Why |
|---|---|---|
| A divider between item rows | `.fc .fr` has no border (`:289-290`); the old `.row` with `border-top` (`:67`) is unused | Log, "What waits on you": "no headline, no dots, no dividers". **Settled (answer 4):** no hairlines anywhere, settings and tables included. |
| A card behind a row | `background:none!important;padding:7px 0!important` (`:289`) | Spec, "No cards (owner, 23 Nov 2026)". |
| A chevron on a row | none in `rowHTML` (`:639`) | The row unfolds in place; a chevron would promise another screen. The only chevron is a settings action ("Pair again with your Mac", `:1391`). |
| A badge or count on a row | none | brand.md: no number he cannot act on. The one count is the round button at the top. |
| A heading over a list | the list's lead is the answer's headline sentence ("Six things wait on you; first, send Ben the call recap."), never a label | Memory "No prose titles"; the owner's 28 Nov ask: every answer opens with one headline sentence. |
| A border or ring on any surface | the row flash is a wash (`:297-301`) | brand.md "No borders". Exceptions drawn: the draft's dashed outline, radio rings, the reaction's black cut-out ring, the glass hairline. |

### Faces versus marks

| Rule | Example | Why |
|---|---|---|
| A person: their initial, bold, in a dark round disc | "B" for Ben, "J" for Jade, "P" for Paul (`.disc`, `:147`) | Spec: "Who asks, in large (their face or mark…)". |
| An organization in a row: also its initial in a round disc | "D" Bright Dental (`:622`), "O" Oak Law (`:1045`), "B" Bead House on its profile | **Settled (answer 2):** its own picture when Life has one, else its initial. |
| A mark when there is no one to show: a place to choose, a calendar event, money, a broken service, a document | pin for "Pick a clinic" (`:589`), bank for "Call the bank" (`:617`), calendar (`:1277`), "€" (`:611`, `:1280`), the WhatsApp logo for "Sign WhatsApp back in" (`:604`), a document for "Send the Article 23 letter" (`:1019`) | Spec, the fix ask: "its face is what broke". **Settled (answer 2):** an organization is never a generic mark; marks are for no one to show. |
| A face that is someone Life knows opens their profile on tap | `data-person` only when the item names a profile (`:629`) | Spec, "Profiles". In the prototype only Ben's, Tomas's, Maya's and Bead House's faces open one; Jade's "J" does not, only because no profile was written for her. |
| Every disc is a circle in the thread; an organization's face becomes a rounded square (28 %) only on its profile | `border-radius:(p.org?r.w*.28:r.w/2)` (`:1214`, `:1218`) | **Settled (answer 5):** a circle everywhere, its profile included. |
| A person's disc is a touch lighter than a mark's | `#2b2c33` for `[data-person]` (`:228`) against `#24252b` (`:147`) | Unsure why; perhaps to hint it can be tapped. |
| A mark is muted only in a notice | `.sys .disc{color:var(--muted)}` (`:276`) | A notice needs nothing from him. |

### Buttons

| Rule | Example | Why |
|---|---|---|
| The cream button (principles 2 and 3): full width, 50 px, a pill, the result's word and a mark | `.prim` (`:400`); "Send both ↑", "I paid it ✓" (`:583`, `:616`) | See principle 3. |
| The other answers: equal quiet `tint` pills in one row under it | `.two .sec` (`:362`); "Not now", "Recap only" (`:664-666`) | Log: "Never bare text". |
| "Later" (or the card's own word) is always the first quiet pill | `m.defer||'Later'` (`:664`); "Not now", "When I find it" (`:609`) | brand.md: "Later" is the one word on a quiet pill; a clock confused. |
| A pick's button waits for a pick, then names it | disabled until picked; "Contact Dr. Ink", "Book Harbour Physio" (`:662-663`) | Log: "the pick is preselected and the button names it". Life's pick is preselected (`picked:0`). |
| A question's two answers are equal pills; the likelier is inverted (cream) and on the right | `ord` sorts `rec` last (`:1009`); `.xyn button.rec` (`:254`) | Spec, "Life's questions" (owner, 24 Nov). |
| An answer that starts real work carries a small lit dot | `.xmv` (`:262`) | Spec: "Such an answer carries a small lit mark". |
| Round 36 px buttons in the field; 40 px at the top and in blocks | `.k` (`:51`), `.pill.dot` (`:44`), `.xib` (`:249`) | Unsure why two sizes; the field's are inside the capsule. |
| An inline action in a line is bold text in cream, no pill | "· Undo", "Reopen", the item's name as a link (`:305`, `:299`) | Unsure why; it keeps the line one line. |

### Unfolding

| Rule | Example | Why |
|---|---|---|
| A row unfolds where it is, never at the bottom, never on another screen | `inPlace` (`:872-889`) | Log: every tap becoming his bubble and a copy at the bottom "felt like a chat bot". |
| The unfolded header is the row, larger: face 48, title 19, line 14 | `.inplace .hero` (`:292-295`) | Log: "The page repeats the row… only larger". |
| Room above and below, a faint wash of light (cream 6 %, radial), no edge, bleeding to the screen's sides | `.inplace` (`:291`) | Spec, "No cards": "space and scale". |
| A ⌃ fold button, top right, quiet | `.ipx` (`:298`) | Spec: "each folds by its ⌃ or when answered". |
| No ink: measure, scroll just enough to fit it (never its header under his pinned words), then one height reveal of 380 ms | `UNFOLD_MS=380`, `topPad` (`inPlace`) | Log: "Unfolding has its own motion… no ink, which is for what Life says". |
| Several may be open at once; typing or speaking leaves them open | nothing in `send` folds an in-place item (`openAskId` skips them, `:816`) | Spec, "several at once if he likes". The comment at `:864` still says "one at a time"; the code and the spec say several. |
| Answered, it folds back to its row in its new state; away from the bottom, Life's line says so with a link back that lights the row | `decidedAway` (`:898-899`), `gotoItem` flash (`:900-902`) | Spec, "Unfolding". |
| A single item in an answer arrives already unfolded, its row hidden above so it can fold | `expand` (`:955-960`) | Spec, "Answers to his questions" (owner, 24 Nov). |
| Answer buttons live only on unfolded items; older ones lose theirs | `retire()` removes `.lt` and bare answers when anything new arrives (`:674`) | Log: "only the newest thing asks for a decision". |

## The item row

What Life shows for anything that may need him: an ask, a matter, a fix, a task Life works on. The answer to "What's
waiting on me?" is a list of these rows (`waiting()`, `:974-976`), in the order of `ASKS` (`:625`):

| Face | Title | Line | Trailing |
|---|---|---|---|
| B (Ben's profile) | Send Ben the call recap | Ben · tonight | none |
| J | Reply to Jade | Jade · *today* (coral) | none |
| pin | Pick a clinic for the tattoo | For you and Nora · Tue | none |
| P | Pay Paul 240 € | Paul, for the leak · Fri | Later |
| bank | Call the bank | Confirm your new card · this week | Later |

### Anatomy (folded)

`rowHTML` (`:639`), styles `:138-147`, `:289-290`.

- **Row:** a flex line, items centred vertically, 12 px between face and text, 7 px above and below, 2 px between
  rows (so about 16 px from one row's text to the next face). No background, no radius, no border. The whole row is
  the tap target (`data-open`).
- **Face:** a 40 px circle (`.fc .fr .disc`, `:139`; 44 px outside a list), fill `#24252b` (a person `#2b2c33`), the
  initial in 16 px 700 cream, or a 20 px line mark (1.8 stroke). Never a photo in the prototype.
- **Text:** the title, 16 px 650, cream, one line; under it the line, 13.5 px, `muted`. The text takes all the width
  left (`flex:1;min-width:0`).
- **Trailing:** only the Later pill: 32 px tall, 13 px side padding, a full pill, `tint` fill, 13 px 600, a lighter
  muted (`#b9b4aa`) (`.lt`, `:146`). Nothing else ever trails a row in the list: no chevron, no time, no dot.
- A list is wrapped in Life's words block stretched to full width (`bt wide` > `.fc`, `:976`), with no heading.

### Rules

- **Face:** a person's or organization's initial; a mark when the thing has no one behind it (see "Faces versus
  marks"). The face is "who asks" (spec), which for an ask from an agent is who it is about.
- **Title:** the one-line ask, verb first (`m.ask`). The same words open the unfolded header, the notification's
  title and the "You sent …" link.
- **Line, needs you:** `sub · when` (`:638`). `sub` is who or what it is about; `when` is the due word: today,
  tonight, a weekday, "this week". With no `when`, the line is `sub` alone, with no trailing " · ".
- **Coral:** only when `when` is exactly "today" (`:638`). Gone once settled (`:303`).
- **Later on the row:** only for a task he does outside Life (`m.task`: Pay Paul, Call the bank, the parking fine),
  and only while it needs him (`:639`), and only on the newest list (`retire`, `:674`). Never on a decision or a
  reply: the log says answering one takes a second, and an unanswered decision waits anyway.
- **Tap:** opens it in place while it needs him, is later (tapping a later row lifts Later and opens it, `:756`) or
  waits on someone. A row under way, settled, queued or outdated is inert: `isInert` (`:640`), `cursor:default`.
- **Copies are one item:** every row and unfolded copy of the same item is refreshed together (`refreshLive`,
  `:708-712`), so a choice made in one shows in all.

### States

`stateOf` (`:630`) gives one state, in this priority: outdated, queued, under way, settled, later, waiting, needs you.
`lineHTML` (`:632-638`) writes the line for it.

| State | Line | Look | Tap | Undo | Example |
|---|---|---|---|---|---|
| Needs you | who · when (coral "today") | normal; Later pill if a task | unfolds | — | "Jade · *today*" |
| Later | "Later · tomorrow 9:00 · Undo"; a fix says "Reminder · when you're home · Undo" | normal, no pill | unfolds (lifts Later) | lifts it | after Later on "Pay Paul" |
| Under way | spinner (11 px), what Life is doing, "· Undo" if it can still stop | inert | none | stops it | "Contacting Dr. Ink · Undo" |
| Long work under way | a still ring that fills at each milestone, then the estimate | inert | none | "Undoing…", then "Stopped, nothing booked" | "◔ About 20 min · Undo", later "About 10 min left" (`:1329-1332`) |
| Waiting on someone | "Waiting on Paul's quote · Thu" | normal | unfolds to read | — | Boiler repair (`:620`) |
| Settled | green ✓ and how it ended (no full stop), "· Undo" while it can be tried | inert, coral gone | none | "Undoing…", then "Undone · Reopen" or why not | "✓ Sent to Jade", "✓ Booking drafted, below" |
| Settled, a WhatsApp send | "✓ Sent to Lena · Undo until Fri" | inert | none | opens a confirm (below) | (`:1265-1268`) |
| Settled, an iMessage or mail send | "✓ Sent to Nora", no Undo | inert | none | none: the app can't delete | (`:1270-1273`) |
| Deleted for both | "✓ Deleted for both of you" | inert | none | — | after Undo on Lena's (`:1375`) |
| Queued (offline) | clock mark, "Goes when you're back" | inert | none | — | answered while offline (`:719`) |
| Outdated | the reason | the whole row faded to 35 % | none | — | "Jade wrote since", "You replied in WhatsApp", "Fixed on its own" (`:982-983`, `:943`) |
| Earlier draft | "Earlier draft" | faded to 40 % | none | — | after a typed redraft (`:1366`) |
| Opened below | unchanged | dimmed to 42 % | — | — | only in the old "your turn" way and from a notification (`:333`, `:837`) |
| Failed | not drawn in the prototype | — | — | — | the spec puts it on the button: "Not sent", tap to try again; "May have gone", no retry |
| Already answered elsewhere | not drawn | — | — | — | the spec: the button reads "Already answered: Sent" |
| Held | not shown at all until he is free; then rows under one quiet separator | — | — | — | "While you were in your meeting · 14:00 to 15:00" (`:1428`) |

- An item changes state where it is; it never moves or leaves the list (spec). The count at the top goes down
  instead (`finish`, `:716`).
- A Later done from the row reads like any act: the pill spins, turns green with "Tomorrow" for a second, then the
  line becomes "Later · tomorrow 9:00 · Undo" and the pill goes (`laterRow`, `:724`; `refreshLive` removes it, `:710`).
- Undo is an attempt: "Undoing…" with a spinner, then "Undone · Reopen", where Reopen brings the ask back unfolded;
  or one line saying why it couldn't ("Can't undo: Life already drafted the booking.") (`:725-731`).

### Unfolded

`inPlace` (`:872-889`) builds the unfolded item: ⌃, the header (`heroHTML`, `:643-644`), the why, the body of its
kind (`bodyHTML`, `:648-660`), the answers (`barHTML`, `:661-667`).

- **Header:** the row, larger (48 px face, 19 px title, 14 px line), same words, same line with its coral.
- **Why:** at most one line, 14.5 px, the lighter muted ("He was promised the transcript on today's call…").
- **Body** by kind: a reply shows its chat and the draft; a pick, option cards; a payment, the amount and IBAN; a call,
  the number and what to say; an event, when and where; a fix, the steps; waiting on someone, one line and their last
  message, no answers. See "The ask card's parts".
- **Answers:** the cream button full width, then the quiet pills.
- **The wash:** a radial cream 6 % behind the whole item, from screen edge to screen edge, no border.
- **After an answer:** the button goes "Sending…", then green "Sent" for a second; the item folds back (300 ms) into
  its row, whose line now says the new state ("✓ Sent to Jade"); if the item was not at the bottom of the thread,
  Life's line at the bottom says "You sent **Reply to Jade**", the name a link that scrolls back and washes the row
  once. The suggestions in the field switch to what usually follows (`after`).
- **A follow-up:** an answer that hands on (the clinic's "Contact") turns the row under way ("Contacting Dr. Ink");
  the edge works; the next ask lands at the bottom with Life's lead, already unfolded ("Here's the booking message for
  Dr. Ink."), and the first row settles as "✓ Booking drafted, below" (`followUpOf`, `:851-853`). It never lands while
  he types, speaks or an ask Life brought is open, and if he has scrolled up a round down-arrow pill shows instead of
  a jump (`:854-861`).

### What I read as its five most important choices

1. A row is bare: a face, a verb-first title, a muted line, and at most one quiet Later pill; no card, divider,
   chevron or badge.
2. The line is always "who · when", and only the word "today" turns coral; any other state replaces the whole line.
3. Later appears only on tasks he does outside Life (pay, call), only while they need him, and only on the newest list.
4. A tap unfolds it in place, the same header grown, on a faint wash with no edge, its answers on it.
5. It never moves or disappears: answered, it folds back into its row and the row's line says what happened.

## Other components

### Turns (turn by turn, 28 Nov)

The thread is a pager of turns (`group`, `.turn`): each turn is one page, at least a screen tall, and the thread snaps
gently from turn to turn (`scroll-snap-type:y proximity`), never inside an answer.

- **Anatomy:** what heads the turn (a day separator, his words, the bell of an answer given on a notification), then
  Life's answer (`.ans`), flowing as long as it needs and centred when it is shorter than the page. Show earlier rides
  at the top of the turn after it. A turn Life starts itself (a card it brings, a result that lands, a held list) is a
  page with no question (`newTurn`). The opening screen is the first turn, top-aligned.
- **Rules:** a new turn turns the page to it; while Life's answer comes in, the thread follows it but never lets the
  answer's headline go under his pinned words. Every answer opens with **one headline sentence** that answers
  directly (19 px 650, the answer's first line), then blocks rather than prose, then up to three follow-ups. No card
  scrolls inside: a chat shows its messages whole.
- **Why:** the owner's ask of 28 Nov 2026, "bake in the turn by turn into the validated prototype".

### Follow-ups (new component, 28 Nov)

`.fups` (`paintFups`): up to three quiet `tint` pills, 36 px, 13.5 px 600, wrapping, under the latest answer only.
They are the field's suggested asks for what is on screen (`suggNow`), less the question he just asked; a tap asks it
as his words. Not on the opening screen. **Open:** the field still rotates the same asks, so they show twice.

### A day (new component, 28 Nov)

`dayTL`: a timeline, one row per event: its time (15 px 650, tabular), a 9 px dot on a 2 px thread, then what and where
(15 px 650 and 13.5 px muted). A new slot sits on a faint `tint` wash with a cream dot. The one format for a day
("What's on today?", his Thursday after an event is added), then "You also have N waiting on you" and their rows.

### His words (his bubble)

`.bm` (`:63`, `:331`), with the queue mark (`:278`) and the notification mark (`:328`).

- **Anatomy:** in a turn, his words are its title, pinned at its top (sticky) with no bubble: cream 650, 26 px when
  short (up to 30 characters), 19 px up to 64, 16 px beyond. Pinned once his turn is scrolled into, a soft blurred edge
  shows under them and a long question clamps to two lines; at the turn's top it shows whole. (Before 28 Nov: a
  right-aligned bubble, cream at 11 %.)
- **Rules:** his words appear at once, never inked (`:692`). It is quiet because "the full cream bubble was too loud"
  (log, 23 Nov). A tap made outside the thread (a notification's answer) enters as his bubble in the card's words with
  a bell and the time under it (`:841`). Offline, a small clock and "when you're back" under it (`:962`).
- **States:** sent; queued; Life's reaction under it (below).

### Life's words

`.bt` (`:64-65`), the reveal (`:676-705`).

- **Anatomy:** no bubble, left-aligned, max 310 px (a list or a block stretches it full width, `.bt.wide`), 15.5 px,
  line 1.45, bold 650 for the one or two words that answer ("Paul still owes you his **quote**").
- **Rules:** words ink in one by one (28 ms apart, blurred to sharp), blocks one after another (110 ms); the thread
  follows in batches, never word by word, keeping the answer's headline in view under his pinned words (`batchFollow`).
  The answer's first line is its headline (Turns, above). Under Reduce Motion it
  appears whole. Markdown: paragraphs, lists, bold (`.xmd`, `:233`). A short lead introduces an item Life brings
  ("Jade asked about Saturday:").
- **Why no bubble:** unsure; the spec only says Life's words are full Markdown "as he knows it from AI chat apps",
  which suggests the ChatGPT and Claude look of answers as plain text.

### Life's quiet line

`.line` (`:175-176`): centred, 13 px, `muted`, a bold cream link or button inside. Used for what happens between
items: "You answered …", "Left for now, still waiting on you". Never inks (`:675`).

### The steps line (Life at work)

`.lfw` (`:182-199`), `lfStep` (`:1105-1116`).

- **Anatomy:** one line, 22 px tall, under his bubble: a 16 px glyph, then the step in 15 px: the verb muted, the
  object cream 600; a person's object gets an 18 px mini face before it ("Reading your chat with (T) Tomas").
- **Rules:** a step is a verb and what it acts on, never a tool or an agent. A step that reads or acts turns a
  spinner; thinking shows three circling dots and "Thinking…", the word shimmering; a retry says "Taking a little
  longer…". Each step takes the last one's place: the old blurs away upward (0.28 s), the new inks in letter by
  letter (22 ms). One line, never a list. When the answer starts, the line blurs away and the words ink in where it
  was.
- **Why:** spec, "While Life works" (owner, 24 Nov).

### Day separator and Show earlier

`.sep` (`:152`): centred, 12 px muted ("Yesterday", "Today"). `.more` (`:153`): a `tint` pill, "Show earlier", at the
top. A held-asks separator uses the same face: "While Sleep was on" (`:1465`).

### Answer blocks

Each block is drawn by `XB` (`:997-1005`). No block takes a colour, size or layout from Life's words
(answer-components.md, "No style").

| Block | Anatomy | Rules | States |
|---|---|---|---|
| **Items** | rows exactly like the item row, in a list with no heading (`xrow`, `:996`) | lines are Life's, read from the item ("Waiting on Tomas · since yesterday", "Not sent yet"); a single item arrives unfolded | the item row's states |
| **Settings** | a `card` block, radius 22, 16 px sides; small muted group headings ("Sending", "Spending"); rows of 12 px, no hairline (answer 4); title 15 px 600, an optional 12.5 px muted line; trailing a switch (50×30, on = cream with a black knob), equal value pills (on = cream), or a round 36 px button with a chevron for an act (`:486-500`, `:1389-1394`) | switches act in place; a green tick shows beside the title for 1.4 s (`saved`, `:1395`); the instruction he just gave shows as its switch ("Notify me for newsletters", off); "What can I change?" lists only real settings | off, on, saved; an act's line goes "Showing a code on your Mac…", then "✓ Paired", or queued offline |
| **Pictures** | a strip of up to three, 108 px tall, 6 px gaps, outer corners 14, inner 5; a caption bottom-left in white with a shadow ("Ana · 18:39"); the third carries "+4" on a dark veil (`:235-242`) | a tap shows it full screen, the one screen Life opens (spec, "Answers to his questions") | — |
| **Place** | a row: the pin as face, the name as title, the address as line, a trailing "Maps ↗" chip with the Google mark (`:1004`, `:252`) | opens Maps on tap only; never a drawn map (answer-components.md) | — |
| **Document** | paper (`#f4f1ea`) with dark text, radius 16, the issuer in Manrope bold, the key lines in mono 12.5 px, the source and day top-right ("Messenger · 15 Nov") (`:250-251`) | lines copied as written, checked against the source | — |
| **Table** | full width, 14.5 px tabular figures, a muted 12.5 px header, no hairlines (answer 4), the last column right-aligned, a note in muted after a value ("all they had"), the total in bold set apart by space (`:243-246`) | values checked against `from`; groups as small muted labels | — |
| **Phrase** | a `tile` block, radius 20: the phrase 22 px 600 in its language, his translation 13.5 px muted, two round 40 px buttons (speak, full screen) (`:247-249`) | full screen shows it 38 px centred on black, to hold up to someone | — |
| **Question** | the question as Life's bold last line (`.xask`), then its own control by kind (`xq`, `:1007-1013`) | which, offer, confirm: two equal 44 px pills, the likelier cream and on the right; value: equal round pills with gaps, never a segmented control; person: faces side by side, each with name and a line; options: option cards with a radio, name, Life's pick in blue and one line of facts; his words: no control, the microphone pulses and the field suggests | asked; answered: the pills fade, his answer becomes his bubble, then Life's short ack, or the work it starts as an item under way with Undo, which settles or becomes an ask ("Here it is, for your yes:") (`:1131-1142`) |
| **Aura knobs** | a settings block: ten round swatches (32 px, the chosen one scaled 1.12 with a tick), its name; a state picker (Idle, You speak, Working); per knob, its name and value, a track with its band drawn on the whole scale, its ends labelled (`:516-534`, `:1508-1515`) | each knob moves only within its state's band; the edge previews the state while he drags | — |

- **Why a question is not an item:** spec: it is not counted and never notifies; its answers become his words.
- **Settled (answer 3):** "Life's pick" is blue on options and pick cards alike.

### The ask card's parts

Every unfolded ask, whatever its kind, is the same shape (spec, "One shape for every ask"): header, why, body,
answers.

- **Header** (`.hero`): see the item row, unfolded.
- **Why** (`.why`, `:380`): at most one line, 14.5 px, lighter muted. The rest of a card's context stays reachable by
  asking, not shown.
- **A reply's chat** (`chatHTML`, drawn by the one global chat, `CB.chat` in `2026-11-26-design-lab/card-blocks.js`,
  since 28 Nov): its head is the draft's header, so a draft has no other: the person's or group's picture (initials
  when none), the name, the app's name, and an arrow in the app's colour that opens the chat; the card's one line of
  why under it. Their messages on the left (a 5 px top-left corner), his on the right in the app's colour, each with
  its time; messages in between that are not the matter's as one quiet centred count ("3 unrelated messages"); whole,
  never scrolling inside the card. The draft: the app's sent colour at 8 % with a dashed 1.5 px outline in that colour,
  which fades once sent; a file inside it as a small row. The dashed outline is the owner's one exception to no
  borders (brand.md, decision 82).
- **Quick edits** (`qesHTML`, `:1357-1359`): up to three 30 px `tint` chips, right-aligned under the draft
  ("Warmer", "Shorter", "In French"), and a round back arrow once one was used. A tap blurs the draft and inks the new
  one in place. A typed change ("Make it warmer…") folds the old version to a faded "Earlier draft" row and lands the
  same ask again below.
- **A pick** (`:654`, `:365-377`): option cards (`tile`, radius 18): a radio, the name, "Life's pick" tag, one line of
  facts, a "Google Maps ↗" chip that opens the place without picking it; a chosen card is a little lighter with its
  radio filled (log: "only a little lighter"). A foot line says what follows ("Life then drafts one booking message to
  the clinic, for your yes.").
- **A payment** (`:655`): a `tile` box, the amount 34 px 700, then "To", "IBAN" (mono), "Reference" as quiet label and
  value rows; a link "Open your bank ↗" under it. Button "I paid it ✓".
- **A call** (`:656`): a box with the number as a tap-to-call pill, "What to say" and the script. Button "Done ✓".
- **An event** (`:657`): a box with the title, When, Where, Reminder. Button "Add it ✓".
- **A fix** (`:604-613`, `:658`, `:668-671`): written for where he is: at home the numbered steps; away, the main
  answer is "Remind me when I'm home" and its later reads "Reminder · when you're home". The face is what broke; it
  ranks first in what waits.
- **A spending stop** (`:1345-1348`, `:653`): why, then one small line "About 1 € more · 1 € so far"; answers Keep
  looking, Later, Stop here.
- **Waiting on someone** (`:650`): a `paper` box "Nothing to do: Life will bring it to you when it arrives.", a small
  heading "Last from Paul" and their last message; no answers.
- **Answers:** see "Buttons".
- **An ask Life brought to the bottom that he skips** loses its buttons and gets the line "Left for now, still waiting
  on you" (`:817-818`).

### Reactions

`.rx`, `.rxbar` (`:447-457`), `react`, `openRx`, `pickRx` (`:1300-1318`).

- **Anatomy:** a 24 px round mark (`#2a2b31`) with the emoji in monotone, cut out from the page by a 2.5 px black ring;
  on his bubble's bottom-left corner; under Life's line, on its own line below it.
- **Rules:** Life puts 👀 on his bubble when it hands work on, 👍 when done, alone or with words ("Sunday at 10:00.").
  He holds (450 ms) or double-taps a line of Life's for a glass bar of 👎 👍 🤩 (the rating's marks); the same mark
  again removes it; a change swaps with a scale. A reaction is never his OK: an ask's answers stay (`:1298-1299`).
- **States:** none, 👀, 👍 (swapping in place), his mark.

### The rating ("How am I doing?")

`.hd` (`:478-484`), `v4Rate`, `rate` (`:1411-1419`).

- **Anatomy:** one `card` pill line: "How am I doing?" 14 px muted, three 38 px marks, a small cross.
- **Rules:** at most once a day, only under an answered ask; a tap keeps the mark (scaled 1.1), the others and the
  cross fade, the text becomes "Thanks", and after 1.4 s it fades to 45 %. The cross collapses it away. Nothing
  follows, not even after 👎 (his answer of 26 Nov, table "The nine pieces").

### Undo

- **On a line:** "· Undo" as bold cream text at the end of the line (`undoBtn`, `:631`), with its limit when it has
  one ("until Fri").
- **After a WhatsApp send:** Undo opens, under the row and aligned with its text (58 px in), what the other side will
  see ("WhatsApp deletes it for both of you. Lena will see “This message was deleted”, and may already have read
  it.") and two pills, "Keep it" and "Delete for both" (inverted). Then "Undoing…", then "✓ Deleted for both of you"
  (`:1372-1375`). iMessage and mail show no Undo.
- **Why a confirm here and nowhere else:** the delete reaches another person; the doc lists it as "a confirm step
  before deleting".

### The notice

`.sys` (`:275-277`), `sysHTML` (`:921-929`).

- **Anatomy:** an ask's header and nothing else: a muted mark in the disc, what is wrong as the title ("You're
  offline", "Your Mac isn't answering"), what it means for him and since when as the line ("What you do waits · since
  15:40", "Nothing is lost · since 14:10").
- **Rules:** no body, no answers, no tap, not in the count; one per problem, updated in place; fixed, it settles like
  an item ("✓ Back online · 2 sent", "✓ Back · caught up"). The offline and Mac notices carry a settings block (Face ID
  before Send, appearance; the Mac's adds "Pair again with your Mac").
- **Why:** spec: "so the thread has one shape for anything Life puts in front of him".

### The field

`.cmp` (`:46-61`), `idleField`, `listen`, `working` (`:760-809`).

- **Anatomy:** a glass capsule floating 30 px above the bottom, 16 px from the sides, radius 26, at least 52 px tall.
  Idle: the text field ("Ask Life or hold to talk"), a round `tint` microphone, and a round cream Send that is faded
  to 35 % while the field is empty.
- **Suggested asks:** in the empty field, Life's three likeliest next asks in turn every 3 s, inked letter by letter,
  in muted, with a quiet send at the end (a 24 px outlined circle, inking in last). They follow his latest action: an
  item he unfolded, an item he just answered, a list, the newest answer, or the day's usual first asks (`suggNow`,
  `:780-790`). Typing hides them.
- **Listening:** his words ink in above the controls, a word at a time (16.5 px 500); a muted cross to cancel on the
  left; the voice bars fill the width between; the microphone filled cream (never blue: blue is Life's), and Send. No
  cursor, no timer.
- **Working:** the field disabled, one round cream stop button with a square.

### The count and the pendant buttons

`.pills` (`:38-45`), `setCount` (`:707`).

- **Count (top left):** a 40 px glass circle with the number, 17 px 700, tabular. Hidden when nothing waits. A tap
  plays his bubble "What's waiting on me?" and the list at once (`:974-976`). Held asks do not raise it.
- **Pendant (top right):** a 40 px glass circle with a 9 px lit cream dot that breathes while it records; paused, a
  hollow muted ring. Coral only when it needs him. One tap pauses.
- **Why round with no words:** brand.md "Minimal"; product.md rule 7: these are the few fixed points.

### The edge and the aura

`.edge` (`:73-112`, `:268-273`, `:507-515`), the frame loop (`:1546-1557`), the aura (`:1469-1543`).

- **Anatomy:** a ring round the whole screen (2.5 px crisp ring plus a blurred halo), made of a base ring, two lights
  turning opposite ways, a rising and falling swell, a third arc, and a pool of light at the bottom.
- **States:** Idle: a crisp ring with a fixed faint even halo under the moving lights, slow. You speak: lights twice as
  fast, the pool of light by the field flickering with the voice. Working: the cream lights give way to the colour
  swell, stronger and faster, a wider glow. Still: almost no motion, while Life can't be reached. An answer landing
  gives one bright breath.
- **Rules:** every change glides over about a second (values eased frame by frame, never restarted). Background work
  never keeps it working. The aura is one colour at a time from ten (red and bright green left out: they mean "needs
  you" and "it worked"); each state mixes cream toward it by its own colour knob, so the default looks cream at rest
  and blue while working. Each knob moves only within its state's band, and idle never moves more, glows brighter or
  shows more colour than the others; past a band Life says so in one line ("Idle is at its liveliest now…").
- **Why:** the one exception to no borders, motion and colour (brand.md); the bands so he can always tell idle, his
  voice and Life's work apart (`:1524`).

### Profiles

`.pov` and friends (`:201-228`), `profileHTML`, `openProfile`, `closeProfile`, `dragInit` (`:1153-1243`).

- **Opening:** tapping a face lifts it to the top (104 px, centred, its hue as a soft radial gradient), the thread
  blurs (26 px) and darkens behind, the page eases in under it after 0.18 s.
- **Anatomy:** the name 26 px 700 centred; who they are to him in muted ("your partner on the Northwind work"); round
  50 px reach buttons with app logos and no words; then sections with small muted headings: Needs you (item rows),
  Where things stand (short paragraphs), Waiting on Ben (item rows), Coming up, Where (a place row), Last time (one
  line: "Sun 22 Nov · WhatsApp · you settled the Monday plan"), What Ben is like (Life's blue text with a thin blue bar
  on its left).
- **Rules:** one level deep, never a stack. A glass back button top left, or a drag in any direction (it follows the
  finger, shrinks, and past 90 px lets go): the face flies back to its place in the thread. Tapping a row on it closes
  the profile first, then asks it in the thread as his words. The field's suggestions follow the profile.
- **Unsure why** the "What … is like" section is the one place a stroke-like bar appears (a 2 px inset shadow), against
  "no borders"; perhaps it reads as a quote.

### Arrivals and the notification

- **A follow-up** lands at the bottom with Life's lead once he is free; scrolled up, a round 38 px down-arrow pill
  shows instead (`.downp`, `:313`).
- **Held asks** wait with no push and no count while he is in a meeting, a Focus or asleep, unless a deadline comes
  first ("This one couldn't wait for your meeting to end:"); afterwards they arrive as rows under one quiet separator.
- **The notification** (`notifyAsk`, `:825-830`): Life's mark, the ask as title, "who · when", the draft, and at most
  two answers (the main one and Later, in the card's words). Answered there, the ask enters the thread as its folded
  row in its new state, then his bubble with a bell and the time.

## The owner's answers (26 Nov)

The points the prototype left unexplained, as he settled them:

1. "Tonight" turns coral like "today": anything due today or tonight is urgent.
2. An organization shows its own picture when Life has one, else its initials; no generic marks (the bank's building goes).
3. "Life's pick" is blue everywhere, the ask's pick cards included: blue always means Life's guess.
4. No hairlines anywhere: settings and tables separate rows by spacing only, like item lists.
5. An organization's face is a full circle everywhere, its profile included.
6. The failure states ("Not sent", "May have gone", "Already answered") are designed in the lab and picked by him before
   anything draws them.
7. Several items can be unfolded at once; each stays open until he closes it.
