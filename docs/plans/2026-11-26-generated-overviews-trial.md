# Generated overviews: the trial

The trial of decision 4 in [the plan](2026-11-26-generated-overviews.md), run on 26 Nov 2026 on a copy of the owner's
data (`LIFE_OWNER_DATA_DIR` and `LIFE_STATE_DIR` pointed at a clone; nothing live was written). Names, places and
amounts below are made-up stand-ins. The screenshots are his real data and stay outside the repo.

What ran: two trial prompts, `prompts/memory-situation-markdown.v1.md` (people) and
`prompts/memory-matter-situation.v1.md` (matters), through `begin` / `askOnce` on his engine (OpenRouter, DeepSeek
Flash at the main tier, high effort), by `scripts/overviews-trial.ts`. Each reply was checked as the plan says (every
cite and `life:` link among what the call was shown, quotes found word for word, no heading, no web link), then drawn
as the phone would: the live rows by code (open checks, the next step, a person's open matters, reach), the parts as
Markdown, the Ask field under them, Life's dark brand, 390 px wide.

## The ten subjects

| Subject (stand-in) | Kind | Shown | Input chars | Latency | Words | Shape the model chose |
|---|---|---|---|---|---|---|
| Sam, a close friend | person | 1 episode, story | 22k | 11 s | 124 | two paragraphs: since when, last call |
| His father | family | 45 episodes, story | 50k | 30 s | 234 | three dense paragraphs |
| The builder's CEO | work contact | 13 episodes, story | 35k | 21 s | 198 | three paragraphs |
| A timber supplier | organization, no page | 5 episodes | 16k | 26 s | 133 | a sentence, then a dated list |
| Ben, a friend not seen for a month | barely seen | 4 episodes, story | 24k | 15 s | 155 | three paragraphs, "last met on 22 Oct" |
| A failed card payment | small matter, 2 steps | 2 steps | 1.6k | 6 s | 71 | a sentence and a two-date list |
| The builder's final payment | long matter, 41 steps | 12 newest | 6.6k | 15 s | 183 | a sentence and a dated list |
| A drain pipe at the gate | waiting on someone, 24 steps | 12 newest | 6.9k | 20 s | 217 | sentence, dated list, where it stands |
| A brother's weekend visit | done, 6 steps | 6 steps | 1.2k | 11 s | 92 | two paragraphs, how it ended |
| A client's automation quote | work, 19 steps | 12 newest | 7.4k | 18 s | 170 | sentence, dated list, where it stands |

## Cost and reads

- 11 calls (the 10, plus one person redone after a bad reply), all answered by the first host: **$0.0099 in all**,
  74k input and 16k output tokens. About $0.0012 a person (more for a busy parent) and $0.0006 a matter.
- `source-use` counts them under `memory` (episodes, steps, later records, the page), plus a few mail, chat, git and
  voice units a matter's evidence search added.
- Latency 6 to 30 s a call, run all at once; the whole trial took 31 s. That is night work, never a tap's.
- The plan's first fill (about 200 calls) would cost well under $0.50 at these rates.

## Checks

- **Cites and links:** every part of the ten final replies cites only refs it was shown; no `life:` link was written at
  all, though allowed. No heading, no web link.
- **Quotes:** none was written, so the quote check was not exercised. The prompt asks for found words only; a trial
  with a person whose page holds quotes is needed to see it work.
- **Spot-checked figures** (an amount, a year, a card's last digits, a named fact) were each in the call's input.
- **One bad reply in 11:** the first call for the builder's CEO returned one empty part with no cite. The checks dropped
  it, which left nothing to show; the nightly step must treat "no kept part" as a failed call and keep the last reading,
  as `situations.ts` does today for lines.

## What worked

- **Shape follows the subject.** Small matters got one or two sentences, long ones a dated list of the turns that
  mattered, the done matter said how it ended, the organization got a dated list. No person page used a list; no
  page invented a component.
- **Old people read as old.** The friend not seen for a month opens with "last met on 22 Oct", never as if it were this
  week: the plan's decision 2 (everyone with a page keeps a reading) works with the window ending at the newest episode.
- **The story is what makes a person page good.** The close friend's first sentence (since when, how they met, what
  they went through together) came from the story, not from 30 days of episodes.
- **No status, no next step, no ask in the text.** The model kept to facts; the live rows carried what needs him.

## What didn't

- **Third person everywhere.** The prompt rule "name the owner, never a pronoun" makes every page say "Sam Doe said Sam
  Doe would…" and "the owner's father … the owner declined". It reads stiff and long on his own phone. Either the page
  is written to him ("you") at display time, or the stored reading keeps the name and the phone turns the owner's name
  into "you". Decide before the fill.
- **Too long for busy people.** The father's page was 234 words in three dense paragraphs, over the prompt's 200, with
  money figures he does not need at a glance. The builder's matter and the drain matter repeat amounts and people
  the other pages also hold. "Every fact once" holds within a page but not across them.
- **The live rows repeat the title.** A "your move" check's title is the matter's own name, so the matter page shows its
  name twice at the top (header, then the ask row). That is code, not the model: the ask row on a matter's page should
  show the question only.
- **A sensitive line surfaced.** A family member's page put a blunt line about the relationship, in the owner's own
  past words, in its first paragraph. True and cited, but the owner should see it before such readings are filled for
  everyone.
- **Odd `needsYou`.** In the trial's process, ten reads at once, a person's `now` read said `needsYou: true` for a
  friend with no ask and no open matter; the same read from `bun life memory fetch` said false. Not chased: maybe a
  shared cache read at once by parallel reads. Worth a look before the phone trusts the flag.

## What the plan got wrong

- "With the `histories` add-on on, the situation call is also shown the story" (section 4): today's
  `situations.ts` shows the page, the episodes and the persona only. The trial added the story by hand, and it is
  what made the person pages work, so the new prompt version must add it to the input (outside the digest, as the
  plan says).
- An organization has no page, so under "everyone with a page" none gets a reading. The trial ran one with an empty
  page and it read well; the rule should be "everyone with a page or an organization of his directory with episodes".
- Answer blocks were not needed by any subject; decision 6 (wait) holds.

## Next

The owner looks at the ten screenshots. On his yes: settle "you" against his name, add the story to the person input,
cap length harder for busy people, show the ask row without its matter's title, then the new prompt versions and the
first fill.
