# Life's memory: the spec

Third draft, 10 Nov 2026. Two independent reviews the same day: the first draft scored 38 out of 100 as ready for
a pilot, the second 57. This draft answers both (section 20 says how). There is no third review: his rule is one
confirming review, then stop. Written by the designer; he left
the shape to the designer and can overrule any line. The names are section 18's and need his yes. Nothing here is
built or run before the pilot, and the pilot waits for his credits.

Read first: [what he wants, and where Life stands](./assets/00-what-he-wants.md).

## 1. The problem

The raw data grows for ever; an agent's context does not. With unlimited context an agent would read all the raw
and answer anything. The memory stands in for that: for any question on the grid (what happened, where it stands,
what keeps repeating, what comes next; about him, a person, a part of his life) an agent reaches a small piece that
is enough to answer about as well as reading all the raw.

- **Read side**: the right piece in a few steps, each small enough to read whole.
- **Write side**: a night costs what its day holds. No read's input grows with the years.
- **Rebuild side**: a better model redoes the summaries from the evidence. It reads the raw again only for the
  readings marked as graded (section 5), at a price known in advance; and, targeted, where an answer failed, where
  context is missing, or where his correction shows the evidence missed something, its cost shown when it is not
  small. Rebuilding from evidence never recovers what the evidence did not capture.

How information flows back to him is not part of the memory. It holds and serves.

Every layer is a hypothesis with a claim, a baseline and a pass mark (section 15). One that fails is dropped.

## 2. The shape

1. **One evidence log.** What is read from the raw is written once, as small dated records close to the words.
2. **Links.** A later record tied to an earlier one: this ends that, repeats it, reopens it, tells the same story.
3. **Counts by code.** Meters, patterns, track records, time against goals.
4. **Histories where needed.** A subject's month, year and story, built only where its evidence is too big to read
   whole, when it is first asked for, then kept.
5. **An overview on top.** An agent reads down: overview, subject, span, evidence, raw quotes.

| Layer | What it is | Written by | When |
|---|---|---|---|
| Raw | Sources, the archive, lifelog. The only truth | the apps | always |
| Units | A stable address for a piece of raw; the exchange is a slice over them | code | as data lands |
| Evidence | Small dated records with a checked quote or a measured number | a model, once per piece and per family; code for measures | once the piece is complete |
| Links | Two records tied, with the reason | a model reading evidence only, never raw | nightly, for new records that can be tied |
| Counted readings | Meters, patterns, track records, time and money, closeness, ties | code | when read |
| Histories | Per subject: month, year, story; where it stands | a model, from the level just below | the night after it is first asked; kept warm for what the overview shows |
| Forecasts | A dated expectation, its check day, its score | code first | nightly |
| Overview | Where things stand across his life | a model, from the situations | when a situation it shows changed |

Order of building, and of dropping if a part fails: evidence, links and counts first; then histories; then
forecasts. Each part works without the ones after it.

## 3. Units and exchanges

- Units keep their shape and day cut.
- An exchange is one sitting of talk, cut by code, never stored twice: a slice over units' messages. It can cross
  midnight and so two units. It belongs to the day, and the month, it starts in.
  - A chat or a mail thread: until 6 hours with no message (measured on his data: section 16). A next-day answer opens a new exchange, marked by code as an answer, read with the lines before it as
    context.
  - A recording: lifelog's conversation, with lifelog's edges. Only assigned and matched turns are a person's own
    evidence.
  - One channel per exchange; the episode joins across channels.
- An exchange is complete when its silence has passed. The day's read (episodes, claims) runs the same night as
  today; the focused reads run once the exchange is complete, so at most a night later, never twice.
- Read by a model: every exchange of a chat where both sides ever wrote, with anyone, at any age. A sitting where
  only one side wrote is read too: an ignored message is evidence. Skipped by code: notifications, newsletters,
  chats where nobody ever answered, big groups where he never speaks, and recordings lifelog heard from a screen, a
  speaker or an announcement, or nearby and not with him. A small group is read even when he is silent,
  if someone who also talks with him one to one speaks in it.
- New from the sources, by code: reactions, which message a reply answers, deletions (who, how many, the text kept).
- People in a record: it keeps the handle or the voice of whoever spoke, as the source names it. Where a model had
  to work someone out (the target of a move in a group, who "elle" is), it keeps the words used and the model's
  guess, marked as a guess, made with the people in his life then given as context. Who a handle or a voice is, is
  worked out when read: merging two people, or naming a voice, relabels the focused reads' records with no re-read,
  since they are kept under the words and the voices, not the names. A voice still unnamed has its moves recorded.
  Today's day and claims reads keep today's rule: a voice named late re-reads its days. That cost is counted.
- His chats with an assistant are not exchanges: his own writing. A passage where he reacts to Life's own reading
  of someone is his word about that reading, never fresh evidence about the person.
- Not read: his coding sessions (work chatter), mail threads he never wrote in, except what Mail marks as
  transactions, as today.

## 4. The evidence log

One append-only log. Each record has a day, the handles or voices in it, and either a quote checked against its
messages or a number code measured. The people in it are worked out when read. The project or matter it belongs to
is a reading, stored as a guess as today and corrected by his word.

| Form | What it holds | Today |
|---|---|---|
| What happened | An episode | episodes |
| What was said | A claim: a to-do, a promise, news, a problem, a choice, a preference, a fact about someone | observations |
| What was done | A move between people in an exchange (section 5) | missing |
| What was told about someone | A mention: who is meant, who tells it, who listens | missing |
| What someone says of themselves | A feeling, an intention, a want, a belief, in their words | partly |
| What code measured | Per exchange: who started, delays, shares, last word, left unanswered, reactions, deletions, call length. Per day: hours, money paid, places | scattered |
| What was covered | Per source and day: was it captured or not | missing |
| His word | What he tells Life (section 8) | corrections, labels, told, ratings |

