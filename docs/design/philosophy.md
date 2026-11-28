# Philosophy and guidelines

This page holds every design decision of the owner's for Life's app: the goal, the strategy, the rules in force, what is
still open, and how each decision was reached. It is the one place for them, and it is amended in place when he decides
something new; git keeps every version. What Life shows and when stays in [`product.md`][product], how it looks in
[`brand.md`][brand]; the approved prototype's rulebook is [the components][rulebook] and its parts are [the design system][ds].

## The goal

- Life lowers the owner's cognitive load and does things for him. He switches between people, apps and AIs all day,
  so every screen is handed to him ready: "Life takes care of shit for you in the background… anything that really,
  really we cannot do and actually needs you, then we spoon-feed it to you" (owner, 22 Nov 2026).
- Do everything that can be done without him; show only what needs him or what he asked for: "Never show anything
  useless to the user" (owner, 23 Nov 2026). Make the technology disappear (owner, 22 Nov 2026).
- The bar is a 70-year-old who doesn't know how to use an iPhone (owner, 22 Nov 2026).
- The yardstick: what a good human assistant could do with him in an iMessage or WhatsApp thread, Life does in its own
  thread, better, since it owns the screen (owner, 23 Nov 2026).
- At a glance, with no context, anything he sees answers two questions: what is this about, and what is asked of me
  (owner, 26 Nov 2026).

## The strategy

- **Judgment instead of navigation.** Apps show menus because they can't tell what matters now; Life reads his life,
  so it can bring up only what needs him. The rules of [`product.md`][product] make that safe.
- **Chat-first, one thread.** No tab bar, no drawer, no screens: one endless conversation, a field, the edge, and two
  round buttons. Anything not shown is one question away (owner, 23 Nov 2026).
- **Turn by turn, next.** On 27 Nov 2026 the owner chose turn by turn as the app's direction: at most two turns on
  screen, his and Life's, Life working in the centre under a mesh, its answer filling the screen. It is designed, not
  approved; the arrivals rule comes first, then the build in slices ([proposal][v5], [hand-over][turns]).
- **The edge shows Life is there.** A ring round every screen says Life is present and working, without a word
  (owner, 23 Nov 2026).
- **Minimalism is the brand.** A mark or a number instead of a word wherever one can say it; ease comes from fewer
  things on screen, never from labelled buttons (owner, 23 Nov 2026).
- **The cognitive-load rule.** Judge every idea, his own included, from his seat: does it help him get something done
  with less to think about? If it serves the builder (completeness, inspection, "just in case"), say so before building
  it (owner, 23 Nov 2026).
- **Build only the approved design.** App v4 ([prototype][v4]) is the one approved design; the app is built to it.
  Variants, the lab and turn by turn are proposals until he picks a drawn design (owner, 26 Nov 2026).
- **Parity.** The app matches the prototype element by element; where the prototype draws something, it wins, with no
  variants. Done means ran live on his real Life, then a screenshot compared with the prototype (owner, 26 Nov 2026).
- **Try it on real life.** Get the main loop right first in a clickable prototype on the phone; try every proposal on
  a real matter of his; real data stays out of the repo (owner, 23 Nov 2026).

## Guidelines

The rules in force today. One line each; where a rule lives in [`brand.md`][brand] or [`product.md`][product], the
line links there.

### What decides

- Hiding something that mattered costs more than showing something useless; silence must mean "all handled"
  ([product, rules 1–2][product-rules]) (owner, 22 Nov 2026).
- Acting without asking is a ladder; anything sent in his name, spending money or irreversible is asked first, with the
  exact thing ([product, rule 3][product-rules]) (owner, 22 Nov 2026).
- Hidden is never unreachable: the conversation is the way to anything ([product, rule 4][product-rules]) (owner, 22 Nov 2026).
- Life's insides never show: no agents, roles, steps, models or prompts; "Life is working on it"
  ([product, rule 8][product-rules]) (owner, 22 Nov 2026).
- An empty screen is a valid screen; never fill it, never say all is well ([product, rule 9][product-rules]) (owner, 22 Nov 2026).
- Every ask gets a reply: heard at once, then an answer, a card or a line saying what Life couldn't do
  ([product, rule 10][product-rules]) (owner, 27 Nov 2026).
- Show something only if he needs it to answer what is asked now, if it changes what he does next, or if he would
  otherwise have to ask for it (owner, 23 Nov 2026).
- Where the approved prototype already draws something, it wins: no variants of it (owner, 26 Nov 2026).

### The screen

- Always there: the edge, the field at the bottom, the count (left) and the pendant (right); no tab bar, drawer or
  other screen (owner, 23 Nov 2026).
- The opening screen, at launch or back after 5 minutes: "Hi" and his first name, what is broken (never capped), at
  most 3 blocking asks and a pill for the rest ([product, rule 7][product-rules]) (owner, 26 Nov 2026).
- What is broken and needs him comes first: the thread opens on Life's line and the one button that fixes it
  (owner, 23 Nov 2026).
- Nothing opens another screen but a profile (over the thread, one level deep), a picture or a phrase to show, and the
  system's own viewer for a real document (owner, 23 Nov 2026).
- Dark only, for now; light mode on the phone is not built (owner, 26 Nov 2026).

### The edge and the pendant

- The edge is the one exception to the no-borders, motion and colour rules ([brand, the edge][brand-values]) (owner, 23 Nov 2026).
- Idle and You speak: two soft grey lights turning over a faint ring that never goes dark, a crisp ring with a fixed,
  even, faint halo under them so they never cross bare black; every halo thin and close to the edge (owner, 23 Nov 2026).
