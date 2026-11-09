Research for the ticket Who really spoke in a recording (9 Nov 2026).

Method: code and docs of `apps/lifelog` and Life's reader (`apps/server/src/sources/lifelog.ts`, `memory/words.ts`, `memory/units.ts`, `memory/observe.ts`). Counts are aggregates only, read with `sqlite3 -readonly` from Life's small store and from lifelog's archive (`Application Support/Lifelog/archive.sqlite`, table `speaker_assignments`), joined by job and turn. No names, no text. Paths are relative to the repo root. "(unverified)" marks what I did not trace.

## What lifelog knows

**Pipeline** (`apps/lifelog/docs/processing.md`, "Speakers"; code in `apps/lifelog/apps/server/src/`):

1. Diarization: the speech service (`apps/identity/app.py`, Nemotron 3 speaker turns) splits a recording into speaker labels (`speaker_0`...). A label is per recording, not per person.
2. Voice samples: for each clean turn (a speaker, 1.5 s or more, no overlap, no word stretched over 3 s; `uncleanTurn` in `people.ts`, `RECOGNITION.minTurnSeconds`, `maxWordSeconds`) the server cuts audio and asks `apps/identity` for a SpeechBrain ECAPA embedding. Stored in `voice_samples` (embedding, duration, job, turn, label). Unnamed voice data expires after 30 days (`keepDays`).
3. Enrollment: only the owner creates people or adds evidence (`people.ts` header). A profile is one exemplar per conversation of a person's evidence (clips of 3 s or more, `weighProfiles`). Evidence is a sample the owner assigned (or a turn moved to a person by the owner).
4. Matching (`speakers.ts`, `people.ts`):
   - Speaker level (`nameOf`): the speaker's clean turns together, likeness (mean cosine to the person's 2 closest exemplars) of at least `matchThreshold` 0.6 and a `margin` of at least 0.1 over the next person, with at least 8 s of clean speech (`minSpeakerSeconds`). A voice closer to the "Not anyone I know" strangers by `strangerLead` 0.05 gets no name (status `stranger`).
   - Turn level (`decide`): a turn whose own voice is nearest the owner's, at `ownerTurn` 0.6, is his whoever the speaker is; a turn under `shortTurnSeconds` 6 s needs `ownerShortTurn` 0.5 and also a margin of 0.1. If the owner declared a speaker to be several people (`candidates`), each turn is decided among them: margin 0.1 and 0.4 when the set is closed (`closedSetTurn`).
   - Nearby (`nameFromNearby`, `nearbyMatch`, `nearbyPerson`): a voice that matched nothing, or cleared 0.6 but lacked the margin, takes a person named in another recording within 45 min: nearest profile among people named there with a 0.15 lead (`nearbyMargin`), else the person of a voice there at 0.70 alike and 0.1 ahead. References are only the owner's names or matches at 0.65 with margin 0.1 (`nearbyReference`), so a nearby name never names another. Its stored score and margin stay the profile's, below the bar.
5. Owner's manual assignments: `PUT /transcripts/{jobId}/speakers/{label}` (a whole label, or one turn with `turnIndex`) and the "Who's this?" queue write rows with `source: "owner"`. Recognition never overwrites them (`recognizeJob`: `held`). Merge and rename: `merge_people` moves evidence and assignments, a rename only changes the name; both send the affected turns again.

**Where it is stored** (`apps/lifelog/packages/db/src/schema/index.ts`, `speakerAssignments`): one row per job, label and optional turn, with `personId`, `status` (`person`, `unknown`, `candidate`, `media`, `stranger`), `source` (`recognized` or `owner`), `score` (likeness), `margin` (lead over the runner-up), `candidates`, `mixed`. There is no `method` column: the method is `source` plus whether the stored score and margin clear the bar.

