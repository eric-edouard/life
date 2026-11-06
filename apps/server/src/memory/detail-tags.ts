import { z } from "zod";
import { appendJsonl } from "../core/files";
import { stamp } from "../models/llm";
import type { MadeBy } from "../records/fields";
import {
  Detail,
  DetailTag,
  type Observation,
  ObservationId,
} from "../records/observation";
import { KEEP_AT } from "../records/unit";
import { readDetailTags } from "./details";
import { DETAIL_TAGS } from "./ledger";
import { begin, checkedEntries, chunks, inBatches } from "./run";
import { PERSON } from "./units";
import { observationsNow, readPeople } from "./who";

// The details step: the fast model reads each fact about someone, by its text alone (a fact's text names who and what by
// design), and says which kind of detail it states, if any (`detail-tags.jsonl`). The only place a fact's detail is
// decided; which page it lands on is its home (`homeOf`), as for every fact.

const DETAILS_PROMPT = "memory-details.v1";
const PER_CALL = 100;

/**
 * The facts to tag: those that can be page lines (as `placed`: kept, never conditional), naming a person, with no tag by the current prompt; newest first, so a
 * night that stops early has tagged what is fresh.
 */
export const untagged = (
  observations: Observation[],
  tags: ReadonlyMap<string, DetailTag>,
  prompt = DETAILS_PROMPT
) =>
  observations
    .filter(
      (o) =>
        o.importance >= KEEP_AT &&
        o.modality !== "conditional" &&
        [o.about, ...o.entities].some((e) => e && PERSON.test(e)) &&
        tags.get(o.id)?.madeBy.prompt !== prompt
    )
    .toSorted((a, b) => b.at.localeCompare(a.at));

const Entry = z.object({ detail: Detail.nullable(), id: ObservationId });

/** The model's reply checked: one tag per fact asked about, once; anything else counted, never trusted. */
export function parseTags(
  reply: unknown,
  asked: ReadonlySet<string>,
  ctx: { at: string; madeBy: MadeBy }
) {
  const list = z.object({ facts: z.array(z.unknown()) }).parse(reply).facts;
  const { entries, invalid } = checkedEntries(
    list,
    Entry,
    (e) => e.id,
    (id) => asked.has(id)
  );
  const rows = entries.map((e) =>
    DetailTag.parse({
      at: ctx.at,
      detail: e.detail,
      madeBy: ctx.madeBy,
      observation: e.id,
      schemaVersion: 1,
    })
  );
  return { invalid, rows };
}

/** The nightly step: tags every fact about someone not tagged yet by this prompt. A failed batch waits for the next night. */
export async function tagDetails() {
  const step = await begin("details", "fast", { prompt: DETAILS_PROMPT });
  const people = await readPeople();
  const { observations } = await observationsNow(people);
  const due = untagged(observations, readDetailTags());
  const ctx = {
    at: step.now.toISOString(),
    madeBy: stamp(step.llm, DETAILS_PROMPT, step.run),
  };
  let tagged = 0;
  let invalid = 0;
  await inBatches(chunks(due, PER_CALL), step.dir, (batch, dir) =>
    step.attempt(async () => {
      const json = await step.ask({
        dir,
        input: {
          facts: batch.map((o) => ({
            about: o.about ? people.nameOf(o.about) : null,
            id: o.id,
            text: o.text,
            type: o.type,
          })),
        },
        prompt: DETAILS_PROMPT,
      });
      const checked = parseTags(json, new Set(batch.map((o) => o.id)), ctx);
      // Written as each call ends: a stopped run resumes from them.
      await appendJsonl(DETAIL_TAGS, DetailTag, checked.rows);
      tagged += checked.rows.length;
      invalid += checked.invalid;
    })
  );
  return step.end({ due: due.length, invalid, tagged });
}
