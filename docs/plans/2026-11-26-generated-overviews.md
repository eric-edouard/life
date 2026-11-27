# Generated overviews for people, matters and projects

Plan: what the owner sees when a person, a matter or a project is opened, written by a model in the shape that fits the
subject instead of fixed sections. It answers the owner's idea of 26 Nov 2026 ("rather than a fixed format, everybody
would have a different format… an overview that is always Markdown plus rich UI") and the alternative added the same
day (a tap asks the main session "where are we on this?"). Nothing here is built. Paths are under `apps/server/src/`
unless they start with `apps/` or `docs/`.

## The recommendation, first

Do not add an "overview" layer. Life already stores one reading per person and per project that is rebuilt whole only
when its evidence changes: the situation. Let the situation be written as Markdown parts instead of flat lines, add the
same step for matters, and draw the three with the renderer Ask Life's answers already use. The page is that stored
reading, shown at once, with what needs the owner drawn live by code above it and the Ask field under it for anything
fresher. A tap never runs a model.

```
Opening Sam (a friend)            Opening "Kitchen quote" (a matter)
---------------------------       ---------------------------------
[asks about Sam, live, if any]    [asks on it, live, if any]
Friends since 2019, met at…       Getting a quote to redo the kitchen.
Lately closer: two dinners…       - 12 Nov: Ben sent a first quote
You said you'd call monthly.      - 20 Nov: you asked for the tiles apart
[reach rows, live]                Next: Ben's second quote, due Friday.
[ Ask about Sam…           ]      [ Ask about this…                    ]
```

## 1. What exists today

Per person, Life holds six things, all read through `person()` (`memory/read-person-page.ts:212`):

| Layer | What it is | Rebuilt | Where |
|---|---|---|---|
| page | facts, by section | nightly, on new observations | `host/nightly.ts:596`, read at `read-person-page.ts:308` |
| situation | where things stand now, lines citing episodes | when its digest changes | `memory/situations.ts:152`, `:225` |
| persona (add-on) | what they are like, what repeats | weekly | `personal/personas.ts:60`, `:64` |
| history (add-on) | closed months and the story of the years | once per closed month | `personal/histories.ts:46-49` |
| communication style | how each writes to the other | weekly | `memory/communication-styles.ts:30`, `:36` |
| `now` | all of the above as data, within 6,000 characters | at read, no model | `memory/person-now.ts:236`, `memory/read-part.ts:36` |

A situation exists only for someone with an episode in the last 30 days (`isRecent`, `situations.ts:135`); the file of
anyone else is removed (`situations.ts:271`). A friend not seen for three months has none.

Per matter, nothing is written as prose. `matterOf` and `matterBookOf` work out open, status and people when read
(`memory/matter-read.ts:406`, `:771`); the matter direction is a goal and a next step, several matters a call
(`memory/matter-directions.ts:39-45`, `:155`); `readMatterThread` lists the cited messages in time order
(`memory/matter-thread.ts:249`). `read_matter` returns all of it as JSON (`host/http/mcp.ts:369`).

Per project, the project situation: one call from the directory entry and the open matters, lines citing steps, redone
only when the digest of refs changes (`memory/project-situations.ts:116`, `:154`).

On the phone, a profile reads `<ref>/now` (`apps/lifelog/apps/ios/Lifelog/Life/LifeStore.swift:187-191`) and draws four
fixed sections, Open, Details, Now and Writes, then the reach rows (`Lifelog/Profile/ProfileView.swift:27-37`). There is
no matter page and no project page: a `life:` link to a matter opens a sheet with `fetch`'s text as Markdown
(`Lifelog/Thread/AnswerView.swift:122-136`).

## 2. The shape

A situation becomes a list of parts, each a piece of Markdown with the refs it rests on:

```json
{ "parts": [ { "markdown": "Friends since 2019…", "cites": ["ep_…"] } ], "inputs": "…", "built": "…", "madeBy": {…} }
```

The model still returns JSON that zod validates (AGENTS.md, "Only the owner writes `truth/`"). Inside a part the
Markdown may hold headings, bullets, a dated list, a quote, a Markdown table and `life:<ref>` links. The phone already
draws every one of these (`AnswerView.swift:49-73`), so "sometimes a timeline, sometimes not" needs no new component: a
timeline is a dated list the model writes when the order of events is the point.