- A speaker-level recognized row stores score and margin of the nearest person.
- A turn-level recognized row (`recognizedRows`) stores the score only. The margin it needed to be written is checked in `decide` and dropped.
- A nearby-named speaker has `personId` set and a stored score and margin that miss the bar (that is how `nearbyVoices` keeps them from becoming references). So "recognized, personId set, not (score >= 0.6 and margin >= 0.1)" identifies a nearby name. This holds because a speaker that cleared both would have been matched directly (a stranger gets no `personId`).
- A whole-label owner row stores no score.

**When values change.** The sweep (`people.ts` `sweep`) matches every live transcript again against today's profiles: a minute after any owner answer (`AFTER_CORRECTION_MS`), nightly, and when profiles change. A row is rewritten only when the person, group or status changes (`unchanged` ignores the score), so a stored score can be a little stale while the name is current. A name given or removed later is sent again by the feed: an `assignment` change re-sends the conversation's turns (`feed.ts`, `voicedIn`). The same turn can therefore be named "someone" now and "someone else" tomorrow, and a late owner answer turns a guess into an assigned name.

**What lifelog's own bar is worth.** Config comments (`config.ts`, Nov 3 replay on the owner's answers): at 0.6 and margin 0.1, other people's voices were named 269 right and 15 wrong (about 5% wrong); the 0.65 reference bar had 331 references and 19 wrong (about 6%); nearby naming added 36 right and 2 wrong at 0.15. `bun run eval:voices` replays recognition on a frozen copy of the owner's answers and its counts are committed (`apps/server/fixtures/voice-eval-baseline.json`), so there is already a harness to measure with.

## What the contract exposes and should add

**Today** (`apps/lifelog/apps/server/openapi.json`, `FeedTurn`; `docs/voice-source.md`): each turn in `GET /changes` has `speaker: { personId: uuid|null, personName: string|null, isOwner: boolean, label: string|null, displayName: string }`. No score, margin, source or status. A recording's `speakerIdentities` (the summary model's guesses) is separate and is not recognition. Life's store keeps `person_id`, `person_name`, `is_owner` only, so neither Life nor the contract can tell an assigned name from a guess.