- Speaking doubles their speed and pools the light by the field, flickering with the voice (owner, 23 Nov 2026).
- Life is working: the blue swell in Life's `ai` colour, stronger and faster, so working never reads as idle
  (owner, 23 Nov 2026).
- State changes glide over about a second; nothing jumps or restarts (owner, 23 Nov 2026).
- An answer landing gives one bright breath of the ring, then rest (owner, 23 Nov 2026).
- The edge goes still while Life can't be reached (owner, 23 Nov 2026).
- The pendant: the lit cream dot, breathing, while it records; a hollow ring when paused; coral only when it needs him,
  never while it simply records (owner, 23 Nov 2026).
- Pausing the pendant is its page's Pause switch, never a turn of the main session (owner, 23 Nov 2026; the page, his
  ruling of 27 Nov 2026).
- The pendant's own screen is a page (owner, 26 Nov 2026, lab pick D).
- The count is a round button showing the number; it becomes a coral mark when Life is out of reach (owner, 26 Nov
  2026, lab pick Settings 2 B).
- The count's tap plays his bubble "What's waiting on me?" and code's answer, at once, never a model turn
  (owner, 23 Nov 2026).
- What reaches him is ranked by the main session from his situation; code keeps the full list so nothing is lost, and
  the ranking runs in the background so the count's tap stays instant (owner, 23 Nov 2026).

### The field

- Typing, or holding to talk; a voice button is always the microphone ([brand, voice][brand-values]) (owner, 23 Nov 2026).
- Dictated words arrive a word at a time, their letters inking in from blurred to sharp; no cursor, no timer, no
  "Writing…" state (owner, 23 Nov 2026).
- The voice levels fill the width between Cancel and the microphone; voice bars show only while someone speaks
  (owner, 23 Nov 2026).
- The live microphone is filled in `fg`, never in the `ai` blue: blue means Life, not him (owner, 23 Nov 2026).
- Suggested asks, always on: the empty field shows Life's three likeliest next asks, one at a time, every 3 seconds,
  inked in like dictation (owner, 23 Nov 2026).
- A suggestion ends with a quiet send, an outlined circle that inks in last; tapping the field types as usual
  (owner, 23 Nov 2026).
- The suggestions follow his latest action: an item he just unfolded, one he just answered, else what his last action
  brought to the bottom (owner, 23 Nov 2026).

### The thread

- One endless conversation, opening at its bottom, with Show earlier and day separators; it grows only with what he
  and Life say (owner, 23 Nov 2026).
- His messages are a quiet tinted bubble (the `tint` fill, cream text); the full cream bubble was too loud
  (owner, 23 Nov 2026).
- What Life says comes in progressively: text word by word, blocks one after another, each from blurred to sharp; his
  own words appear at once; under Reduce Motion everything appears whole (owner, 23 Nov 2026).
- The thread follows Life's reveal in batches: the message is laid out first, then one smooth move when the revealed
  part reaches the bottom, leaving about half the view, never taking the message's top under the top edge
  (owner, 23 Nov 2026).
- Small blocks stay as they are; a page-sized answer shows whole while it is the latest and collapses into its card
  when he next writes, never on its own (owner, 23 Nov 2026).

### Items and asks

- An item is an ask or a matter, shown as a row, folded, or unfolded; copies are one live item, so a choice made in one
  shows in all (owner, 23 Nov 2026).
- An item has one state from the grid (needs you, Later, under way, waiting on someone, settled, queued, outdated,
  held, earlier draft, deleted for both of you, stopped), shown alike wherever it appears (owner, 23 and 26 Nov 2026).
- The grid grows with what really happens; a new state gets its row (its line, tap and Undo) before it is built, and
  nothing shows outside it (owner, 23 and 26 Nov 2026).
- An item changes state where it is; it never moves or vanishes; the count says what is left (owner, 23 Nov 2026).
- The item says how it stands, so no line repeats it; Life's lines are only for what happens between items
  (owner, 23 Nov 2026).
- An item is tappable only while it needs him or is under way; once settled it is history: no tap, no Reopen, its due
  date no longer coral (owner, 23 Nov 2026).
- One shape for every ask: who asks in large (face or mark), the one-line ask as title, the line "what · when", at most
  one line of why, the body of its kind, the answers; the row and the unfolded ask share the header (owner, 23 Nov 2026).
- A title is the one-line ask, what he must do, verb first and short, never a person's name alone (owner, 23 Nov 2026).
- Cards need a short imperative ask line written by the agent that asks (owner, 23 Nov 2026).
- An ask does not show its matter, for now (owner, 26 Nov 2026).
- Bodies by kind: a fix, why and numbered steps; a reply, its chat with the draft; a choice, option cards; a payment,
  the amount large, to whom, the IBAN in mono, the reference, "Open your bank"; a calendar add, when, where, reminder;
  a call, the number to tap and what to say; waiting on someone, one line and their last message, no answers
  (owner, 23 Nov 2026).
- A choice's options are cards: a radio, the name, Life's pick preselected, one line of facts, and for a place a
  "Google Maps ↗" chip that opens the place without picking it (owner, 23 Nov 2026).
- A selected option is only a little lighter than the others, its radio filled (owner, 23 Nov 2026).
- "Life's pick" is blue everywhere, the ask's pick cards included: blue always means Life's guess (owner, 26 Nov 2026).
- A closing check opens with the matter's name, then why Life thinks it is done, then the question (owner, 26 Nov 2026).
- Your move and the payment ask follow the original prototype (owner, 26 Nov 2026, lab).
- Long work handed on shows as under way with its estimate, a still ring, never a spinner (owner, 26 Nov 2026, lab
  pick "on it, with an estimate" A).