What every situation must answer, in this order, in plain sentences:

1. What this is (one sentence: who they are to the owner, or what the matter is trying to get done).
2. Where it stands now.
3. What needs the owner, if anything. This part is never written by the model. Code draws the open asks live from
   `checksOnMatterOf` and `noMatterChecksByPartyOf` (`memory/checks.ts`), and the matter's next step from `nextStepNow`
   (`memory/matter-read.ts:747`). When nothing needs the owner, nothing is shown (product.md, rule 9).

What the model is free to choose: whether there is any history, a list or a timeline, a quote, how long (a matter of
two steps is two sentences), and for a friend whether to say anything practical at all. The prompt carries the rules of
"Start from his seat" (`docs/design/2026-11-23-chat-first/2026-11-26-original-components.md`, on `origin/v41-integrate-2`): every
fact once, no numbers the owner does not need, and a sentence wins over a component.

What stays code, drawn live and never written by the model: asks, open matters, reach, details, the birthday. A stored
reading never states a status, so a matter going dormant or an ask being answered never makes the page wrong.

Answer blocks (`records/answer-blocks.ts:16-108`) are allowed by the format and checked by the same code, in a second
step. `pictures`, `table` and `document` fit once a call is shown file refs, which the situation call is not today
(`situations.ts:228-246`). Three kinds are never allowed in a stored reading: `settings`, `phrase`, and `question`
(section 5).

## 3. When it is computed

At night, by the steps that exist, under the rules that already hold.

| Subject | Step | Redone when | One call reads |
|---|---|---|---|
| person | `situations` (`host/nightly.ts:605`) | its digest changes: episodes, page digest, persona text (`situations.ts:152-163`) | the page, 30 days of episodes ending at their newest, the persona's readings |
| project | `projectSituations` (`nightly.ts:580`) | its digest of refs changes (`project-situations.ts:116`) | the entry and its open matters, 30,000 characters at most (`:34`) |
| matter | new, right after the directions (`nightly.ts:575`) | a step, an ending or its direction changes | what the direction call is shown: 12 newest steps, the open steps, the later records, its evidence (`matter-directions.ts:100`, `matter-evidence.ts:108`) |

The matter step reuses the matter records the night already reads once for the two steps before it (`nightly.ts:574`),
keeps a digest of refs and words, never a name, a status or the clock, and takes the newest matters within a night's
size as the directions do (`NIGHT_CHARS`, `matter-directions.ts:41`). A matter of one step gets no call: its step is its
page.

One change to who gets one: everyone with a page keeps their last situation, instead of losing it 30 days after their
last episode. The window already ends at their newest episode, not at today (`situationEpisodesOf`,
`situations.ts:124`), so a person with nothing new has an unchanged digest and costs no call, ever.

What one night reads and costs at 10 years of data. People and projects: the same calls as today, because the inputs do
not change; only the reply's shape does. Matters: one call for each matter that got a new step that day, at most
120,000 characters of input a night, about 25 calls of 5,000 characters. Nothing grows with the years: every input is a
window (30 days, 12 steps, 30,000 characters), and no call is filled to `callCharsOf` (`models/llm.ts:537`). In money
this is a fraction of a night that costs about $0.30 in all today; measure it with `bun life memory source-use` on the
trial below rather than trust this estimate. The one large run is the first fill: about 60 people with a page, the open
matters and 13 projects, some 200 calls, once.

A tap costs nothing and reads one stored file plus the live rows through the connector, the same read the profile makes
today. The phone keeps its last read, so the page shows at once and refreshes under it.

## The alternative: a tap asks the main session

The owner's alternative: opening a matter or a person sends the main session "where are we on this?", and its answer
is the page. Compared on what matters:

| | Stored situation (recommended) | A tap asks the main session | Cached last answer, refreshed on tap |
|---|---|---|---|
| Latency on tap | one connector read, under a second | an agent turn with tool calls: many seconds, up to the 5 minute limit (`desk/main-session.ts:84`) | instant, then the same turn behind it |
| Cost per tap | none | one agent turn, on the owner's agent runtime, every open | one turn per open, or per stale open |
| Cost per night, 10 years | a few bounded calls, flat | none | none |
| Freshness | last night's reading; asks, next step and today's steps live from code | now | last answer, then now |
| Two opens in a row | identical until new evidence | two different texts and layouts | the page changes under the reader |
| The main session | untouched | one session, one turn at a time: a tap waits behind a running ask, and the owner's next real ask waits behind the tap (`main-session.ts:246`) | the same |
| The thread | untouched | every open is a thread entry and a desk turn, and fills the session's context (`main-session.ts:63-66`, `:518`) | the same |
| Mac asleep or offline | the phone's kept read still shows | nothing | the cached answer shows |
| Deleted | the fixed profile sections | the same; situations stay, since search and agents read them (`memory/search.ts:348`, `read-person-page.ts:433`) | nothing, and a second store of summaries with no digest is added |

Two more things weigh against it. The main session is woken only by the owner's words (AGENTS.md, "Life starts and
wakes"), and on a turn of those words it acts with full power, each act proved by finding `said` in them
(`hisWordsIn`, `main-session.ts:124`). A sentence the phone sends on a tap is not the owner's words, yet it would open
such a turn. And browsing would cost money: looking at five people is five agent turns.

The alternative's strength is real: it is always current and it is the code path Claude Code's "where are we" uses.
Life keeps that strength without making it the page. The Ask field is already on every screen and sends what is on
screen as refs (`apps/lifelog/apps/ios/Kit/Sources/LifeConnector/Thread/MainSessionWire.swift:26-31`), so "where are we
exactly?" typed or spoken on a matter's page is one real ask, answered in the thread, at the cost of one turn the owner
chose to spend.

Recommendation: the stored situation is the page; the main session is asked only by the owner. No automatic ask on
open, and no cache of main-session answers. If last night's reading proves too stale in use, the fix is to run the
same step for one subject when new lines for it arrive during the day. That would be a fourth daytime model step
(AGENTS.md lists three) and needs the owner's yes; it is not proposed now.

## 4. What it replaces, and what goes

Built from the existing layers, not beside them. The situation call already reads the page and the persona
(`situations.ts:228-246`); with the `histories` add-on on it is also shown the story, which is shown but stays out of
the digest (AGENTS.md, "A summary is redone only when…"). So a friend's "since that date, a bit of history, lately
closer" comes from the page and the story, and "lately" from the 30 days.

| Thing | Fate |
|---|---|
| `SituationLine` and `ProjectSituationLine` (plain text and cites) | become parts (Markdown and cites); `linesCitingOnly` keeps working over parts (`situations.ts:94`) |
| `isRecent` as a reason to delete a person's situation (`situations.ts:135`, `:271`) | goes |
| The profile's fixed sections Open, Details, Now, Writes (`ProfileView.swift:27-30`) | go; Writes leaves the screen (it is for drafting, still in `now` for agents) |
| persona, history, communication style, page | stay: inputs, and read by agents and drafts |
| matter direction | stays: its goal, next step kind and ending records drive status, the your move card and the hand-out |
| a new "overview" concept, store or reader | never added |

