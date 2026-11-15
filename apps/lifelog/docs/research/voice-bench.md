# The voice bench: which model names the owner's known voices

Run on 10 Nov 2026 with `apps/voice-bench` (how to run it: its `AGENTS.md`). Numbers only: the recordings, the
names and the full report stay in the owner's private notes.

## The question

lifelog names a voice with ECAPA (192 numbers a turn, `apps/identity`). About half of the turns get no name, and many
names are marked unsure. Would a newer speaker-embedding model, or several blended, name more of the voices he knows,
and more surely?

His rule for the winner: the most known voices named right while at most 1 name in 100 is wrong.

## The sample

5,937 turns from his recordings: every turn he answered (3,578 of a person he knows, 26 people; 859 of nobody he
knows) and 1,500 drawn from the rest, for the review. Short turns dominate: of the turns he named, 37% are under 3 seconds and 8% over 15. Most
are French, then Thai and English. Each turn is judged against profiles built without its own conversations, with
the server's own profile and ranking code.

## What it found

**No model meets the rule, and the model is not what stops them.** At 1 wrong name in 100, every model names under
2% of the known voices. So the bench also reports the first guess, with no threshold: is the person a model finds
most alike the right one?

| Model | Turns heard | First guess right | Equal error | Seconds a clip, one core |
|---|---|---|---|---|
| MECT-B2 (AntSpeaker) | all | 75.0% | 33.7% | 1.28 |
| ReDimNet2-B6 | all | 74.0% | 35.4% | 1.70 |
| ReDimNet2-B6, with Chinese data | 1,500 | 73.4% | 32.8% | 1.24 |
| ReDimNet2+ | 1,500 | 69.7% | 36.7% | 1.16 |
| ResNet293 (WeSpeaker) | 1,500 | 69.4% | 36.4% | 1.64 |
| ECAPA, what lifelog runs | all | 68.7% | 38.8% | 0.24 |
| MECT-B2 Causal | 1,500 | 68.5% | 35.6% | 1.78 |
| CAM++ (WeSpeaker) | 1,500 | 67.0% | 38.2% | 0.08 |

Seconds a clip were measured while the Mac was short on memory: read them against each other, not as absolutes.

- **Eight models stop at the same wall.** On 15% of the turns he named (535 of 3,578), the three models that heard
  everything all pick the same other person he knows. Taking a speaker's turns in a recording as one voice, the first
  guess is right 84% to 86% of the time for all three, and turns over 15 seconds reach the same 84% to 86%. Models
  this different do not share mistakes by chance: either some names are wrong (a name given to a speaker goes to every
  turn the recording gave that speaker), or some voices are heard in conditions no profile of them covers yet. The
  review on the bench's page is built to tell which: it offers these voices first.
- **A newer model helps, a little.** MECT-B2 and ReDimNet2-B6 put the right person first 5 to 6 points more often
  than ECAPA, most on short turns (under 3 seconds: 71% against 62%), at 5 to 7 times the compute.
- **Blending adds almost nothing.** MECT-B2 with ReDimNet2-B6: 75.4% first guess right, against 75.0% alone. The
  models agree too much to correct each other.
- **Evidence matters more than the model.** People he named in 10 or more conversations: 80% first guess right
  (MECT-B2); in 1 or 2 conversations: 45%.
- **Thai turns are named best** (about 85% for every model), French worst (66% to 73%): most of the people who
  sound alike to the models speak French.

## What follows

- Changing the model now would buy about 6 points of first guess and no name at his 1% rule. Not worth a migration
  of every stored voice sample yet.
- The next step is his review of the voices where the models agree against the name. Once answered, `bench score`
  shows whether the wall was the names (the numbers jump for every model) or the voices (they stay).
- If it was the names, lifelog's own naming has the same wrong names in its profiles: correcting them there would
  lift ECAPA too.

## After his review (10 Nov 2026)

He answered three rounds of the review (1,280 turns). It was the names: of the turns he had already answered, he
changed 16% (708 turns in 181 voices), most from one person he knows to another.

| Model | First guess right, before | After |
|---|---|---|
| MECT-B2 | 75.0% | 88.5% |
| ReDimNet2-B6 | 74.0% | 87.9% |
| ECAPA, what lifelog runs | 68.7% | 80.6% |