- A late reply lands at the bottom when he is free, led by a line that links back (owner, 26 Nov 2026, lab pick A).
- No "more details" button and no full view of everything: the rest stays behind the field (owner, 23 Nov 2026).
- Asks are built from a few typed parts; anything they don't fit renders through a plain fallback, recorded as a miss,
  and his real inbox run through the prototype is the test set (owner, 23 Nov 2026).

### Rows and unfolding

- No cards: rows are bare (face, title, line, no background), and no box wraps a list (owner, 23 Nov 2026).
- A row's line is what it is, then when it is due ("240 € for the leak · Fri"); coral only for today or tonight; no
  date, none shown (owner, 23 and 26 Nov 2026).
- A list of asks is always one vertical list of rows (owner, 26 Nov 2026).
- Several items in an answer come as rows; a single item arrives unfolded, in place, under Life's sentence of where it
  stands, with no page of its own (owner, 24 Nov 2026).
- A tap unfolds an item where it is; several can be open at once; each folds by its ⌃ or when answered; typing,
  speaking or Life's next message leave them open (owner, 23 and 26 Nov 2026).
- Unfolded, an item takes room above and below, its header grows, and a very faint wash sits behind it, with no edge
  (owner, 23 Nov 2026).
- Answer buttons live only on unfolded items and on an ask Life brings to the bottom (owner, 23 Nov 2026).
- A row offers only Later, and only for a task done outside Life (pay, call), on the newest list; a decision has no
  Later on its row (owner, 23 Nov 2026).
- Answered away from the bottom, an item folds in its new state and Life's line at the bottom says so ("You answered
  **Pay Tomas 240 €**"), the name a link that scrolls back and lights it once (owner, 23 Nov 2026).
- An ask Life brought to the bottom that he skips loses its buttons, and one quiet line closes it: "Left for now, still
  waiting on you" (owner, 23 Nov 2026).

### Drafts

- A draft is branded per app: the app's own logo, the chat's name and size ("Halden house · 5"), "Open WhatsApp ↗" in
  the app's colour; no app name (owner, 23 Nov 2026).
- A quoted message looks like its app everywhere: its mark, its colour, its link (owner, 26 Nov 2026).
- At most the last 5 cited messages plus the one replied to; older ones are "Earlier in WhatsApp"; unrelated ones in
  between are one quiet count, not tappable (owner, 23 Nov 2026).
- Tapping any message opens the real chat (owner, 23 Nov 2026).
- The chat is one global component, used wherever a chat shows: only the messages that matter to the ask, the rest
  one quiet count ("3 unrelated messages"); never an endless scroll; it scrolls, and opens at the bottom on the latest;
  it looks like its app (that app's look, adapted to Life's), and draws every capability of the app's capability grid
  (reply, mention, reaction, file) (owner, 28 Nov 2026).
- A draft card's head: the person's or group's picture (initials when none) and name, the app's name, and an arrow that
  opens that chat (owner, 28 Nov 2026; replaces "no app name").
- His messages take the app's colour mixed into black; the draft takes the app's own sent-bubble colour (WhatsApp's
  green), with a 1.5 px dashed outline that fades once sent (owner, 28 Nov 2026) ([brand, no borders][brand-values]) (owner, 21 and 23 Nov 2026).
- Quick edits (shorter, warmer, other words) change a draft before it goes and need no Undo (owner, 23 Nov 2026).
- A held ask (another open ask into the same chat) waits behind the open one and is asked when it settles
  (owner, 26 Nov 2026).

### Taps and feedback

- Every tap shows its result: the button turns to doing ("Sending…", waiting for the real outcome), then done (a tick,
  "Sent", green) for one second, then the item takes its new state (owner, 23 Nov 2026).
- A failure shows on the button itself: "Not sent", tap to try again; or "May have gone", no retry (owner, 23 Nov 2026).
- The failure states ("Not sent", "May have gone", "Already answered") are designed in the lab and picked by him
  before anything draws them (owner, 26 Nov 2026).
- Answered at the same moment elsewhere, the later tap does nothing and reads "Already answered: Sent"
  (owner, 23 Nov 2026).
- Undo is an attempt, never a promise: "Undoing…", then "Undone · Reopen" (Reopen brings the ask back), or one line
  saying why it couldn't (owner, 23 Nov 2026).
- A send has Undo only for the short while Life holds it; after that, never (owner, 26 Nov 2026).
- Under way never spins for ever: Life first tries to fix a stalled task unseen, else the item comes back to needs you
  with one line of why; a few minutes for a draft, a long task's own deadline for the rest (owner, 23 Nov 2026).
- An ask goes out of date when someone wrote in its chat since, he answered there himself, or its agent replaced it;
  the whole row fades to the back, its line the reason; unfolded, it folds (owner, 23 Nov 2026).
- Nothing traps him in a step: every question can be left, and typed or spoken words always answer (owner, 26 Nov 2026).

### Answers to his questions

- Life's words are full Markdown, as in AI chat apps: headings, lists, bold, quotes, code, tables, images, and `life:`
  names that unfold what they name in place (owner, 23 Nov 2026).
- Under the words, only what the answer is about, never a data model's page: items in their states, pictures, a table,
  a phrase to say, a place (owner, 23 Nov 2026).
- A picture, or a phrase to show someone, opens full screen on a tap: the one exception to "nothing opens a screen"
  (owner, 23 Nov 2026).
- Life failing to answer says "I couldn't answer that."; tapping his bubble asks again; never "tell the caretaker"
  (owner, 23 Nov 2026).
- Answer his question directly, as an assistant would, then go on: "What's on today" shows the day's list at once (no
  reveal step by step), then "You also have 3 decisions to make" and lists them (owner, 28 Nov 2026).