Net: one new stored reading (the matter's), no new concept, one prompt per subject kind. Folding the matter's reading
into the direction call would save the step but would re-draft every direction; it is not worth it.

Stored files change shape without a migration: a situation is rebuilt whole by code and an old-shape file reads as
absent until the night rewrites it (`situations.ts:45-56`). The matter's reading needs its place added to the list of
what code rewrites in AGENTS.md ("Memory is append-only"), a glossary line ("matter situation"), and a key in
`shownKeyOf` (`memory/deletions.ts:156`).

## 5. How the phone draws it, and how answers travel

The renderer exists. `AnswerPart.parts(of:)` splits Markdown from `life:` fences
(`Kit/Sources/LifeConnector/Thread/AnswerBlocks.swift:105`), `MarkdownView` draws the Markdown and `BlockView` the
blocks (`Lifelog/Thread/BlockViews.swift:12`). The work on the phone:

- `ProfileView` draws the parts where its four sections were, with the live ask rows above and reach below.
- The link sheet draws a matter the same way instead of `fetch`'s raw text (`AnswerView.swift:122-136`). A project page
  waits until the app has a way to open one.
- The `items` block draws only asks today (`Lifelog/Items/ItemsBlock.swift:11-13`), though the server lets it name
  matters and observations (`desk/main-session-lines.ts:23`). The pages here do not need it: code draws the asks.

On the server the parts ride the reads that exist: `now.situation` for a person (`person-now.ts:208`), a new
`situation` field on `read_matter`, the `project.situation` of `read_matters`. The block check moves down so the night
can use it: `blockProblemOf` (`desk/main-session-lines.ts:59`) splits into its ref and value check, which goes to
`memory/` over `findRef`, and the settings offer, which stays in the desk. One check, called at write and again at read.

A "what next: A or B?" on a page is always a card that already exists: an agent's decision, or the your move card the
direction's next step produces (`memory/your-move.ts`). It is drawn live as an ask row and answered through
`answer_check`, the one path. The stored reading never holds a `question` block. Such a block sends its answer as the
owner's words to the main session on a tap (`BlockViews.swift:55-58`), and here its text would be written at night by a
model reading recorded messages: content one tap away from acting as the owner. It would also be a second way to ask
beside the inbox. When Life sees a choice with no card, that is the direction's job, and the card follows.

## 6. Risks

- Invented words. A part citing a ref the call was not shown is dropped, as lines are today (`shownLines`,
  `situations.ts:117`); a quote must be found in what the call was shown, with the check the histories use
  (`personal/histories.ts:311`, `memory/quote-check.ts:107`); a `life:` link that opens nothing drops its part
  (`lifeRefsOf`, `memory/refs.ts:118`). Web links are removed: a stored reading links only into Life.
- Deleted words. A person's situation is already hidden until redone after a deletion it was shown
  (`situations.ts:45-56`, `deletions.ts:166`). The matter's and the project's need the same key, and the deletion
  preview must name them (`dependentsOf`).
- A weak layout. The night's model picks the shape, and a bad pick is a confusing page. Prove it first on five people
  and five matters on a copy of the data, read by fresh eyes as screenshots, before any fill.
- Add-ons. Judgments of a relationship stay in prompt parts, so a situation made by another variant is hidden at once
  (`situations.ts:64-80`); the new prompts keep that.
- Re-runs. New prompt versions for the person and the project situation, a new prompt for the matter, and the first
  fill all need the owner's yes (AGENTS.md, "Ask first"). The prompts name the owner, never a pronoun.
- Design. No profile or matter page is in the approved prototype; these pages go through the fresh-eyes review and the
  owner's approval before they are built.

## Decisions for the owner

1. The page is last night's stored reading with live asks, not a main-session answer on every tap. Recommended: yes.
   Asking in the field on that page stays the way to get a fresh answer.
2. Everyone with a page keeps a reading, not only people seen in the last 30 days. Recommended: yes; it costs nothing
   after the first fill.
3. A page never asks by itself: "A or B?" shows only as the card that already exists. Recommended: yes.
4. Run the trial (five people, five matters, on a copy), then allow the new prompt versions and the one fill of about
   200 calls on the ordinary engine. Recommended: yes to the trial now, the fill after the screenshots are approved.
5. The profile loses its fixed sections; "Writes" leaves the screen, details and reach stay as rows. Recommended: yes.
6. Blocks beyond Markdown (photos, a table from a paper) come second, once the first pages read well. Recommended:
   wait.
7. The code keeps the word "situation" for all three; "overview" is not a new name anywhere. Recommended: yes, since it
   is the same thing and a rename would need a migration.

Next: the trial of decision 4, written up beside this file with its screenshots and its `source-use` numbers.

## The owner's answers (26 Nov)

1. The page is the stored reading with live asks, not a main-session answer per tap: yes.
2. to 7. As recommended (his picks followed every recommendation): a reading for everyone with a page, a page never
   asks by itself, the profile loses its fixed sections and "Writes" leaves the screen, richer blocks wait, no rename.
Next: a trial on five people and five matters, on a copy of his data; new prompt versions and the first fill only after
he approves the screenshots.
