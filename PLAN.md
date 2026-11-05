# One person, one ref: inferred people link to the map

Problem: the episodes call meets a handle or name not on the map (a lifelog first name, an Instagram sender) and, when it thinks it is someone on the map, is told to write it in `relation` as prose ("probably <a friend>, on the map") and stay below 0.5, "the owner's own word settles it". He never answers (a step that waits on
him: AGENTS.md forbids it), so the surface stays unknown or becomes its own `inf_` person with its own page. Live data:
160 of 457 inferred records carry such a note, about a dozen people and two companies; one close
person had three inferred pages beside hers.

## Milestone 1: the link
- [x] `InferredPerson.person` (`records/observation.ts`): the map person this surface is, when the call judges it is
      them; null otherwise (old lines default to null). Glossary line.
- [x] `checkPeople` keeps `person` only when it is a ref of the map the call was shown (`ctx.people`).
- [x] One fold: `merged(corrections, inferred)` folds a linked inferred person (`person:inf_…` → `person`) from
      `INFERRED_USE_AT`, under his `same-person` folds; `resolver` maps a linked surface to `person`; his
      `not-this-person` on a surface blocks both.
- [x] Every fold goes through `readPeople().canon`: `levelsNow`, `waitingOf`, `aboutNow` take `canon`, not
      `corrections` (they each rebuilt `merged(corrections)`).
- [x] Episodes prompt v6 → v7: a surface that is someone on the map gets their ref in `person`, with the confidence
      that it is them; "stay below 0.5, his word settles it" goes.
- [x] Tests: `checkPeople` keeps a map ref and drops an unknown one; a linked surface resolves to the map person, a
      linked `inf_` ref folds into them, `not-this-person` blocks the link.

## Milestone 2: measure
- [x] On a data copy, re-read 21 days holding the duplicate surfaces with v7; count links right, wrong, missed
      (two people on the map with one first name must stay unlinked or right).
- [x] Report the count of affected days and the cost of re-reading them live; that re-read only on his yes.

## Milestone 3: one surface, one person
Found measuring: a surface re-asked gets a new id each time its name changes (19 surfaces hold 2–10 ids), and a
confident guess made before v7 is never asked again, so it never links (7 stuck guesses on the copy).
- [x] `merged`: every id a surface was given folds into what the surface reads as now (`readingOf`, the resolver's own
      order before folds: his `this-is`, truth/, the latest confident guess's link, the guess). The resolver is that
      reading, folded. No new state.
- [x] `person` null when the call judged no one on the map is them; absent only on older guesses: the episodes call
      counts a surface as known when it resolves to truth/, or to a guess that was judged (`person` present).
- [x] Re-read on the copy the six days holding the stuck surfaces: each came back and was judged again; one new right
      link, the rest judged not someone on the map (their map entries say nothing to match), none wrong.
- Folds: live 13 → 49 with no model call (the fold alone); on the copy after v7 and the re-reads, 111 of 408 ids.

## Golden rule plan
Inventory: `InferredPerson` `records/observation.ts:242`; `checkPeople`, `inferredId` `memory/people.ts:31,44`;
`resolver` `who.ts:72` (`guessed` from `INFERRED_USE_AT`), `merged` `who.ts:32`, callers `who.ts:79,131,302`,
`closeness.ts:245,346`; `levelsWith` callers `situation.ts:78`, `search.ts:875,1245`, `episodes.ts:455`,
`extract.ts:426`, `pages.ts:149`; `nameable` `who.ts:414` (drops folded inferred people); corrections `this-is`,
`not-this-person`, `same-person` `observation.ts:156-210`; prompt rule `memory-episodes.v6.md:164`; glossary
"inferred", "map" `glossary.md:88,90`. rg: `merged\(|levelsWith\(|levelsNow\(|waitingOf\(`, `InferredPerson`,
`INFERRED_USE_AT`, `on the map`, `same-person`.
Shape: the model's "it is X" becomes a field, used like every inferred guess (from 0.5, until he corrects it), through
the one fold that already handles his `same-person`: pages, closeness, names, authors and search follow without a
change of their own. `canon` is computed once per read (`readPeople`) and passed, instead of rebuilt in five places.
State: one nullable field per inferred record, model-owned, append-only (latest record per surface wins, as now).
Deletes: the prose-and-wait rule; four `merged(corrections)` rebuilds; the duplicate pages they cause.
Net lines: about +60 / −35 (milestone 3: `readingOf` split out of `resolver`, which merged and the resolver share; about +25 / −15).
Plan review: reshape → fixed: `person` only a truth/ ref (a link never leads to another guess); the link per surface
(the latest confident record decides, shared by the resolver and the fold), so an older guess on that surface folds
too and a newer unlinked answer takes it back; `levelsWith`/`pagedNow` take `readPeople`'s folds; the fold rule
written in AGENTS.md "One way". Kept on purpose: filing under the `inf_` id with the link applied only at read (the
extraction model is shown people as they resolve, so it names the map person itself; keeping the guess would need a
second view of every person): a wrong link is fixed as a wrong guess is today, `not-this-person` and a `reread`.