- "Did Jade answer?": "Yes, Jade answered at 9:12. Here's what she said.", then the chat, then the ready draft with its
  options (owner, 28 Nov 2026).
- "Tell Ben…" needs no lead line: straight to the draft card (owner, 28 Nov 2026).
- A card that arrives says first why, in one line: "Sam just texted that Café Dalon is closed today. Here's your
  draft." (owner, 28 Nov 2026).
- A day's events are a vertical list; a sideways row stops working past three (owner, 28 Nov 2026).
- One standard format for a day ("What's on today", "How's my day"), the same in every answer and follow-up
  (owner, 28 Nov 2026).
- The act first, its figure second: "Pay the electricity bill", then 84 € (owner, 28 Nov 2026).
- A block proposed for an answer must read on its own: no row he can't place (a bare "Maps", a lone event title, a
  floating face) (owner, 28 Nov 2026).

### While Life works

- One line under his words says what Life is doing now, until its answer starts; one line, never a list
  (owner, 24 Nov 2026).
- A step is a verb and what it acts on ("Reading your chat with Nora"): the verb quiet, the object bright, a person with
  their face; never a tool's, an agent's or a ref's name (owner, 24 Nov 2026).
- Each new step takes the last one's place: the old blurs away upward, the new inks in (owner, 24 Nov 2026).
- A step that reads or acts turns a spinner; thinking has its own mark (three dots circling) and a shimmering
  "Thinking…"; a retry says "Taking a little longer…" (owner, 24 Nov 2026).
- When the answer starts, the line blurs away and the words ink in where it was (owner, 24 Nov 2026).

### Life's questions

- Life answers as it wants, then ends with its question when it needs one; a question is not an item, is not counted
  and never notifies (owner, 23 Nov 2026).
- Each kind of question gets its own control (owner, 23 Nov 2026, design E of the questions page).
- Which one or an offer: two equal pills under the question, the likelier inverted (cream, black text) and on the
  right; a yes before an act the same, the act's answer on the right (owner, 24 Nov 2026).
- An option with consequences: option cards with one line of facts and Life's pick in blue (owner, 23 Nov 2026).
- A value: a row of equal round pills with gaps, never a merged segmented control (owner, 23 Nov 2026).
- A person: their faces side by side; his own words: the field starts his sentence with Life's suggestion and the
  microphone calls softly (owner, 23 Nov 2026).
- Doing something else leaves the question, with no closing line (owner, 23 Nov 2026).
- An answer can start real work: it carries a small lit mark, and the work shows under his bubble as an item in its
  state; work that would send in his name becomes an ask with its draft, the yes on the exact words (owner, 23 Nov 2026).

### Profiles

- A face is a person's or organization's; a tap opens their profile over the thread: the face rises to the top, the
  thread blurs and darkens, the page eases in under it (owner, 23 and 24 Nov 2026).
