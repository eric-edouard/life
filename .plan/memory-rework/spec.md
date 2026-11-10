# Life's memory: the spec

Second draft, 10 Nov 2026. The first draft was reviewed the same day by an independent reviewer and scored 38 out
of 100 as ready for a pilot; this draft answers that review (section 20 says how). Written by the designer; he left
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
  readings marked as graded (section 5), at a price known in advance.

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
  - A chat or a mail thread: until a long silence (several hours; the number is set from his message gaps at the
    pilot). A next-day answer opens a new exchange, marked by code as an answer, read with the lines before it as
    context.
  - A recording: lifelog's conversation, with lifelog's edges. Only assigned and matched turns are a person's own
    evidence.
  - One channel per exchange; the episode joins across channels.
- An exchange is complete when its silence has passed. The day's read (episodes, claims) runs the same night as
  today; the focused reads run once the exchange is complete, so at most a night later, never twice.
- Read by a model: every exchange of a chat where both sides ever wrote, with anyone, at any age. A sitting where
  only one side wrote is read too: an ignored message is evidence. Skipped by code: notifications, newsletters,
  chats where nobody ever answered, big groups where he never speaks. A small group is read even when he is silent,
  if someone who also talks with him one to one speaks in it.
- New from the sources, by code: reactions, which message a reply answers, deletions (who, how many, the text kept).
- People are never written into a record: it keeps the handle or the voice as the source names it, and who that is
  is worked out when read, as units do today. So naming a voice or merging two people re-reads nothing.
- His chats with an assistant are not exchanges: his own writing. A passage where he reacts to Life's own reading
  of someone is his word about that reading, never fresh evidence about the person.
- Not read: his coding sessions (work chatter), mail threads he never wrote in, except what Mail marks as
  transactions, as today.

## 4. The evidence log

One append-only log. Each record has a day, the handles or voices in it, and either a quote checked against its
messages or a number code measured. Its subjects are worked out when read, never stored.

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
- **Routing** (the default, on his word about scale): the day's read, which already judges every unit, flags which
  families an exchange holds. A focused read runs only where flagged. One exchange in twenty is read in full
  anyway, for ever, to measure what routing misses, per family and per language.
- **Batching**: short exchanges of one chat go together in one call, up to a size, with their edges marked.
- **Compared on the pilot** (section 16): four families against two (connection with giving and asking; mentions and
  self-reports inside the claims read), and against one model reading a whole thread and listing its moves.
- The wording of each code is frozen only after the pilot's sample across people, languages and channels.
- Languages: quotes stay as said. Every check is reported per language; a code that fails in one is exploratory
  there.
- Refused as stored labels: a type, a diagnosis, an attachment style, a verdict on a person.

## 6. Links

Some readings need two records from different exchanges tied together: a promise and its ending, a problem and its
fix, "let's move on" and the reopening, the same complaint coming back, one story told to three listeners.

- A nightly step, reading evidence only. For each new record that can be tied, code picks the few open or past
  records of the same subject it could belong with (by form and by meaning), and one small call says which, with
  the reason: ends, repeats, reopens, same story, same matter.
- An ending may cite a commit's subject line or a payment, which are not otherwise read.
- A link is a record: two ids, the relation, the reason. Kept under the new record and its candidates.
- This replaces today's window of 14 days in which a fact can retire another.

## 7. Subjects, and who acts toward whom

Three kinds of subject: he himself, a person, a part of his life (an area, a project, a goal).

- Everyone has their evidence. No gate decides who gets it.
- A part of his life he never declared (a dispute, a purchase, a trip) is named by the day's read, kept in Life's
  list, used at once. Two names for one matter are folded by a link or by his word, as two people are.
- Which reads a subject needs: a person, all of them. A part of his life: claims, endings, measures; not the moves
  between people.

He is not one person in the data. So:

- Any counted reading can be cut by counterpart. "He across everyone" weighs each counterpart the same, so it is
  not just him with whoever he talks to most.
- **How he acts with someone and what he thinks of them are two readings, never mixed.** His conduct: what passes
  between them. His view: what he tells others, tells Life and writes for himself.
- **Where he performs** is counted through links: what he complains of about someone to others, tied to the same
  event, with no fault raised to that person.