**Add** (one optional block in `speaker`, additive, so the contract stays at version 1 and the phone ignores it; regenerate `openapi.json` with `bun run --cwd apps/lifelog/apps/server openapi`; the phone's wire fixtures need a `WRITE_WIRE=1` rewrite):

```
speaker.basis: {
  method: "assigned" | "matched" | "inferred" | "none",   // non-null
  score:  number | null,                                  // likeness; null for assigned or none
  margin: number | null                                   // lead over the runner-up; null when not stored
}
```

- `assigned`: an owner row on the turn or its label. The owner's word.
- `matched`: recognized and cleared lifelog's own bar (speaker level: score >= 0.6, margin >= 0.1; turn level: the `ownerTurn` or `ownerShortTurn` rule, or a closed candidate set).
- `inferred`: a name taken from a recording nearby, or any recognized name below the bar.
- `none`: no person (unknown, stranger, media).

Why a `method` and not only numbers: lifelog keeps its thresholds (`RECOGNITION`) in one place and Life branches on the answer, so retuning needs no change in Life. The pilot read the raw score and margin from the database; the raw numbers stay in `basis` only to measure and to tune. This follows lifelog's rules: readers use the contract, not tables (`docs/decisions.md`, "Readers use a contract"); the server owns recognition; additive fields only. Cost: one small `speakerOf` extension in `feed.ts` (the row is already read by `speakerOf`), and to fill `margin` for turn-level rows, store it in `recognizedRows` (the column exists; `decide` already computes it; old rows fill in as the sweep rewrites them, which happens only when a row changes, so a one-off rewrite or `null` for old turn rows is needed: I would accept `null`, and let `method` carry the answer).

**Life side.** Add `basis_method`, `basis_score`, `basis_margin` to the local `turns` cache (`sources/lifelog.ts`, created around line 204; a cache rebuilt from the feed, not stored memory). The poll already folds re-sent turns by `(jobId, turnIndex)` and treats "owner late" as news; a change of method on a re-sent turn must count as news too, so the unit is re-read.

## How Life uses speakers

- `sources/lifelog.ts`: keeps `person_id`, `person_name`, `is_owner` per turn; `whose(t)` returns `me`, `other` (any id or name) or `unknown`; `authorOf(t)` gives the id, else the name. A re-sent turn replaces the row; a turn newly marked as his is news.
- `memory/who.ts`: resolves lifelog's id or name through the owner's map; an unknown id falls back to the name lifelog gave.
- `memory/words.ts` `voiceLines`: a named turn becomes a line by that person (via `resolve`), a turn lifelog says is his becomes the owner's line, and an unnamed turn is `unknown:<label>`, prefixed by `heardAs` ("over the phone", "from a screen or speaker", "nearby, not talking with him") from the summary model's `speakers` kinds. `heardAs` is therefore about unnamed voices only; a wrong name gets no prefix.
- `memory/units.ts` `speakerOf` is the chat equivalent (sender or `fromMe`); voices do not go through it. Units keep people unresolved; readers resolve them at read time.
- `memory/observe.ts`: a fact from a voice unit that names anyone besides the owner is capped at `SPOKEN_MAX` 0.6 (below `SURE_AT` 0.7), regardless of how the speaker was identified. The cap treats every recorded claim about others as "maybe"; it does not know whether a quote's author was assigned, matched or guessed. A wrong name is the same weight as a right one, and repeated facts can still add up (unverified: how personas and communication styles weigh several 0.6 facts).
- The gap, in one sentence: Life knows whether lifelog named a turn, never how sure it is.

## The proposed rule

A recorded turn by someone other than the owner has one of three roles, decided only by `basis.method`:

| Role | Method | May be used for |
|---|---|---|
| Their own evidence | `assigned`, or `matched` | Anything attributed to that person: what they said, felt, did to him, their persona, how they write, harsh or warm moves. Keeps the existing 0.6 cap on claims about others. |
| Evidence context only | `inferred` (a nearby name, or below the bar) | What happened in the exchange and what he did or said; the name is shown as a reading ("probably <name>"), the claim is not filed as the person's own word, and it can never raise a person's persona, tone or conflict count. A person's page may list it as "heard near" only. |
| Not at all | `none` (unnamed, stranger, media) | Today's behavior: an unknown speaker; a stranger or media turn gives no person evidence. |

Conditions on the first row, so a pile of weak turns does not pass as strong:
- `matched` counts only if the turn passed the bar on its own numbers: `score >= 0.6` and `margin >= 0.1` (lifelog's `matchThreshold` and `margin`, both read from `basis` so retuning follows). A turn-level `matched` row with `margin: null` counts, since lifelog's `decide` already required the margin to write it.
- An `assigned` turn counts whatever its number, because the owner said so.
- A fact that rests on a single `matched` turn and nothing assigned keeps the 0.6 cap. One that also has an `assigned` turn or two or more separate recordings that passed the bar may rise to the model's own confidence (this part is a proposal for the measurement below, not a measured value).

**The owner's own uncertain short turns.** The pilot's open question: do they disqualify an exchange? My answer: no. Reasons: (1) the rule protects what is attributed to the other person, and that comes from their own turns; (2) lifelog's rule for his short turns (under 6 s, 0.5 with margin) is deliberately looser because short clips score low and his short requests stayed unnamed, and it measured 330 of 358 sampled turns right with a few of someone else's wrongly given to him (16 fewer after the stranger rule); (3) disqualifying every exchange with a short owner turn would remove most exchanges, because he speaks in short turns. Instead:
- His turns count as his words for the exchange's context whatever the method.
- A fact about him (a promise, a stance, a decision) that rests only on a short owner turn with `method: matched` and `score < 0.6` is downgraded one step, since this is where someone else's words could be credited to him; with an `assigned` or `score >= 0.6` turn it is not.
- An exchange disqualifies only when the other person's turns fail, not his.

**What I would measure to set the numbers** (nothing here is invented; it uses lifelog's own thresholds as the starting point):
1. From `eval:voices`' frozen owner answers: wrong-name rate by score bucket (0.5 to 0.55, ..., 0.75+) and margin bucket (0.05 to 0.1, 0.1 to 0.15, ...) for speaker-level and for turn-level; the bar already has about 5% wrong, so ask whether Life should require the 0.65 reference bar for "harsh" claims only.
2. In Life: for each fact about a person's behavior toward him in the last 60 days, the share whose cited turns are all `matched`, `inferred` or `assigned`; then ask the owner (conversation only, no queue) to rule on a few dozen `matched`-only and `inferred` cases to get the real error rate per class.
3. For his short turns: error rate under 6 s by score bucket (0.5 to 0.6 vs 0.6+), using his corrections.
4. The pilot's own number (41 of 42 harsh moves from doubtful recordings) re-run with `method` instead of raw numbers, to confirm the rule would have caught them.

## What it sets aside

Aggregate counts across all turns in Life's local store that lifelog's archive could be joined to (116,487 turns, 1,127 conversations). Joined by job and turn on 9 Nov 2026.

Not the owner (75,158 turns):

| Class | Turns | Share of all non-owner turns |
|---|---|---|
| Unnamed (already `none`) | 35,023 | 46.6% |
| Named, `assigned` by the owner (label 10,231, one turn 52) | 10,283 | 13.7% |
| Named, `matched` at the speaker level (score >= 0.6, margin >= 0.1) | 27,386 | 36.4% |
| Named, turn-level recognized row (margin not stored) | 80 | 0.1% |
| Named, `inferred` (recognized, below the bar: nearby) | 2,386 | 3.2% |

So of the 40,135 named non-owner turns: 25.6% assigned, 68.2% matched at the bar, 0.2% turn-level matched, 5.9% inferred. The rule sets the inferred ones aside as evidence (2,386 turns, 5.9% of named, 3.2% of all non-owner turns), on top of the unnamed that Life already does not file as anyone. Every named turn passing the bar still carries lifelog's own error rate of about 5% (see "What lifelog knows"); the rule does not remove those, only measurement and the `assigned` path can.

The owner's turns (41,329):

| Class | Turns |
|---|---|
| Owner row (label 2,325, turn 43) | 2,368 |
| Recognized as his at the speaker level, bar passed | 29,240 |
| Recognized as his at the speaker level, below the bar | 4,577 |
| Moved to him at the turn level | 5,144, of which 3,431 scored under 0.6 (the short-turn path, margin not stored) |

Under the downgrade for fact-about-him-from-a-short-turn, up to 3,431 of his turns (8.3%) would be affected, and 4,577 more (11.1%) have a below-bar speaker name. Most of these are his own words and would stay as context.

Caveats: counts are turns, not seconds or words; the join is on live turns in Life's store; scores are as stored (see "When values change"); the local store (`state/watch/lifelog.sqlite`) holds only `person_id`, `person_name`, `is_owner`, so these fields live only in lifelog's archive (`speaker_assignments`) until the contract adds `basis`. The numbers in the second table will move when the sweep re-matches.

## Open questions for the owner

1. Are you willing to have a guessed name (a name taken from a recording nearby, 3.2% of other people's turns) shown as "probably" and never used as that person's own word, even when it is right? It is the one place the rule discards something that is often correct.
2. When a fact about someone's behavior toward you rests on a single voice match just over the bar (about 5% wrong), should it stay at "maybe" (the present 0.6 cap) until a second recording or you confirm it? Or is the 0.6 cap enough?
3. May lifelog add `speaker.basis` to its feed (one additive field, a small server change, a regenerated contract), and may it store the lead for turn-level rows from now on?
4. For your own short turns that are close to the bar (under 6 s, between 0.5 and 0.6): treat them as your words for context, and only lower the weight of a fact about you that rests on one of them alone. Agreed?
5. When a name changes later (you answer "Who's this?", or a profile shifts), the same turn can go from a guess to assigned or the reverse. Should a fact filed from a turn that later turns out not to be matched be retired at once, or stay until you say so?