Rules:
- A new record's id: its unit, its first message, its form, and its rank among the same in that message. The pilot
  measures how many ids survive a second run; summaries cite messages, which never move, not record ids.
- Records stored today keep their ids and stay as read. The changed reads apply from the day they switch on; the
  last months' open promises get their endings from links, with no re-read. His ratings keep what they point at.
- Nothing is deleted. A claim stops holding when a link or his word says so; a move never stops having happened.
- "Lapsed" is not a record: code works it out when read (a promise with no ending past its time), and never over
  days a source was not covered.
- Which reads run at which age: moves, mentions, self-reports, lasting claims and promises with their endings, both
  ways (his and theirs to him), at every age. To-dos and appointments only near now.
- **The hour rule**: an episode owns its hours; commits, Screen Time and voice minutes fill only what no episode
  covers. An app, a site or a repo maps to a project through Life's list; what maps to nothing is shown as
  unassigned.
- **Coverage** is read by every count, every summary and every forecast: a week with no capture is "not seen",
  never "quiet".

## 5. The reads of an exchange

Today's two stay: the day's read (episodes and verdicts) and the claims read, by episode as today.

Beside them, focused reads of an exchange. Each sees the exchange, the people's names and roles, the lines before as
context, and nothing else: never an earlier reading. Each move names who did it and to whom, with the quote.

| Family | Surface (seen in the words) | Graded (a judgement) |
|---|---|---|
| Connection | Good news shared. A question about the other. Thanks, affection said. Support asked, support given. An invitation. A request for reassurance. Ideas or questions explored | A bid and its answer: toward, away, against. How personal a disclosure is. Tone: warm to cold, per side |
| Conflict and steering | A fault raised (the chance for all the rest). An apology and its parts. "Let's move on". A plan or schedule proposed. A decision at stake, and who made it | Contempt. Where blame is placed. The answer to a fault: engages, excuses, denies, counters. Pressing. Appeal to one's own distress. Yielding. Directs, proposes, defers. How strong, 1 to 3 |
| Giving and asking | Asks for, offers, gives, refuses, returns: affection, standing, information, money, goods, a service | |
| Mentions and self-reports | Who is meant, teller, listener. Reported speech, flagged. Feels, intends, wants, believes, in their words | A fact or a judgement; its tone; one thing they did or the whole person; why it is told |

- **Surface or graded.** A surface move is what a better model would read the same. A graded one is what a better
  model reads better: those families are the ones read again under a new model, and their price over the whole
  history is counted at the pilot.
- "Going silent" is not coded: code sees a fault raised or a pressing left unanswered.
- **Three reads, not four.** Connection with giving and asking is one read; mentions and self-reports is one;
  conflict and steering is one. The first two run on every exchange that is read: nearly every real conversation
  holds a question, a thanks or a word about oneself, so routing them would save nothing.
- **Routing, for conflict only.** The connection read, which sees every exchange, also answers one yes or no: is
  there any tension, disagreement or fault raised here? The conflict read runs where it says yes. One exchange in
  twenty gets the conflict read anyway, for ever, to measure what the flag misses, per code, per language and per
  source. The day's read is not the router: it judges a whole day at once and is told to pass over small talk.
- A rate is counted only over exchanges the read actually saw. So two rates are never mixed: how often conflict
  happens is counted over all exchanges, from the flag, corrected by what the one in twenty shows it misses; what
  happens inside a conflict (who presses, who yields, how it ends) is counted over the conflict reads only.
- The unit of a re-read under a better model is a read. The connection and conflict reads hold the graded codes;
  the mentions read is mostly surface.
- **Batching**: short exchanges of one chat go in one call, up to about 8,000 tokens, their edges marked, kept under
  the batch's own text. It bounds the backfill; a live night has little to batch.
- **Compared on the pilot** (section 16): these three reads against one model reading a whole thread and listing
  its moves; a batch against the same exchanges read alone.
- The wording of each code is frozen only after the pilot's sample across people, languages and channels.
- Languages: quotes stay as said. Every check is reported per language; a code that fails in one is exploratory
  there.
- Refused as stored labels: a type, a diagnosis, an attachment style, a verdict on a person.

## 6. Links

Some readings need two records from different exchanges tied together: a promise and its ending, a problem and its
fix, "let's move on" and the reopening, the same complaint coming back, one story told to three listeners.

- A nightly step, reading evidence only: one call per subject and night, for that subject's new records that can be
  tied. Code gives it the subject's open things (promises, waits, plans, problems), the newest forty at most, and its past
  records of the same form closest in meaning, twenty at most. The call says which belong together and why: ends, repeats, reopens, same
  story, same matter.
- What starts it: a new record; and a new day of commits or a payment on a person or project that has open things,
  so a fix nobody announced can still end a problem.
- Whose records: a person's by handle; a project's or a matter's by the stored guess.
- Order: links run per subject in time order, once the reads of a span exist. The backfill may read spans in any
  order and links them after.
- A link is a record: the two records, their messages, the relation, the reason. Naming the messages keeps it
  whole if a re-read shifts an id.
- **Every open thing is offered to the linker again at least once a month**, whatever its age, so an old
  unfinished promise is never left out by the cap alone. The pilot measures two things apart: whether the right
  earlier record reached the call (retrieval), and whether the call judged it right.
- **A wrong link is the dear mistake**: a false ending hides a live promise. So an item closed by a link shows
  what closed it, with the quote; "that's not done" from him removes the link for good; and links are judged on two
  marks, nothing stale left open and nothing live closed (section 15).
- Until links pass those marks, extraction retires facts as today. After, links are the one place a later record
  ends an earlier one, and the window of 14 days goes.

## 7. Subjects, and who acts toward whom

Three kinds of subject: he himself, a person, a part of his life (an area, a project, a goal).

- Everyone has their evidence. No gate decides who gets it.
- A part of his life he never declared (a dispute, a purchase, a trip) is found by a small step that reads episodes only
  and groups those that belong to one running thing. It is kept in Life's list and used at once. The day's read is
  not changed, so no stored day is read again. Two names for one matter are folded by a link or by his word, as two people are.