- A view told to listeners is shown only when at least two heard it, with who heard it; one story retold counts
  once.
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
| A label, a told line, a mark | As today | As today |

This changes rules of `AGENTS.md`; section 17 lists them. They are rewritten with the build, on his yes.

## 9. Counted readings: how a count is made

- **The unit is the exchange**: one vote per code, per actor and target, per exchange. One blow-up is one exchange.
- **The chance** is recorded, never assumed. For an answer: the move it answers (a fault raised, a bid, an ask, a
  decision at stake). For a move that starts something (a bid, a fault raised, a disclosure, an ask): each exchange
  the person took part in, read against that pair's own usual and shown with the volume.
- **A meter is one rate**: a share of chances, in one vantage (with him, with others, as he tells it, as others tell
  it). The cursor is that share. Beside it: how many chances, and where it sits among the people of his life who
  have enough. Below the minimum: "too few to say".
- **Never pulled to the middle.** Nothing shown is averaged toward a typical person. "At its strongest" is the
  strongest level reached in at least two exchanges, with a quote; a single case is shown as "once".
- **No composite until it is earned.** A trait made of several rates shows those rates side by side. One cursor for
  the trait is drawn only if the pilot shows the two halves of the evidence give the same answer.
- **A role** comes from Life's list (parent, client, boss); a reading the role explains is labelled so, by code.
- **Lately against before**, and the month it changed, from monthly counts.
- **A pattern** is one of a fixed list of sequences, found by code within an exchange or across links, always with
  how often the second move follows anyway: a fault raised then denied; blames then denies blaming; presses until
  the other yields; "let's move on" then reopens; an apology then the same fault again. Anything freer is prose in
  the story, marked as a reading.
- A code two model families agree on less than half the time (kappa under 0.5) is exploratory: kept, shown as such,
  feeding no meter.

## 10. The readings