- Its sections: who they are to him, ways to reach them (round app buttons, no words), what needs him, where things
  stand, what waits on them, what is coming up, the last time, what they are like (in Life's blue) (owner, 23 and 24 Nov 2026).
- A glass back button, or a drag in any direction, lets it go and the face flies back (owner, 23 and 24 Nov 2026).
- A profile is one level deep, never a stack: tapping an item on it closes the profile and asks it in the thread, his
  bubble in his own words, then Life's answer (owner, 23 and 24 Nov 2026).
- An organization shows its own picture when Life has one, else its initials, never a generic mark; its face is a full
  circle everywhere (owner, 26 Nov 2026).
- The matter page and the profile use the generated overviews (owner, 26 Nov 2026, lab).

### Arrivals and notifications

- A follow-up card lands at the bottom with Life's lead, at once if he is free, else once he stops typing, speaking or
  reading; it never pushes away an open ask (owner, 23 Nov 2026).
- If he has scrolled up, nothing jumps: a small down pill shows (owner, 23 Nov 2026).
- In the app, no banner (owner, 23 Nov 2026).
- A notification is the ask: its one-line title, who and when, the draft, at most two answers (the main one and Later,
  in the card's words) (owner, 23 Nov 2026).
- Silence when it worked; only a failure notifies (owner, 23 Nov 2026).
- Answered on a notification, the ask lands in the thread as its item in its state, then his answer as his bubble in
  the card's words with the bell and the time (owner, 23 Nov 2026).
- Opened without answering, Life brings the ask to the bottom with its answers (owner, 23 Nov 2026).
- "Hey Life": one notification that it was heard, replaced by the answer; not read aloud; no live listening; the
  pendant only ([hey Life page][heylife]) (owner, 27 Nov 2026).

### Failures and offline

- Offline, everything still works and is queued (his words with a small clock, his answers, his sends); back online,
  each goes only if nothing changed, and a dropped one says so; nothing is greyed (owner, 23 Nov 2026).
- A failure that needs him is an ask of kind "fix": its face what broke, its title the one-line fix, its line what it
  costs and since when, its body the steps for where he is (owner, 23 Nov 2026).
- Away from home, a fix's main answer is "Remind me when I'm home"; it offers only a step Life can really do
  (owner, 23 Nov 2026).
- Life's code writes fix asks from a fixed list of failures it knows how to fix; the caretaker takes only what is not
  on the list (owner, 25 Nov 2026).
- What he can do nothing about is a notice: an ask's header only (mark, what is wrong, what it means and since when),
  no body, no answers, no tap, not counted; one per problem, settling like an item ("Back online · 2 sent")
  (owner, 23 Nov 2026).

### Words

- Wording follows [brand.md, wording][brand-wording]: the question first and ending in "?", nothing said twice, no
  system words, no number he can't act on (owner, 19 and 26 Nov 2026).
- A mark or a number on a control, never a word, wherever a mark can say it; words go to VoiceOver
  ([brand, minimal][brand-values]) (owner, 23 Nov 2026).
- "Later" is the one quiet word, on a solid `tint` pill with no border; a clock confused (owner, 23 Nov 2026).
- Words only on an ask's and a question's answers, a confirm's two choices and a draft's quick-edit chips; three words
  at most (owner, 26 Nov 2026).
- Every fact once on a card: no name, title, line or icon said twice (owner, 26 Nov 2026).
- No numbers he doesn't need: no counts, durations, confidence or "1 of N" (owner, 26 Nov 2026).
- Life may say "I" in its sentences; a button never does (owner, 26 Nov 2026).
- No agent names or roles anywhere he looks (owner, 22 Nov 2026).

### Buttons and colour

- The recommended answer is the only cream fill, full width, saying what it does ("Send to Nora"); the others are equal
  quiet pills under it: Later (or the card's "Not now"), an alternative, Drop it; never bare text (owner, 23 Nov 2026).
- Side by side, Later comes first and the recommended answer is on the right, where the thumb is (owner, 26 Nov 2026).
- Cream also marks a chosen value (an on switch, a selected pill), the live microphone and Send, and "Delete for both"
  in the Undo confirm (owner, 26 Nov 2026).
- Colour means something: `flag` needs him, `ai` Life's guess, `ok` it worked; exceptions are an app's colours on its
  drafts, faces' hues and the aura ([brand, values][brand-values]) (owner, 26 Nov 2026).
- No hairlines anywhere: settings and tables separate rows by spacing only (owner, 26 Nov 2026).
- Emoji are monotone; reactions are the rating's 👎 👍 🤩, plus 👀 for handed-on work (owner, 26 Nov 2026).

### The look

- Colours only from `tokens.css`: the 13 tokens plus `tint`, `glass`, `wash`; never a literal ([brand][brand-values])
  (owner, 26 Nov 2026).
- Manrope, seven sizes (26, 19, 16, 15, 13.5, 13, 11.5), weights 450, 600, 650; no capitals ([brand][brand-values])
  (owner, 19 and 26 Nov 2026).
- Four radii (pill, 12, 18, 22), spacing 8, 16, 24, 48 ([brand, shape][brand-values]) (owner, 26 Nov 2026).
- No borders, outlines or rings; the draft's dashed outline and the edge are the exceptions ([brand][brand-values])
  (owner, 19 Nov 2026).

### Motion

- Nothing jumps: every state change, new element and layout shift animates ([brand, motion][brand-motion])
  (owner, 19 Nov 2026).
- By itself only the edge, the pendant, the ink-in, the suggested asks and the thinking shimmer move; a long task is a
  still ring that fills at each milestone, never a spinner (owner, 26 Nov 2026).
- Unfolding is not the ink: it measures first, scrolls just enough for the whole item to fit without its header going
  under the top edge, then opens in one 0.4 s reveal; folding reverses it (owner, 23 Nov 2026).
- Answers never sit under the field (owner, 26 Nov 2026).
- Motion is dialled back only after the owner has used it on the phone (owner, 23 Nov 2026).

### Voice

- Voice is read, not drawn: the words show dim and each turns cream as it plays; no waveform, no duration
  (owner, 26 Nov 2026).

### Settings

- An instruction he just gave shows as its switch, so a tap undoes it; "What can I change?" lists only real settings
  (owner, 26 Nov 2026).
- How he wants things: each choice on its person or matter (owner, 26 Nov 2026, lab pick Settings 1 C).
- Something broken first: the count becomes the warning, the fix as a sheet (owner, 26 Nov 2026, lab pick Settings 2 B).
- Direct or smart mode: one setup card in the thread (owner, 26 Nov 2026, lab pick Settings 3 A).

### How a design is done

- Every proposal is tried on a real matter of his, not only a made-up one; real data stays in private places, never
  the repo (owner, 23 Nov 2026).
- A design brief, to a person or an agent, starts from this page: decisions already taken here are never asked again
  or redesigned away (owner, 28 Nov 2026: "I've already taken decisions on this").
- Prototypes are edited in this folder and checked in the designs app; never published as a copy elsewhere; every
  name, place and number in them made up (owner, 25 Nov 2026).
- A new or changed card is first scored, as a screenshot only, by a reviewer with no context (owner, 26 Nov 2026).
- Accessibility follows the design: clipped text is a bug; contrast and text size the prototype provides are not
  blocking: "I just want things to be fast" (owner, 27 Nov 2026).
- Done means ran live on his real Life, then a screenshot compared element by element with the prototype
  (owner, 26 Nov 2026).

### Not doing

- A full screen for an ask, a zoom, a "more details" view (owner, 23 Nov 2026).
- Each tap becoming his bubble with a copy of the item at the bottom: it felt like a chat bot (owner, 23 Nov 2026).
- Reopen buttons on settled items; an outcome said twice (owner, 23 Nov 2026).
- Light mode on the phone, for now, and words on an answer outside the listed ones (owner, 23 and 26 Nov 2026).
- From AI chat apps: many conversations, a sidebar, regenerate, edit a message, copy, a model picker, a trace of the
  work (owner, 23 Nov 2026).

## Open questions

- Turn by turn, before it ships: the arrivals rule first, then live items in history, "You" and "Life" labels against
  marks, centred reading, turns taller than the screen, the mesh beside the edge, the largest text sizes ([proposal][v5]).
- Turn by turn's first slice and the order after it ([proposal][v5]); the rows-or-tiles rule (rows always, tiles only
  for a run of at most 5 one-tap asks of one kind, 8 rows then "N more") ([design system][ds-tiles]).
- Settings: the 9 proposals of 24 Nov ([board][settings]). The lab took 1 C, 2 B and 3 A; still open whether 1 B, 2 C
  and 3 C join them, whether Settings keeps only mode, devices and sending with logs and diagnostics behind one "For
  the developer" row, and Face ID before a Send changed by voice ([prototypes notes][prototypes]).
- How answer shapes are made (fixed blocks, components the agent composes, or generated HTML): the plan's; the
  components of 23 Nov are a proposal, and the lab left them open ([answer components][answers]).
- The icons of the count and the pendant; what Later offers (a fixed "tomorrow morning", or a few choices); haptics.
- An unrelated ask while he is in the app: follow its notification level (quiet: only the count; normal or urgent:
  lands once he is free), and whether Life should notify fewer asks at all.
- Ask row titles (30 characters, two lines clamped), two-line row spacing, the leading mark's order, dropping "Your
  move" ([design system][ds-rows]).
- Voices to name: one row in "N more", one voice at a time, one suggestion first ([design system][ds-voices]).
- His own step's title: the prototype names the action, the server sends the matter's name; a short imperative needs a
  prompt change ([waiting list audit][waiting]).
- Whether an ask's sub line may fall back to the matter it serves, given "no matter on an ask" ([waiting list audit][waiting]).
- Context with deep links: not designed yet (owner, 26 Nov 2026, lab).
- Not yet designed, from the inventory: Stop while Life answers, "what Life did" as a list, standing intentions, what
  he told Life, the budget gauge, a Live Activity ([inventory][inventory]).

## Decisions log

Newest first. The notes merged into this page, at their last commit: [current spec][spec], [design log][log],
[v4 guidelines][guidelines], [prototypes][prototypes], [answer components][answers], [component inventory][inventory],
[lab decisions][lab], [prototype audit][audit], [waiting list audit][waiting], [fresh eyes][fresh-eyes],
[parity][parity], [catalog][catalog], [assembly][assembly], [final][final], [integrate 2][integrate-2],
[layout][layout], [nav][nav].

### 28 Nov 2026

- Turn by turn review ([turn by turn][tbt]): variation A is the base: its idle, typing, hold to talk, Life works, slow
  ask, failed read and the "Hey Life" notification replaced in place are kept as they are; B's answer flow for "Did
  Jade answer?" wins. Earlier turns: a full-screen pager with magnetic snapping, not every turn shown at once. The
  comparison page switches scenes and variations with no full reload; the next variations are per topic (motion, an
  answer's content) rather than whole apps. Chat replies get their own exploration: three variations of the one chat
  component.
- Cards: one main button with the rest as small pills; the middle of a card drawn its own way per kind; shown: what
  happens if he doesn't answer, Life's plan steps, the sources read, next suggestions. One shape for every card or a
  shape per kind is explored in variations on App v4's data, unfolding on a tap.
- The edge glow is off by default in the app, on only by his setting; the designs keep it.

- The turn by turn prototypes play the real flow ([real flow][realflow]): one quiet step line while Life works
  ([product][product-rules]); a question about a message an agent already drafted a reply to brings that card, Send one
  tap away; new answer blocks may be proposed, marked "new block"; Life never speaks aloud.

### 27 Nov 2026

- The pendant's page is built (lab pendant D, "yes build it anyway"): its dot opens the page, one status line and
  Pause as a switch that acts at once; when it lost the phone, only the fix ([product][product-rules]).
- Turn by turn chosen as the app's direction, after "Not now" earlier the same day; app v4 stays the approved design
  until he picks a drawn one ([hand-over][turns], [proposal][v5]).
- "Hey Life": a notification replaced by the answer (Live Activity parked), not read aloud, no live listening, the
  pendant only ([hey Life page][heylife]).
- Every ask gets a reply: "Yes, always reply" ([product][product-rules]).
- Accessibility follows the design; clipped text is a bug ([v4 guidelines][guidelines]).
- He asked to compare rows with the lab's tiles; the verdict (rows) is a proposal ([design system][ds-tiles]).

### 26 Nov 2026

- App v4 is the one approved design; the app is built to it, and done means ran live, compared with it
  ([v4 guidelines][guidelines]).
- His eleven design system answers, all as recommended: tokens plus `tint`, `glass`, `wash`; seven type sizes; four
  radii; the motion exceptions and a still ring; the colour exceptions; monotone emoji; "I" in Life's sentences only;
  words only on answers, confirms and chips; an instruction as its switch; the spec updated in one pass; dark only
  ([design system][ds]).
- "Start from his seat": every fact once, no numbers he doesn't need, the original prototype wins, no matter on an ask,
  the recommended answer on the right, a message looks like its app, voice read not drawn, a closing check's order,
  fresh eyes before he sees a card ([rulebook][rulebook-seat]).
- His answers on the prototype: "tonight" is coral like "today", organizations show their picture or initials in a full
  circle, Life's pick is blue everywhere, no hairlines, failure states picked in the lab, several items open at once
  ([rulebook][rulebook]).
- Confirmed: cream also marks a chosen value, the live microphone, Send and "Delete for both"; nothing traps him in a
  step ([rulebook][rulebook]).
- The lab: "the selections are fine; anything I didn't select, we go with your pick"; among them no matter on an ask,
  your move and payment as the original prototype, on it with an estimate, a late reply, the pendant's page, the
  generated overviews, Settings 1 C, 2 B, 3 A; context deep links later; answer components left open ([lab][lab]).
- The lab's sideways focused list removed: "the sideways list was an exploration"; asks are always a vertical list
  ([waiting list audit][waiting]).
- The opening screen: "Hi" and his first name, what is broken, at most 3 blocking asks, a pill for the rest
  ([product][product-rules]).
- Undo on a send while Life holds it, held asks, earlier drafts, deleted for both and stopped join the states grid
  (from app v4, adopted with answer 10) ([design system][ds]).
- The edge's brand exception and the motion and colour exceptions written into brand.md, closing the spec's open point
  ([brand][brand-values]).

### 25 Nov 2026

- Fix asks are written by Life's code from a fixed list of failures it can fix; the caretaker takes the rest
  ([spec][spec]).
- The prototypes live in the repo, the only source; every name in them made up ([prototypes][prototypes]).

### 24 Nov 2026

- The steps line while Life works: a verb and its object, one line, each step inking in over the last ([spec][spec]).
- A question's two answers are equal pills, the likelier inverted and on the right ([spec][spec]).
- Several items in an answer come as rows ([spec][spec]).
- Profiles open over the thread, one level deep ([spec][spec]).
- Settings: 9 proposals drawn, none decided then ([prototypes][prototypes]).

### 23 Nov 2026

- The design session that set the chat-first app; its decisions in force are in Guidelines ([spec][spec], [log][log]).
- How to work: the main loop first in a clickable prototype; the old kit is not the design system, only its
  foundations; every proposal tried on a real matter ([log][log]).
- The edge, the field, the count and the pendant on every screen; no tab bar, no drawer ([log][log]).
- Minimal is the brand; "Later" is the one word, a clock confused ([log][log]).
- His bubble is a quiet tint, over the full cream bubble and bare text ([log][log]).
- The yardstick of a human assistant in iMessage, written into product.md ([log][log]).
- No "more details" button, no full view of everything, after he caught himself asking for one ([log][log]).
- One page shape for every ask, "who asks, in large" with the wide answer ([log][log]).
- Answers: the main one full width, the others as equal pills, never bare text ([log][log]).
- Drafts branded per app, at most 5 cited messages ([log][log]).
- The item states grid; items change state where they are ([log][log]).
- Suggested asks always on, following his latest action ([log][log]).
- Copies are one live item; several items unfolded at once ([log][log]).
- Unfolding's own motion; the thread follows in batches ([log][log]).
- No cards, choosing "space and scale" over a spine and over focus by dimming ([log][log]).
- Unhappy paths: outdated as one state, under way with a limit, offline queues everything ([log][log]).
- An outdated ask is faded, over struck through, a pointer, a ghost line and a hollow face ([log][log]).
- Failures that need him are fix asks; what he can't act on is a notice with an ask's header ([log][log], [spec][spec]).
- Undo is an attempt, never a promise ([log][log]).
- Notifications: the ask, at most two answers; answered there, his bubble with the bell ([log][log]).
- Arrivals in the app: no banner, a follow-up lands when he is free, a down pill if scrolled up ([log][log]).
- Answers to his questions: full Markdown, items, pictures, a picture or phrase full screen ([spec][spec]).
- Life's questions: each kind its control (design E); an answer can start real work ([spec][spec]).
- A soft cap on spending, asked once before passing it ([product][product]).
- The log folded into one current spec; the two "your turn" ways dropped ([log][log]).

Reversed or superseded on 23 Nov 2026 itself (all in the [log][log]):

- A collapsed matter and each waiting row on a subtle solid card: reversed on 23 Nov: no cards, rows are bare.
- Tapping a preview, row or person opened a page with a zoom: reversed on 23 Nov: no other screen, the zoom went.
- Action buttons only on the latest item of the thread: reversed on 23 Nov: buttons live on unfolded items.
- A matter's page laid out by its state, with Done, Reopen and "1 more after this": reversed on 23 Nov: no page of its
  own, no Reopen on settled items; its rule "show only what is needed, everything reachable by asking" stays.
- What a page adds to the thread ("Asked on <page>"): reversed on 23 Nov with pages.
- The action bar with a quiet Later and the other answers as one quiet line of text: reversed on 23 Nov: equal pills.
- A choice's options as rows: reversed on 23 Nov: option cards.
- A done row leaving the list, Later taking the row out with "tomorrow morning · Undo": reversed on 23 Nov: items never
  move or vanish, Later is a state on the row.
- Suggested follow-ups only while an ask is latest: reversed on 23 Nov: always on.
- The quiet send as a soft cream disc: reversed on 23 Nov: an outlined circle, inking in last.
- The thread stopping with the new block's top in view: reversed on 23 Nov: it follows in batches.
- An ask opened from a list appearing again at the bottom, its row dimmed: reversed on 23 Nov: it unfolds in place.
- A switch to compare with a full screen per ask: reversed on 23 Nov: no full screen to answer an ask.
- Opening as "your turn, then the item" with a debug flag for folding, opening in place parked: reversed on 23 Nov:
  opening in place came back as the default, the two ways were dropped.
- One item open at a time, folded by typing or speaking: reversed on 23 Nov: several at once, left open.
- His answer from a notification followed by Life's outcome line ("Sent to Idris"): reversed on 23 Nov: the states
  grid says how it ended once.
- Three ways compared for how an answered ask says it ended: settled on 23 Nov by the states grid.
- One system message for offline, in a family of system messages: reversed on 23 Nov: fix asks and notices.
- What he can do nothing about as one quiet line: reversed on 23 Nov: a notice with an ask's header.
- The edge's first state named "waiting on you": reversed on 23 Nov: "idle", with a fixed faint halo under the lights.
- Naming voices left for later: still open, proposed on 26 Nov ([design system][ds-voices]).

Reversed later:

- A send has no Undo, and no hold before sending: reversed on 26 Nov: app v4 holds a send briefly and offers Undo
  meanwhile ([design system][ds]).
- The edge waits for its brand exception before it is built: closed on 26 Nov: written into brand.md, built in v4.
- The lab's sideways focused list (pick A): reversed on 26 Nov: "an exploration" ([waiting list audit][waiting]).
- Settings undecided (24 Nov): partly settled on 26 Nov by the lab's 1 C, 2 B, 3 A ([lab][lab]).

### Before 23 Nov 2026

- The rules his design rests on predate the chat-first app and live in [`brand.md`][brand] and [`product.md`][product]:
  the app's look as Life's brand (18 Nov), no capitals, no borders, nothing jumps and removing load first (19 Nov), a
  vivid green for success (20 Nov), the draft's dashed outline (21 Nov), pure black with few cards and "make the
  technology disappear" (22 Nov).

[product]: ../product.md
[product-rules]: ../product.md#the-rules
[brand]: ../brand.md
[brand-values]: ../brand.md#the-values
[brand-wording]: ../brand.md#wording
[brand-motion]: ../brand.md#motion
[rulebook]: 2026-11-23-chat-first/2026-11-26-original-components.md
[rulebook-seat]: 2026-11-23-chat-first/2026-11-26-original-components.md#start-from-his-seat-his-word-26-nov
[ds]: 2026-11-23-chat-first/2026-11-25-app-v4-design-system.md
[ds-rows]: 2026-11-23-chat-first/2026-11-25-app-v4-design-system.md#ask-rows-titles-and-the-leading-mark-proposal-26-nov-2026
[ds-voices]: 2026-11-23-chat-first/2026-11-25-app-v4-design-system.md#voices-to-name-proposal-26-nov-2026
[ds-tiles]: 2026-11-23-chat-first/2026-11-25-app-v4-design-system.md#a-list-of-matters-rows-or-tiles-proposal-27-nov-2026
[v4]: 2026-11-23-chat-first/2026-11-25-app-v4.html
[settings]: 2026-11-23-chat-first/2026-11-25-settings-board.html
[v5]: 2026-11-23-chat-first/2026-11-27-v5-turns-proposal.md
[heylife]: 2026-11-23-chat-first/2026-11-27-hey-life-turns.html
[turns]: ../handoff/2026-11-27-turn-by-turn.md
[realflow]: 2026-11-27-turn-by-turn-v2/2026-11-28-real-flow.md
[tbt]: 2026-11-27-turn-by-turn-v2/index.html
[spec]: https://github.com/eric-edouard/life/blob/a0f45c4002d9c9cce3f381e546960d7e54bbaf2e/docs/design/2026-11-23-chat-first/2026-11-23-current-spec.md
[log]: https://github.com/eric-edouard/life/blob/a0f45c4002d9c9cce3f381e546960d7e54bbaf2e/docs/design/2026-11-23-chat-first/2026-11-23-design-decisions.md
[inventory]: https://github.com/eric-edouard/life/blob/a0f45c4002d9c9cce3f381e546960d7e54bbaf2e/docs/design/2026-11-23-chat-first/2026-11-23-component-inventory.md
[guidelines]: https://github.com/eric-edouard/life/blob/10979cf229a0d8b4495b9b32911e8c93290fa529/docs/design/2026-11-23-chat-first/2026-11-27-v4-guidelines.md
[prototypes]: https://github.com/eric-edouard/life/blob/a32accdc6254fb133285ff86081f825b3f3abea7/docs/design/2026-11-23-chat-first/2026-11-25-prototypes.md
[answers]: https://github.com/eric-edouard/life/blob/10979cf229a0d8b4495b9b32911e8c93290fa529/docs/design/2026-11-23-chat-first/2026-11-23-answer-components.md
[lab]: 2026-11-23-chat-first/2026-11-26-lab-decisions.md
[audit]: https://github.com/eric-edouard/life/blob/10979cf229a0d8b4495b9b32911e8c93290fa529/docs/design/2026-11-23-chat-first/2026-11-26-prototype-audit.md
[waiting]: https://github.com/eric-edouard/life/blob/10979cf229a0d8b4495b9b32911e8c93290fa529/docs/design/2026-11-23-chat-first/2026-11-26-waiting-list-audit.md
[fresh-eyes]: https://github.com/eric-edouard/life/blob/10979cf229a0d8b4495b9b32911e8c93290fa529/docs/design/2026-11-23-chat-first/2026-11-26-fresh-eyes-review.md
[parity]: https://github.com/eric-edouard/life/blob/10979cf229a0d8b4495b9b32911e8c93290fa529/docs/design/2026-11-23-chat-first/2026-11-26-parity-review.md
[catalog]: https://github.com/eric-edouard/life/blob/10979cf229a0d8b4495b9b32911e8c93290fa529/docs/design/2026-11-23-chat-first/2026-11-26-catalog-review.md
[assembly]: https://github.com/eric-edouard/life/blob/10979cf229a0d8b4495b9b32911e8c93290fa529/docs/design/2026-11-23-chat-first/2026-11-26-assembly-review.md
[final]: https://github.com/eric-edouard/life/blob/10979cf229a0d8b4495b9b32911e8c93290fa529/docs/design/2026-11-23-chat-first/2026-11-26-final-review.md
[integrate-2]: https://github.com/eric-edouard/life/blob/10979cf229a0d8b4495b9b32911e8c93290fa529/docs/design/2026-11-23-chat-first/2026-11-26-integrate-2-review.md
[layout]: https://github.com/eric-edouard/life/blob/10979cf229a0d8b4495b9b32911e8c93290fa529/docs/design/2026-11-23-chat-first/2026-11-26-layout-review.md
[nav]: https://github.com/eric-edouard/life/blob/10979cf229a0d8b4495b9b32911e8c93290fa529/docs/design/2026-11-23-chat-first/2026-11-26-nav-review.md