- Which reads a subject needs: a person, all of them. A part of his life: claims, endings, measures; not the moves
  between people.

He is not one person in the data. So:

- Any counted reading can be cut by counterpart. "He across everyone" weighs each counterpart the same, so it is
  not just him with whoever he talks to most.
- **How he acts with someone and what he thinks of them are two readings, never mixed.** His conduct: what passes
  between them. His view: what he tells others, tells Life and writes for himself.
- **Where he performs** is counted through links: what he complains of about someone to others, tied to the same
  event, with no fault raised to that person.
- His own words about someone are always shown, quoted, with who heard them. A meter of his view needs at least
  two listeners; one story retold counts once.
- What a person tells him about someone is that person's view, never the someone's own words.

## 8. His word, and Life's list

`truth/` goes as a folder he is supposed to write. What it was for stays.

- **His word is what he tells Life**: in a chat with an agent, with "hey Life", in a correction, in an answer.
  What he says to other people is evidence about him, not his word.
- **Life's list** holds the subjects: people, parts of his life, his goals in order, and what code computes with
  (handles, repos, sites, a birthday, a role such as parent or client). Life fills it, uses it at once, and his word
  corrects it. What `truth/` holds today is its seed.
- **The declared side**: his vision, his goals in order, the plan for each, who people are to him. It moves only
  when he tells Life; a remark heard in passing is "heard, not confirmed" and becomes a question.
- **A new Life starts with an interview**: what the person wants out of life, their goals, how they plan to get
  there, then the parts of their life and the people who matter.
- **Questions for him** are worked out by code rules from what is stored: a hole in the list, a contradiction, a
  doubtful claim, a code two models disagree on where it matters. A template words them; no model. An agent talking
  with him about a subject gets its questions. Once a question is shown, what he was shown is frozen and kept with
  his answer, as fact checks are today. His answer is recorded only in a chat where he is present, never from an
  agent's own token.

How each kind of his word survives a rebuild:

| His word | Pinned to | Applied by |
|---|---|---|
| "This is wrong", with his why | The messages it was read from | The read of that exchange is given his words as an input, so a re-read cannot say it again |
| "Not important" | The messages, or the subject | Readers hide it |
| "It's done", "outdated" | The claim's messages | An ending, by his word |
| A line he wrote on a page | The subject | Shown first on the view, in his words |
| Who someone is; two are one | Life's list | Worked out at every read |
| "Read this again" | The exchange | The night's reads |
| How close someone is | The subject | Above the count, always |
| An answer to a question | The frozen text he was shown | Kept; the eval's scores rest on it |
| A rating of a meter | A frozen copy of the meter as shown: rate, count, span, quotes | Kept with the copy |
| "This meter is wrong" | The subject and the meter | Shown beside the meter as his view; he can mark the quotes that are wrong, and the count moves |
| "That's not done", "these are not the same" | The two records' messages | The link is removed and that pair is never tied again |
| "This line of the summary is wrong" | The subject and the span | Given to the next build as an input |
| A label, a told line, a mark | As today | As today |