- Taking a speaker's turns in a recording as one voice, at 1 wrong name in 100: MECT-B2 names 52.5% of the known
  voices, ECAPA 10.0%. Turn by turn the rule is still far: MECT-B2 3.3%, ECAPA 0.6%.
- On 1,500 turns only, ReDimNet2+ (12.9%), MECT-B2 Causal (10.9%) and MECT-B2 blended with ReDimNet2-B6 with
  Chinese data (22.1%) lead turn by turn at 1 in 100: full runs would tell.
- His answers now reach lifelog (`bench apply`, `docs/decisions.md`), so its profiles lose the wrong names too.

## Left out

- **w2v-BERT 2.0 MFA** (the largest model on the list he was given): its authors' weights did not download (their
  host did not answer) and WeSpeaker's package does not load on the bench's Python. Only an unofficial copy exists
  elsewhere, and the bench never fakes a model.
- **Full runs for five models.** After a quick look on 1,500 turns, only MECT-B2 was run on everything beside ECAPA
  and ReDimNet2-B6: the others were no better than those, or the same model retrained.
- **The GPU.** On the Mac's GPU these models were slower than on its CPU cores: every new clip length is compiled.

## The switch (11 Nov 2026)

Production moved to MECT-B2 the next day. Every stored sample on block audio was embedded again once (51,900, on
Modal CPUs, with the speech service's own loader; 313 checked against the Mac, cosine 1.0); the 2,100 on audio from
before blocks were dropped, with 447 evidence clips of 15 people. The recognition thresholds were swept on the new
vectors and stayed where they were. The voice eval on his answers, before and after: turns named right 2,231 of
4,100 to 2,210 of 3,567 (54% to 62%), wrong names 162 to 110 (6.8% to 4.7%), left unnamed 1,102 to 706. In the
archive, whole voices carrying a recognized name went from 6,625 to 7,249 (707 gained, 83 lost, 5 changed person).

## After his listening round (12 Nov 2026)

He answered every voice in the naming queue and the rechecks (about 130 answers), and 346 voices of videos and films
were marked as media. The voice eval on his answers, frozen again: 5,010 judged turns (3,567 before); 2,263 named
right, 157 wrong (6.5% of the names given, 4.7% before), 720 left unnamed. His new answers were on voices already
flagged as doubtful, so the rate over everything is lower than on this sample.

- **The thresholds stay.** Replayed on these answers: `matchThreshold` 0.55 or `margin` 0.05 give more wrong names
  than right ones; `margin` 0.15 loses 331 right names for 45 wrong ones; `minSpeakerSeconds` down to 1.5 moves 23
  judged turns (20 right), too few to decide on, since he is never asked about voices that short.
- **A voice is already decided whole** (`match`: the centroid of its turns). The one per-turn rule gives single
  turns to him: of the 107 judged turns it moves, 57 are his and 50 are not, and 113 of the 157 wrong names are
  turns given to him. Five stricter versions were replayed (a lead asked of every such turn, none in a voice named
  as someone else, higher bars): each removes about as many wrong names as it adds turns of his missed or left under
  another name. These are recordings where one speaker label holds him and another person: a splitting problem, not
  a naming one.

### Naming from what is said (measured, not built)

One call per voice to Life's main model, on 117 whole voices he had answered (77 people he knows, 40 he does not),
each shown unnamed with its conversation, the day's other records and the voice's three nearest people (profiles
built without its conversations). About 9,600 input tokens a voice.

| | Known voices named | Right | Strangers given a name (of 40) |
|---|---|---|---|
| The voice alone, likeness 0.6 or more | 68 | 68 | 6 |
| The reading alone | 70 | 65 | 4 |
| Both agree (likeness 0.6 or more) | 60 | 60 | 1 |

- Where the reading and a strong voice match disagree (3 voices), the voice was right each time.
- Of the 9 known voices with no strong voice match, the reading named 7, 5 right.
- The reading called 29 of the 40 strangers "not relevant" and 1 of the 77 known voices.
- So on voices long enough to match, the reading adds little to the names and mostly removes wrong ones (strangers
  named 6 to 1, at the price of 8 right names); its use is on voices too short to match and to spare him questions.
  The same voices on the ECAPA vectors: agreement at 0.6 named 59, all right.
- It belongs in Life's per-exchange read (a model-owned reading, never written to lifelog), where the conversation
  is already being read: agreement is used at once, the reading alone is a suggestion for his naming, never a name.
