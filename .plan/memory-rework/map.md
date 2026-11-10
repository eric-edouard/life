# Life's memory rework

## Destination

A reviewed and agreed spec of Life as his life-encompassing memory (his words, 9 Nov): it knows everything about him and
tells him directly where things stand in every area of his life (areas and projects, practical, relationships, goals,
vision, psych, meta), and makes predictions about the people he interacts with and about him. It knows him in some ways
better than he knows himself, by being the objective observer of his life and actions. The people layers (what each
close person is like, what repeats between them and him, wants and offers in four directions) and the arcs of
relationships, projects and periods serve that. Done when nothing is left to decide before the pilot and the build plan. The pilot (his father and a close friend, in full)
proves every layer at once: the people layers, the arcs, his life overview and a first set of scored forecasts. The pilot runs after this map, once his credits return (Wednesday 11 Nov 2026 at the earliest), never before.

## Notes

- Domain: Life (`AGENTS.md`, `docs/architecture.md`, `docs/SCHEMA.md`, `docs/glossary.md`). The problem statement is
  `~/Downloads/life-memory-problem.md`; his wants are `~/Downloads/life-people-layers-wants.md`; the research is
  `~/Downloads/life-psych-research/` (read `05-merged-findings.md` first). Earlier designs (07, 09, 15, 11b, 18) and the
  pilots live in the person-readings session's scratchpad and `.claude/worktrees/person-readings/PLAN.md`.
- Skills: `grill-me` and `domain-modeling` for every grilling ticket; `research` for research tickets; `golden-rule-plan`
  once the spec turns into a build plan (after this map).
- Standing preferences (his words, 8–9 Nov): aim for the most accurate system, cost of building is not the issue; grounded in
  accepted modern psychology, never pop psychology; usable output, not thin lines; lean, no gas factory; he is the only
  rater, blind, and his ratings are never a target; reviews never cut what he asked for (a cut becomes his decision);
  no spend and no model switch without his yes; names are approved by him; search stays text plus vectors.
- Standing decisions already made (not re-asked here): his words to a person can be a performance and are never his view;
  what he says about someone to others is his more honest view, read through the listener; a meter never pulls an extreme
  to the middle; a trait reads conduct, not demands on others; group chats count, with the other side's lines as context;
  deleted messages are read like any other, tagged; his labels for people are shown as his view, quoted; MBTI later and only
  as an interpretation; structured data first, pages as views; old archives go straight to the overview, the middle layers
  serve recent life; old facts can retire; imports are read once and never paid twice; forecasts prove themselves by
  backtest before they drive anything; closeness by depth, not volume or time.
- The build may rebuild the whole architecture if the spec needs it (his words, 9 Nov: "we want the best system"). The
  one requirement: every end-user feature Life has today stays (people and area pages, situations, open items, appointments
  and the calendar, fact checks, the nightly and daily mails, the connector's reads, search, actions), and is improved.
- Coded acts cover the whole history (9 Nov). Tokens for old data are not the issue; reading the same data twice is. So
  every prompt that reads old history is frozen on the pilot before the backfill, and the spec says for each read what
  invalidates it.
- Organic memory (his principle, 9 Nov): the closer to now, the more detailed; the older, the broader and smaller,
  while the important long-standing things are kept. Today's granular layers are needed near the present (close to
  actual things). Imports older than about a year skip the middle layers, so the system doesn't bloat.
- An exchange is read by several focused prompts, one per family of codes, never one wide read (9 Nov).
- His checks are blind meter ratings only, once per round; he never labels single exchanges (9 Nov). Codes are checked
  against a stronger model (Codex Sol on his subscription) and by forecast backtests.
- Talk about absent people counts everywhere (his ask, 9 Nov, from a recorded call with a close friend): when he tells A
  about B, or A tells him about B or about A's own people, it is evidence about B (persona, what repeats between him and
  B, B's arc), about him and A (what he confides in A is depth), and about him (his honest view, filtered by the
  listener). B is often never named ("elle", "lui"): who is meant is worked out from the whole conversation and what
  Life already knows (who he is seeing now), and shown as a reading when it is a guess.
- The first layer above the units is built to outlive model migrations (his point, 10 Nov): it extracts as much as the
  raw holds, close to the evidence and light on interpretation; interpretation lives in the layers above, cheap to rebuild.
- All backfilling runs on Codex (his subscription), never a cash provider (his word, 10 Nov).
- Models: the strongest model for grilling and design tickets; cheaper ones for research reading and file work.
- This map lives in the code repo: nothing personal in it (no names but roles, no quotes, no numbers about his people).
  Anything of his a ticket produces goes to his data repo or a scratchpad, linked by path.

## Decisions so far

- [Everything Life does for him today](./tickets/01-everything-life-does-today.md) — the feature checklist with what feeds each; two stored layers are redundant, and his old project-loop answers are a source to keep; the daily mails live in his scheduled tasks; appointments, area situations and some CLI-only features are gaps to improve
- [Who really spoke in a recording](./tickets/04-who-really-spoke.md) — lifelog's contract gains `speaker.basis` (assigned, matched, inferred, none); only assigned and matched turns are a person's own evidence
- [Old sources, read in once](./tickets/03-old-sources.md) — old WhatsApp from an iPhone backup (started 9 Nov) plus the father's old-number export; iMessage and Notes already complete; mail needs a filter; three networks need exports; all land before the one read
- [The questions he asks Life](./tickets/02-the-questions-he-asks.md) — 102 questions in his data repo, 25 failed; prediction, arcs and himself are thin, so the set grows from his old chats and assistant exports
- [Naming the unnamed voices](./tickets/24-naming-the-unnamed-voices.md) — lifelog re-fingerprints old voices, joins split voices, keeps unnamed fingerprints until named, and asks about voices that say a lot near him, ranked by words; fixed before the pilot

## Not yet specified

- **How agents read all this.** The connector's shape for the overview, meters, arcs and forecasts: which reads change,
  batched into one reconnect. Sharpens once the outputs are settled. <clears-with: 21>
- **Pages as views.** How the person, area and owner pages show structured readings (meters drawn as meters, a short
  summary first), and whether the pages stay Markdown. <clears-with: 13>
- **MBTI as an interpretation.** Computed from the meters, never a source of truth, for questions like "will I get along
  with this person?". <clears-with: 13>

## Out of scope

- **The pilot, the build and the backfill.** They come after this map: the pilot once his credits return, then a
  golden-rule plan, the build and the priced backfill.