**Which record counts** is one rule, applied by code before any count or summary: for each exchange and family,
the records of its latest read by the current prompt; then his corrections on top. A corrected record stays hidden
in every later reading where a record of the same form sits on the same messages and its quote or its words match
the one he rejected (the quote check's comparison); only his word lifts it. The prompt being told is a help, never
the guarantee. A "wrong" hides the record at once, as today, and also feeds the next read. It is matched by its messages and by
what the record said: one message can hold several records, and correcting one never hides the others. Each row gets its regression case when
it is built.

This changes rules of `AGENTS.md`; section 17 lists them. They are rewritten with the build, on his yes.

## 9. Counted readings: how a count is made

- **The unit is the exchange**: one vote per code, per actor and target, per exchange. One blow-up is one exchange.
- **The chance** is recorded, never assumed. For an answer: the move it answers (a fault raised, a bid, an ask, a
  decision at stake). For a move that starts something (a bid, a fault raised, a disclosure, an ask): each exchange
  the person took part in, counted apart per channel, so a long recording and a three-line chat are never pooled.
  It is shown as a level (the share) and as a trend (against that pair's usual), with the volume.
- **A meter is one rate of one code**: a share of chances, in one vantage (with him, with others, as he tells it, as
  others tell it). The cursor is that share. A reading of section 10 that lists several codes shows one rate for
  each, side by side, the first listed leading. Tone is counted as the share of exchanges that read warm. Beside it: how many chances, and where it sits among the people of his life who
  have enough. Below the minimum: "too few to say".
- **Never pulled to the middle.** Nothing shown is averaged toward a typical person. "At its strongest" is the
  strongest level reached in at least two exchanges, with a quote; a single case is shown as "once".
- **No composite until it is earned.** A trait made of several rates shows those rates side by side. One cursor for
  the trait is drawn only if the pilot shows the two halves of the evidence give the same answer.
- **A role** comes from Life's list (parent, client, boss); a reading the role explains is labelled so, by code.
- **Lately against before**, and the month it changed, from monthly counts.
- **A pattern** is one of a fixed list of sequences, found by code within an exchange or across links, always with
  how often the second move follows anyway: a fault raised then denied; blames then denies blaming; presses until
  the other yields; "let's move on" then reopens; an apology then the same fault again. The same list is counted for
  him across people (does he yield when pressed with everyone, or with one person), and for what he resolves and
  then does. Anything freer is prose in the story, marked as a reading. The list grows only with a case that shows
  the need.
- A code two model families agree on less than half the time (kappa under 0.5) is exploratory: kept, shown as such,
  feeding no meter.

## 10. The readings

**A persona** (today's word) is the view of what a person is like: the rates below, the patterns, wants and offers,
the track record, how they write, a gist and what works with them. His own is the same, cut by counterpart.

**About a person**

| Reading (poles need his words) | Codes in | Chance | Accepted construct | Seen in text |
|---|---|---|---|---|
| Reserved or expressive | Starts, invitations, length, reactions (code) | Exchanges taken part in | Extraversion: enthusiasm | Well |
| Takes the lead or goes along | Directs, proposes, defers; who made the decision | A decision at stake | Extraversion: assertiveness | Well; role named |
| Distant or warm | Tone; affection, thanks, support given, questions about the other | Exchanges; support asked | Agreeableness: compassion | Well |
| Tactful or blunt when disagreeing | Contempt, strength, engages against counters | A fault raised | Agreeableness: politeness | Fairly; needs disagreements |
| Does what they said or drops it | Promises and their endings (links) | A promise made | Conscientiousness: industriousness | Well |
| Planned or improvised | Plans and schedules made for their own doings, never what they ask of others | A decision at stake | Conscientiousness: orderliness | Fairly; shown only if it differs from the line above |
| Even-tempered or quick to anger | Strength rising inside one exchange | A fault raised | Neuroticism: volatility | Fairly |
| Worries aloud or not | Self-reports of worry | Exchanges | Neuroticism: withdrawal, as what is said | Poorly; labelled as expressed |
| Curious for ideas or practical | Ideas and questions explored | Exchanges | Openness: intellect | Fairly |
| Asks for reassurance or not | Requests for reassurance | Exchanges; after a silence | A behaviour; not an attachment reading | Fairly |
| Shares feelings or keeps them private | Disclosures and their depth; self-reports of feeling | Exchanges | A behaviour; not an attachment reading | Fairly |
| Fair or takes advantage | Returns what is given; keeps promises (links); owns a fault; praise just before an ask | Something given, asked or promised | HEXACO Honesty-Humility, as behaviour: counts and quotes, never a verdict | Fairly |

Conduct lines, his asks by name, as counts with quotes: defensive or engages when faulted; blames or owns a fault;
an apology's parts; whether a mending holds and whether the past is let go (both through links); steers hard or
lets things be (the same code as taking the lead, shown once). Impulsivity: one research note before the pilot.

- **The Big Five profile** is these rates grouped under the five names. One cursor per name is drawn for a person
  once the two halves of that person's own evidence give the same answer (section 9) and he recognizes that person's
  rates: a stable count shows it is repeatable, not that it means the trait. It appears person by person, as their
  evidence grows. The page and the data agents receive always mark the difference: a rate ("kept 9 of 12 dated
  promises") is an observation; a Big Five name over several rates is an interpretation, shown as one. Aesthetic openness is left out. Attachment is kept as its two behaviours (asks for
  reassurance, shares feelings) and never as a style: the research says a style cannot be read from text.
- How accurate: counting coded moves is the route the research calls auditable. No study shows it more accurate
  than rating a trait in one go, and that reaches a stranger's level. The pilot can show stability, his agreement
  and predictions; it cannot show truth about a person.

**Between him and a person**, each direction, his part always

| Reading | Codes in | Chance | Minimum to show |
|---|---|---|---|
| Bids met or ignored | Bid, its answer; left unanswered (code) | A bid | 30 bids |
| Attuned or dismissive | The answer to a disclosure or to good news | A disclosure, good news | 20 |
| Warmth each way, and returned | Tone, per side | Exchanges | 30 |
| Who steers | Directs, proposes, defers; who decided | A decision at stake | 15; role named |
| Who reaches out | Who started (code) | Starts after a silence | 50 starts |
| Who carries the effort | Shares, delays against the pair's usual (code) | Exchanges | 3 months |
| How personal each gets | Depth of disclosures | Exchanges, within one channel | 20 |
| How often it turns tense | The tension flag, corrected by the one-in-twenty sample | All exchanges | A trend only, no threshold; shown only once the flag's misses are measured |
| Who presses and who pulls back | Pressing; left unanswered after it | A fault raised, per topic, against how often it happens anyway | 15 conflicts |
| How it mends | Mending attempt and whether taken; contact resuming with no word said, marked apart | After a conflict | 10 |
| Mixed tone | Warm and tense in the same span | Spans | Family mostly |
| Growing closer or drifting | Trend of contact and of the personal share, over covered days only | Months | 6 months |

**Also counted**: the track record of promises, each way. Wants and offers in four directions, by resource, shown as
asked, given, said. His hours and money per project, area and person against his declared goals (the hour rule).
How he says he feels over time, by person and by activity. His routines. His health lines, which never age out. His view of each person set side by side,
so "the one he is hardest on" has an answer. Ties between other people.

**Closeness** is depth: what is confided each way, support exchanged, the personal against the practical; personal
and work apart; his word above it. It keeps today's four levels, which other steps use. What decides who is in a
model call's context stays counted from code measures only, so a model's reading never feeds itself.

**How each writes** stays: read from their messages, in full where they fit one call, rebuilt rarely. The one read
above the evidence that looks at raw words.

## 11. Histories and situations

- A level exists only where the one below is too big to read whole. A month too big for one call is read in parts,
  as a long day is today.
- A month is read from that month's evidence for the subject, and from nothing else. A year from its months. The
  story from its years, rebuilt when a year closes or a turning point is marked, not at every month.
- His own month is read from the month's episodes, what he says of himself and what code measured. It waits on no
  other subject.
- **Made ahead for whoever has a page today**: he himself, the people with a page, his areas and the projects
  underway. Their history and situation are kept current every night, so a first ask is never worse than today.
- **Everyone else, when first asked**: built the night after, twenty new builds a night at most. Until then a read
  returns the counts and the evidence that matters most, and says a summary is coming.
- **A situation** (today's word, for every subject) is the newest summary plus the evidence since. It is rebuilt
  when new evidence of importance 2 or more lands, at most once a night, and only for subjects kept ahead. His own
  carries the gap between his declared goals and his hours, with what it means, written once, there.
- A part of his life also carries one word, by code: done (ended by his word or by its last open thing); waiting on
  someone (an open wait); moving (evidence in the last 14 covered days); stuck (open things past their time);
  dormant (none for 45 covered days); drifting (falling against its own usual).
- **Old years have no episodes** (section 16), so there matters and his own month are read from the evidence
  itself: the claims, mentions and self-reports of the month, grouped by the same small step that groups episodes
  near now.
- A summary is kept under everything it read: its evidence, the prompt, his word on it. When one of those changes,
  it is rebuilt at the next build and the old version stays in the data repo's history. After an import, each
  touched summary is rebuilt once, from the bottom up.
- Carried up by rule: turning points (from the month where a count changed, an ending, or his word; a model only
  names them), patterns with counts, the facts of his biography, what he corrected, his decisions, what was never
  closed.
- The persona's gist and "what works with them" are written with the story, in the same call.
- A page stays a file, drawn by code from the subject's history and readings each night, so "what changed" still
  has something to compare.

## 12. Forecasts

Code first. A forecast is a rate counted on past cases like this one: the same pair, the same day of the week, as
long since the last contact, the same sort of promise. Its baselines ignore those conditions; that is how it can
beat them. The trigger and the outcomes of each sort are written with its build.

| Sort | Settled by | Must beat |
|---|---|---|
| Who reaches out next, and by when | Who started (code) | The pair's own rate; the same as last time |
| A reply within a window | Delays (code) | The pair's own rate |
| A dated promise kept | Its ending (a link, a payment, a commit) | All promises of that sort; the person's own count |
| A plan followed | The episode that happened | All plans; his own count |
| A project moving or going quiet | Evidence on covered days | The same as last month |
| A pattern recurring | The sequence, counted | How often the second move follows anyway |

- Every forecast is "based on past behaviour": what happened in cases like this before. It never claims what would
  happen if he did nothing. Where he acted (he did the outcome himself first, or told Life he would), the case is
  set aside, not scored. One in ten is never shown, to keep an honest sample.
- A sort settled by a link or by an episode is settled by a model's reading, and says so.
- Void when the days were not covered or the outcome could not be seen (a call nobody recorded).
- Small counts: the forecast may lean on the rate of everyone for that sort, with the person's own count shown
  beside it. This is arithmetic for a forecast, never a meter.
- Three open forecasts per person at most. The track record is shown by sort; per person only as counts.
- The backtest is the same code "as of" a past day, on a sample of past triggers, using only what was known then:
  who a voice or handle was then, his corrections as of then, evidence dated before.
- A model adjusts a sort only after a year of settled cases, or a backtest on a sample, shows a gain.
- Nothing about a third person's health, money or beliefs.
- **The loop**: what happened is new evidence, so counts move. A run of misses about someone flags that subject for
  a rebuild and becomes a question for him. It never writes a turning point by itself.
- Later, each needing his yes because it spends at question time: an agent's free question turned into outcomes;
  testing a message before he sends it.

## 13. The read path

1. **The overview**: his seven areas, each line pointing at a subject. About 1,500 tokens.
2. **A subject**, one part at a time: where it stands, its story, its readings, what is open, what is expected, the
   questions about it. The agent says which part it wants; a person's default is the relationship, never the
   logistics. Each part about 1,500 tokens.
3. **A span** of that subject: a year, a month.
4. **The evidence** for a subject, a form and a span, with quotes, by page.
5. **The raw**: the messages and turns.

- Search covers every level: a broad question lands on a summary, a narrow one on a quote.
- The sizes above are starting numbers; the pilot sets them. Agents read Life about as much as Life reads the raw,
  so a small read matters as much as a cheap write.
- The connector changes in one batch: three reads added (the overview, a span, the evidence); the person and area
  reads gain the "which part" argument and keep their names.

## 14. Scale

His word: no exponential reads; scale reasonably while maximizing information value.

The first draft sent a model about 12 to 23 times the raw text every year, by the reviewer's count (assumptions,
none measured): four focused reads of every exchange, each paying a full prompt for a few lines; situations rebuilt
nightly from their whole tail; stories rebuilt monthly; forecasts sampled by a model.

What bounds it now:

| Where it multiplied | Bound |
|---|---|
| Four reads of every exchange | Three reads; two on every exchange read, the conflict read only where flagged |
| Links, a call per record | One call per subject and night, twenty candidates at most |
| A full prompt for three lines | Batching short exchanges of one chat |
| Situations nightly, from the whole tail | Only for subjects kept current, only on evidence that matters, once a night |
| Histories for everyone, every month | Kept ahead for those with a page today; others built when first asked, twenty a night at most |
| The story at every month | At a year's end or a turning point |
| His month reading everything | Episodes, his own words, measures |
| Cascades | A changed summary is rebuilt once at the next build, bottom up |
| Naming a voice, merging people | Nothing re-read: people are worked out when read |
| Forecast samples | Code first; a model only where proven |
| Backtests, pilot rounds, checks | On samples, counted in the pilot's budget |

- Honest about what still grows: the story reads all its years; the overview grows with the subjects it shows.
  Both stay small. A family read again under a new model costs the whole history for that family.
- The second review recounted this draft's first version at about 5 to 10 times the raw text a year, on its own
  measures of his data: voice is nine tenths of new text, and one year of it is about nine times all his stored
  chats. The target after these bounds is about five times, and it holds only if the conflict read runs on fewer
  than one exchange in six and links stay one call per subject. Neither that nor today's own cost is measured yet:
  the pilot measures both, on the same month.
- Before any backfill, measured on his data: how many exchanges, how long, the size of a prompt, the share that is
  evidence. Then the cost of each layer over the whole history is shown to him.
- **Information value**: each family must change answers to his questions on the pilot or it is not run over the
  history. The backfill reads in time order, the recent years first.

## 15. How it is judged

Before anything runs, this table is filled with numbers and kept beside the results, failures included.

| Layer | Its claim | Compared with | Passes when | If it fails |
|---|---|---|---|---|
| The focused reads | The moves are really in the words | A second model family; the same exchange read twice | Per code and per language: agreement 0.5 or more with the other family, 0.7 or more with itself, on at least 30 cases | The code is exploratory; a read with half its codes exploratory is dropped |
| The conflict flag | It misses little | The one in twenty read in full | It catches 90 in 100 exchanges holding any conflict code, and 80 in 100 for each code, per language and per source | The conflict read runs everywhere, and is priced |
| Focused reads | They beat one wide read | One model reading the whole thread and listing its moves | On 40 of his own questions, judged blind: wins, ties and losses reported apart, losses never above wins, and a tie counts as a loss unless the focused reads cost less or are found faster | The whole-thread read becomes the read for threads that fit one call (his call) |
| Batching | A batch reads like single exchanges | The same exchanges read alone | Agreement 0.8 or more | No batching; the history is priced without it |
| Ids | A re-read keeps them | The same exchange read twice | 8 ids in 10 kept | Everything cites messages only |
| Links | Endings are found and none invented | 50 open and 50 closed items he checks | At most 2 stale left open; none live closed (which still allows a rate of up to about 6%: the check repeats on every round) | Endings stay with extraction; no track record shown |
| Counts | A rate is stable | The two halves of the evidence | The halves fall in the same band for 8 meters in 10 | Minimums raised until they do |
| Meters | He recognizes the person | His blind rating, three people, once | He marks 7 in 10 right or partly, with right and partly counted apart; never tuned toward | Only the meters he recognized are shown |
| Histories | A summary answers as well as the raw | The raw read whole where it fits; search over units; today's layers | On 30 questions where the raw fits: not worse than the raw 8 times in 10, and better than today's layers 6 times in 10 on relationship, arc and about-him questions | No histories: evidence, counts and search only |
| A first ask | Not worse than today | Today's person read, same people | Not worse 9 times in 10 | More subjects kept ahead |
| Time against goals | The hours are true | One week he checks | Within a fifth of his own count for 4 of his 5 main projects; under a third unassigned | The gap is not written |
| Coverage | Gaps are known | The outages on record | Every one shows as "not seen" | No trend shown for years it cannot vouch for |
| The overview | It says where things stand | His own reading of it | He marks at most 2 lines wrong | Reworked before any reader uses it |
| Closeness | Depth ranks as he would | His word on ten people | 8 pairs in 10 in his order | Today's levels stay |
| His word | It survives a re-read | 20 exchanges he corrected, read again | None of the 20 comes back | Blocks the build |
| The practical answers | Not worse than today | Every regression case | All pass | Blocks the build |
| Forecasts | A sort beats its baseline | The baselines of section 12 | A better score on 50 settled cases | The sort is not shown |

These numbers are the designer's starting marks, written before any run; he can move any of them, before the run.
**"Not proven" is a result.** A code, a meter or a language with fewer than 15 positive cases, besides its
chances, is reported as not proven, never as passing. A minimum is set before a run and never raised during it
to make a check pass; dropping a person or a meter from a check is reported as such.
Every comparison reports, beside its mark: unsupported claims, important omissions, and its cost in tokens and
time. A layer that only ties a simpler one earns its place by a clear cost or retrieval advantage, or not at all.
The first gate is better answers on his questions; meters, cursors and forecasts follow only on what passes it.

- **Who grades.** A judge model, first measured on cases he settled. For facts those cases exist. For relationship
  and arc answers none do: the judge is measured on ten answers he gives a verdict on, in conversation (his call).
  The model that checks never comes from the family that wrote; which families the pilot uses is his choice.
- Scores on his own 102 questions are reported apart from the 293 a model mined, since a model wrote those answers.
- **Held out**: honestly weak. The design has seen all 102 of his own questions. What is held out is a share of the
  mined ones, whose answers a model wrote, checked against their quotes; and every question he asks from now on.
- **Checked against the world**, not a model: a reply within a day, who started, a payment or a commit after a
  promise.
- **What no check here can see**: one code read wrongly by both model families, in one language, across years. The
  doubtful codes he answers in conversation are the only light on it.

## 16. The pilot

After this spec and its second review, once his credits are back; never before.

1. **Two people in full**, at every age: his father and a close friend. And a third the design never looked at.
2. **One project and one goal in full**: the second row of his grid, and time against goals.
3. **One recent month of everything**, recordings included, read by the day's read and by all three focused reads
   in full: his own month, the overview, the hour rule, coverage, and what the conflict flag misses.
4. **A sample of about 300 exchanges** from other people, languages, channels, groups and work ties, read by the
   focused reads only, before any wording is frozen.

- It runs the comparisons of section 15, measures the numbers of section 14, and prices the backfill. Every run
  logs tokens and time per step, and how long a first answer takes.
- Forecasts in the pilot: only the sorts code settles, pooled.
- **It does not prove**: his whole history; the year and story levels of his own life; a cursor per trait;
  forecasts about one person; anything in a language the sample lacks.
- Each change of a read's wording re-reads the pilot's set: three rounds at most, counted in its budget.
- **Its written part, sized on his data** (10 Nov, real batches, one-to-one chats and mail, all years): his father
  at most 510,000 tokens in 58 calls per read; the close friend at most 217,000 in 27. One round of three reads over
  both is at most 2.2 million tokens of their words, plus the prompts. At the list prices of the hosts his engine
  routes to, a round is about two dollars at the ceiling, so three rounds are a few dollars. Everyone's one-to-one
  history (102 people) is at most 2.4 million tokens per read. Not yet sized: recordings, group chats, the third
  person. The table is in his data repo, `docs/memory-rework/experiments/2026-11-10-pilot-sizes.md`.
- Then: the build (the path), and the history.

### The history, read once

The other session's imports (WhatsApp since 2011, his Claude and ChatGPT conversations) land as units: the floor
everything stands on. No model layer has read them, and none should yet.

- **Free, at once, on every year**: what code measures (who started, delays, shares, deletions) works on the whole
  history the day it ships, with no model.
- **No model reads the old years before the wording is frozen** on the pilot: not today's day and claims reads
  either, since the pilot may still change what the claims read keeps for old years (lasting claims, no to-dos).
  His rule: old data is read once.
- **Before it starts**: the imports are in; each source's first day is known, so earlier days are "not seen"; the
  unnamed voices are named as far as they will be; the cost is counted on his data and shown to him.
- **The pilot's last round is the first slice** of the history: those reads are kept, not paid again.
- **Units are unchanged** (his question, 10 Nov): nothing in this rework moves a unit's shape, id or day, so the
  imported years stand as they are and are never built again.
- **Old years get no day's read and no episodes.** The night's steps read day by day: over fifteen years that is
  thousands of calls that mostly pay for the prompt, to build the middle layers he said old data skips. Before the
  day the units pipeline started (Sep 2026), every read, the claims read included, runs by exchange batch: about
  3,300 calls for one read of everything written. The claims read keeps only what lasts there. What happened in
  an old month comes from its summary.
- **Order**: by year, the newest first, so stopping anywhere leaves the most useful part done. Links follow per
  subject in time order. Then the histories of those kept ahead.
- **His assistant chats** are read for what he says of himself and of others, by the mentions read and the claims
  read; the passages where he reacts to Life's own readings are set apart as his word about them.
- **Engines**: Codex, his subscription; the old WhatsApp years on OpenRouter's DeepSeek after an estimate he
  approves (his words). The checking model is from another family.
- **The size, measured on his data** (10 Nov, `bun scripts/exchange-sizes.ts`, counts only, every source read):
  - What a read would see, all years: about 16 million characters, some 4.7 million tokens. Chats both sides wrote
    in: 11 million characters (WhatsApp since 2011, iMessage since 2015, and two small networks). Mail threads both
    sides wrote in: 5.4 million.
  - Mail with people (newsletters left out) is 210 million characters, and 98 in 100 of its exchanges are
    one-sided. The rule "only threads he wrote in" is what makes mail small: it keeps 2.5% of the text.
  - Chats: 24,300 exchanges, and 45 in 100 have one side only. So reading the one-sided sittings of a living chat
    matters: it is nearly half of them.
  - Read together by chat and year, in calls of 30,000 characters: about 3,300 calls for one read of everything,
    against 103,000 if each exchange were its own call.
  - The quiet: 89 in 100 gaps between messages are under 6 hours, and beyond that the rate is flat. Six hours, the
    number the persona's counts already use, stands.
  - So the whole written history is a few million tokens: one read of it is hours, not weeks. What grows is
    recordings, about 100,000 tokens a day. The full table is in his data repo,
    `docs/memory-rework/experiments/2026-11-10-exchange-sizes.md`.

## 17. From today to this

| Today | Becomes |
|---|---|
| Units, the archive | Unchanged |
| Episodes, verdicts | Stay; the day's read also routes |
| Observations | Stay as read; endings by links |
| Pages | Still files, drawn by code from the history and the readings |
| Situations (30 days, close people) | For every subject kept current |
| Personas (three years re-read weekly) | A view over the counts and the story; the weekly re-read goes; how each writes stays |
| Closeness by volume | Depth; the four levels kept |
| `truth/` | Life's list and his word |
| Fact checks | The questions for him; what he was shown stays frozen |
| Open items, appointments, search, the connector, the mails | Stay |

- Every feature of ticket 01's checklist stays, among them: his page edits, "what changed" in the nightly and in
  the connector, the frozen fact checks and the eval's scores, "what works with them", the closeness levels.
- New layers are built beside the old, in new files; a reader switches when a layer passed; nothing is wiped.
- Honest count: this is not leaner than today in parts. It removes three prose prompts and the weekly re-read; it
  adds the focused reads, the links, the counts and the forecasts. What keeps it in hand is the order of section 2:
  each part is built, judged and can be dropped alone.
- **The boundary** (the memory as one module that could leave the repo) is a target, not today's code: 22 of the
  memory's files reach into the sources, the payments or the to-do list today. In: units and their words, his
  word, payments, places, Contacts, coverage, who spoke and on what basis, a clock and zone, a model call, the
  embedder. Out: the reads, the questions, the events. It is its own step of the build, the last, and the pilot
  does not need it.
- **Rules of `AGENTS.md` this changes**, each rewritten with the build on his yes: only he writes `truth/`; his
  goals live there only; a new key lands in code first; code rewrites only five named places (histories,
  situations for every subject, the overview, Life's list are added); extraction alone retires an observation
  (links and his word now end things); `doubtful` alone decides what he is asked; closeness is counted from raw
  signals only (kept for what feeds a model, section 10).

## 18. Names (approved by him, 10 Nov 2026)

| Word | What it is | What it is not |
|---|---|---|
| evidence | One small dated record read or measured from the raw | A summary, a meaning |
| move | Something one person did toward another in an exchange, quoted | The `act` command; a trait |
| mention | Talk about someone absent, with teller and listener | That person's own words |
| ending | How a promise, a wait, a plan, a problem or a choice closed | A new claim |
| link | Two records tied: ends, repeats, reopens, same story, same matter | A summary |
| coverage | Whether a source was captured on a day | Silence |
| exchange | One sitting of talk, cut by code | A unit, an episode |
| subject | Who or what a history is about | A topic, a place |
| matter | A part of his life Life named because he never declared it | A project he declared |
| history | A subject's summaries in time: month, year, story | A page (the file drawn from it) |
| situation | Where a subject stands now (today's word, now for every subject) | A page section |
| persona | What a person is like, as a view over the counts (today's word) | A stored verdict |
| meter | One counted rate between two poles, in one vantage | A score, a type |
| vantage | Whose conduct toward whom, or whose telling, a reading rests on | A source |
| pattern | One of a fixed list of sequences, with its count | A trait |
| track record | Promises and plans by how they ended | A meter |
| forecast | A dated expectation that gets settled and scored | Advice |
| overview | Where things stand across his life | A page, a mail |
| his word | What he tells Life | What he says to others |
| map | Life's own list of subjects, written "Life's list" in this spec (today's word, widened to hold what `truth/` held) | Files he writes |
| question | Something Life needs from him, asked in conversation (widens the fact check) | A queue, a task |

In this spec, evidence comes in "forms" and forecasts in "sorts", because "kind" and "type" already mean something.

## 19. His calls

Raised by the two reviews; each is his. **Answered by him on the decision page, 10 Nov 2026**: he left every
assumed yes as it was and pressed done. On the two that needed his word: the pilot's reads run on DeepSeek and Claude
checks (his note); the ten verdicts stay at yes.

| # | The call | Assumed |
|---|---|---|
| 1 | "Every exchange gets the close read" becomes: two focused reads on every exchange read, and the conflict read only where the first says there is tension | Yes |
| 2 | A third person in the pilot, one the design never looked at | Yes |
| 3 | One whole-thread read as the yardstick the focused reads must beat; and if it wins, it becomes the read for threads that fit one call | Yes to the yardstick; his word if it wins |
| 4 | A few doubtful codes asked to him in conversation, where two models disagree and it matters | Yes |
| 5 | A forecast leaning on everyone's rate when a person's count is tiny; never shown as a meter | Yes |
| 6 | Reading moves over the whole history, against his earlier "old archives go straight to the overview" | Yes, once the price is shown |
| 7 | Summaries made ahead every night only for whoever has a page today, him and his areas; everyone else when first asked. He had confirmed "made ahead, every night"; scale asks for a limit | Yes |
| 8 | The Big Five cursor appears person by person, when that person's evidence is stable; until then the rates under each name | Yes |
| 9 | Attachment as two behaviours only, never a style. Today's persona writes about attachment in prose; that goes | Yes |
| 10 | Forecasts start with six sorts code can count. From both personas, his own usual move, longer horizons, a free question, testing a message: later | Yes |
| 11 | Impulsivity: the pilot runs with a conduct line; the research note comes when he wants it | Yes |
| 12 | The pilot uses at least two model families, one to code and another to check and judge: a model and a spend choice | His word: DeepSeek reads, Claude checks |
| 13 | Ten of his own verdicts on relationship answers, in conversation, to measure the judge | Yes |

The names of section 18 and the meters' wording he left as written (same page, same day), except two he set in
conversation: "distant or warm" for the meter of care (he saw that matter-of-fact was no opposite of warm), and
"reserved or expressive" for the first. Still his, later: the rules of `AGENTS.md` at build time;
the history's cost after the pilot.

## 20. What the review changed

Reviewed 10 Nov 2026 by a fresh reviewer with none of the designer's reasoning: 38 out of 100. Its four blocking
flaws and what answers them:

| Flaw | Answer |
|---|---|
| The pilot could not fail: no claim, baseline, grader or pass mark | Section 15 |
| The pilot's two people could not build his history, the overview, a project or forecasts | Section 16: four pieces, and what it does not prove |
| A count had no definition: no table from codes to meters, no unit, no recorded chance, no scale | Sections 9 and 10 |
| Nothing tied a promise to its ending or a complaint to its return | Section 6 |

Its eleven serious flaws are answered in sections 3 (ids, exchanges, unanswered messages, people worked out when
read), 5 (surface or graded), 8 (how each kind of his word survives), 11 (keys, no story as hidden input), 12
(forecasts), 14 (scale), 15 (what replaces the safeguards he declined) and 17 (the rules and features it had not
named, the boundary as a target, the honest count). The full review is in his data repo:
`docs/memory-rework/experiments/2026-11-10-spec-review-1.md`.

**The second review** (a fresh reviewer again, the same day): 57 out of 100. "A pilot would no longer be wasted";
not ready, for five reasons, each answered in this draft:

| Flaw | Answer |
|---|---|
| Most pass marks were still words | Section 15: a number and a consequence in every row, and eight rows added |
| Routing by the day's read was the wrong reader, untestable, and a miss bent the counts | Section 5: three reads, two on everything, only conflict routed, by the read that sees every exchange; a rate counts only what was read |
| A wrong link could hide a live promise, unseen | Section 6: what closed it is shown, his word removes it, two marks |
| "People never written into a record" could not be built | Section 3: the words and the guess are kept; a named voice relabels without a re-read |
| Things he asked for were narrowed without telling him | Section 19: calls 7 to 13 |

Left for the build plan, by the reviewer's own sorting: the batch's exact key; coverage for past years beyond each
source's first day; hours for work done alone, which no episode holds; the exact forecast per sort; the rule from
depth to closeness levels; patterns beyond conflict; wording churn on drawn pages; measuring today's own cost.

Not answered: the impulsivity research note; the test set's answer for "goals month by month", which predates his
decision that goals move only on his word; the hand pilot of 8 and 9 Nov is still not written up in
`experiments/`.

**An outside read** (his ChatGPT, same day), brought by him: for the direction, with five corrections. Taken: the
first gate is better answers, meters follow (section 15, and the "prove first" order of the build path); pass marks
report wins, ties and losses apart, and a tie needs a cost advantage (section 15); conflict frequency and what
happens inside a conflict are counted apart (sections 5 and 10); a targeted raw re-read is allowed (section 1); a
correction matches its claim, not every claim of its messages (section 8); open things are capped per link call and
every run logs tokens and time (sections 6 and 16); forecasts say "based on past behaviour" (section 12). Not taken:
separate busy-night and import experiments beyond the pilot's own runs. A second outside read the same evening
added five precise gaps, all taken as single lines: matters and his month in old years come from evidence
(section 11); which record counts after a re-read, with corrections enforced by code (section 8); old open things
offered to the linker monthly, retrieval measured apart (section 6); "not proven" as a result, minimums fixed
before a run (section 15); observation and interpretation marked apart (section 10). After this, no more reviews
of the spec: the experiments decide.

No third review: his rule is one confirming review, then stop. Both reviews are in his data repo,
`docs/memory-rework/experiments/`.
