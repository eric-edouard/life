import { clock } from "../core/clock";
import { appendJsonl } from "../core/files";
import { FactCheck, FactCheckAnswer } from "../records/fact-check";
import { checksNow } from "./checks";
import { factCheckKindOf } from "./doubts";
import { readMatterRecords } from "./matters";
import {
  FACT_CHECK_ANSWERS,
  FACT_CHECKS,
  readFactChecks,
} from "./memory-files";
import { readPeople } from "./who";

// His fact checks: nothing is drawn. The open ones are the ending checks `checksNow` lists (`checks.ts`), put to him in a
// chat (`read_fact_checks`) and answered there (`correct_memory`, kind `fact_check`). A check is written to
// memory/fact-checks.jsonl only with his answer, as it was shown, so the answer reads back the same.

/** The ending checks as he is asked them: the step, why Life thinks it is done, the words it came from. */
export async function readEndingChecks() {
  return (await checksNow())
    .filter((c) => c.kind === "ending")
    .map((c) => ({
      doubts: ["a later step seems to show it done"],
      from: c.evidence?.from ?? "an episode",
      quote: c.evidence?.quote ?? null,
      ref: c.ref,
      text: c.guess,
    }));
}

/**
 * Appends his answer to a fact check: first the check as it reads now (an open step a link says ended, when no line
 * holds that ref and `endedBy`), then the answer, so a stored answer always has its check. A later answer replaces it.
 * Throws for a ref with no line and no current ending.
 */
export async function recordFactCheckAnswer(
  ref: string,
  answer: NonNullable<FactCheckAnswer["answer"]>,
  note?: string
) {
  const at = clock().toISOString();
  const { maybe, observations } = await readMatterRecords(await readPeople());
  const link = maybe.get(ref);
  const o = link && observations.find((x) => x.id === ref);
  const lines = readFactChecks();
  if (link && o) {
    if (!lines.some((s) => s.ref === ref && s.endedBy === link.later)) {
      appendJsonl(FACT_CHECKS, FactCheck, [
        {
          at,
          date: o.date,
          endedBy: link.later,
          group: o.subjects[0] ?? "episodes",
          kind: factCheckKindOf(o),
          ref,
          schemaVersion: 1,
          source: o.source.channel,
          text: `Done? ${o.text}`,
          units: [o.unit],
        },
      ]);
    }
  } else if (!lines.some((s) => s.ref === ref)) {
    throw new Error(`no fact check ${ref} in memory/fact-checks.jsonl`);
  }
  return appendJsonl(FACT_CHECK_ANSWERS, FactCheckAnswer, [
    {
      answer,
      at,
      ...(note ? { note } : {}),
      ref,
      schemaVersion: 1,
    },
  ]);
}