**A persona** (today's word) is the view of what a person is like: the rates below, the patterns, wants and offers,
the track record, how they write, a gist and what works with them. His own is the same, cut by counterpart.

**About a person**

| Reading (poles need his words) | Codes in | Chance | Accepted construct | Seen in text |
|---|---|---|---|---|
| Outgoing or reserved | Starts, invitations, length, reactions (code) | Exchanges taken part in | Extraversion: enthusiasm | Well |
| Takes the lead or goes along | Directs, proposes, defers; who made the decision | A decision at stake | Extraversion: assertiveness | Well; role named |
| Warm or matter-of-fact | Tone; affection, thanks, support given, questions about the other | Exchanges; support asked | Agreeableness: compassion | Well |
| Tactful or blunt when disagreeing | Contempt, strength, engages against counters | A fault raised | Agreeableness: politeness | Fairly; needs disagreements |
| Does what they said or drops it | Promises and their endings (links) | A promise made | Conscientiousness: industriousness | Well |
| Planned or improvised | Plans and schedules proposed | A decision at stake | Conscientiousness: orderliness | Fairly; shown only if it differs from the line above |
| Even-tempered or quick to anger | Strength rising inside one exchange | A fault raised | Neuroticism: volatility | Fairly |
| Worries aloud or not | Self-reports of worry | Exchanges | Neuroticism: withdrawal, as what is said | Poorly; labelled as expressed |
| Curious for ideas or practical | Ideas and questions explored | Exchanges | Openness: intellect | Fairly |
| Asks for reassurance or not | Requests for reassurance | Exchanges; after a silence | A behaviour; not an attachment reading | Fairly |
| Shares feelings or keeps them private | Disclosures and their depth; self-reports of feeling | Exchanges | A behaviour; not an attachment reading | Fairly |
| Returns what is given or not | Asks, gives, returns, by resource | Something given or asked | A description of the flow; never a verdict in a close tie | Countable |

Conduct lines, his asks by name, as counts with quotes: defensive or engages when faulted; blames or owns a fault;
an apology's parts; whether a mending holds and whether the past is let go (both through links); steers hard or
lets things be (the same code as taking the lead, shown once). Impulsivity: one research note before the pilot.

- **The Big Five profile** is these rates grouped under the five names. One cursor per name is drawn only once the
  pilot shows it stable (section 9). Aesthetic openness and attachment are not readable from his data; they are
  left out rather than guessed.
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
| How often it turns tense | A fault raised; strength | Exchanges | A trend only, no threshold |
| Who presses and who pulls back | Pressing; left unanswered after it | A fault raised, per topic, against how often it happens anyway | 15 conflicts |
| How it mends | Mending attempt and whether taken; contact resuming with no word said, marked apart | After a conflict | 10 |
| Mixed tone | Warm and tense in the same span | Spans | Family mostly |
| Growing closer or drifting | Trend of contact and of the personal share, over covered days only | Months | 6 months |

**Also counted**: the track record of promises, each way. Wants and offers in four directions, by resource, shown as
asked, given, said. His hours and money per project, area and person against his declared goals (the hour rule).
How he says he feels over time, by person and by activity. His routines. His view of each person set side by side,
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
- **Built when wanted**: a history is built the night after it is first asked for, and kept current for the
  subjects the overview shows and those read lately. Until then a read returns the counts and the evidence that
  matters most.
- **A situation** (today's word, for every subject) is the newest summary plus the evidence since. It is rebuilt
  when new evidence of importance 2 or more lands, at most once a night, and only for subjects kept current.
- A part of his life also carries one word, by code: done (ended by his word or by its last open thing); waiting on
  someone (an open wait); moving (evidence in the last 14 covered days); stuck (open things past their time);
  dormant (none for 45 covered days); drifting (falling against its own usual).
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

Code first. Each sort has its trigger, its outcomes, the code that settles it, and the baseline it must beat.

| Sort | Settled by | Must beat |
|---|---|---|
| Who reaches out next, and by when | Who started (code) | The pair's own rate; the same as last time |
| A reply within a window | Delays (code) | The pair's own rate |
| A dated promise kept | Its ending (a link, a payment, a commit) | All promises of that sort; the person's own count |
| A plan followed | The episode that happened | All plans; his own count |
| A project moving or going quiet | Evidence on covered days | The same as last month |
| A pattern recurring | The sequence, counted | How often the second move follows anyway |

- Every forecast is "if he does nothing". One he acted on is set aside, not scored. A share is never shown, to keep
  an honest sample.
- Void when the days were not covered or the outcome could not be seen (a call nobody recorded).
- Small counts: the forecast may lean on the rate of everyone for that sort, with the person's own count shown
  beside it. This is arithmetic for a forecast, never a meter.
- A few open forecasts per person at most. The track record is shown by sort; per person only as counts.
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
| Four reads of every exchange | Routing: a focused read only where the day's read flags it |
| A full prompt for three lines | Batching short exchanges of one chat |
| Situations nightly, from the whole tail | Only for subjects kept current, only on evidence that matters, once a night |
| Histories for everyone, every month | Built when first asked, only where the evidence does not fit one read |
| The story at every month | At a year's end or a turning point |
| His month reading everything | Episodes, his own words, measures |
| Cascades | A changed summary is rebuilt once at the next build, bottom up |
| Naming a voice, merging people | Nothing re-read: people are worked out when read |
| Forecast samples | Code first; a model only where proven |
| Backtests, pilot rounds, checks | On samples, counted in the pilot's budget |

- Honest about what still grows: the story reads all its years; the overview grows with the subjects it shows.
  Both stay small. A family read again under a new model costs the whole history for that family.
- The target, to be measured and not assumed: a year of model input within about four times the raw text, against
  about 1.5 times for today's day and claims reads plus today's weekly re-read of three years per person, which
  goes.
- Before any backfill, measured on his data: how many exchanges, how long, the size of a prompt, the share that is
  evidence. Then the cost of each layer over the whole history is shown to him.
- **Information value**: each family must change answers to his questions on the pilot or it is not run over the
  history. The backfill reads in time order, the recent years first.

## 15. How it is judged

Before anything runs, this table is filled with numbers and kept beside the results, failures included.

| Layer | Its claim | Compared with | Passes when |
|---|---|---|---|
| The focused reads | The moves they find are really in the words | A second model family; the same exchange read twice | Agreement of 0.5 or more per code, per language; else the code is exploratory |
| Routing | It misses nothing that matters | The one in twenty read in full | It finds 95 in 100 of the moves a full read finds, per family |
| Four families | They beat fewer | Two families; one whole-thread read | Better answers on his questions, or they are merged |
| Links | Endings and repeats are found | His marked failures on open loops; what he closed by word | No stale open item in a sample he checks |
| Counts | A rate is stable | The two halves of the evidence | The halves agree; else "too few to say" |
| Meters | He recognizes the person | His blind rating, once per round, never a target | Stated before the round |
| Histories | A summary answers as well as the raw | The raw read whole where it fits one call; search over units; today's pages, situations and personas | Not worse than the raw; better than search and than today on relationship, arc and about-him questions |
| The practical answers | Not worse than today | Today's reads; every regression case | All cases pass |
| Forecasts | A sort beats its baseline | The baselines of section 12 | On settled cases code resolved, with a margin |

- **Who grades.** A judge model, first measured on cases he settled, as today's evals require. The model that
  checks never comes from the family that wrote. Scores on his own 102 questions are reported apart from the 293 a
  model mined, since a model wrote those answers.
- **Held out**: a share of his questions no design step sees.
- **Checked against the world**, not a model: a reply within a day, who started, a payment or a commit after a
  promise.
- **What no check here can see**: one code read wrongly by both model families, in one language, across years. The
  doubtful codes he answers in conversation are the only light on it.

## 16. The pilot

After this spec and its second review, once his credits are back; never before.

1. **Two people in full**, at every age: his father and a close friend. And a third the design never looked at.
2. **One project and one goal in full**: the second row of his grid, and time against goals.
3. **One recent month of everything**: his own month, the overview, the hour rule, coverage.
4. **A sample of about 300 exchanges** from other people, languages, channels, groups and work ties, read by the
   focused reads only, before any wording is frozen.

- It runs the comparisons of section 15, measures the numbers of section 14, and prices the backfill.
- Forecasts in the pilot: only the sorts code settles, pooled.
- **It does not prove**: his whole history; the year and story levels of his own life; a cursor per trait;
  forecasts about one person; anything in a language the sample lacks.
- Each change of a family's wording re-reads the pilot's set: the rounds are counted in its budget.
- Then: the build plan (a golden-rule plan), the build, the backfill.

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

## 18. Names, for his yes

| Word | What it is | What it is not |
|---|---|---|
| evidence | One small dated record read or measured from the raw | A summary, a meaning |
| move | Something one person did toward another in an exchange, quoted | The `act` command; a trait |
| mention | Talk about someone absent, with teller and listener | That person's own words |
| ending | How a promise, a wait, a plan, a problem or a choice closed | A new claim |
| link | Two records tied: ends, repeats, reopens, same story | A summary |
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
| map | Life's list of subjects (today's word, widened to hold what `truth/` held) | Files he writes |
| question | Something Life needs from him, asked in conversation (widens the fact check) | A queue, a task |

In this spec, evidence comes in "forms" and forecasts in "sorts", because "kind" and "type" already mean something.

## 19. His calls

Raised by the review; each is his, none is decided here.

1. **Routing.** "Every exchange gets the close read" becomes "a model reads every exchange at least once, and a
   focused read where it holds something". Section 5 assumes yes.
2. **A third person in the pilot**, one the design never looked at. Section 16 assumes yes.
3. **One whole-thread read as a comparison** on the pilot. He decided focused reads, never one wide read; this is
   only the yardstick they must beat. Section 15 assumes yes.
4. **Doubtful codes asked to him in conversation.** He labels no single exchange; this asks a few, when he likes,
   where two models disagree and it matters. It is the only check that is not a model. Section 8 assumes yes.
5. **A forecast leaning on everyone's rate when a person's count is tiny.** Never shown as a meter. Section 12
   assumes yes.
6. **Reading moves over the whole history**, against his earlier "old archives go straight to the overview". The
   later decision stands; the price is shown after the pilot, before any backfill.

Also his: the names of section 18; the poles of the meters in his words; the rules of `AGENTS.md` at build time;
the model for each read and the backfill's cost after the pilot.

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

Not yet answered: the impulsivity research note; the test set's answer for "goals month by month", which predates
his decision that goals move only on his word.
