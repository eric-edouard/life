import { clock } from "../core/clock";
import { appendJsonl } from "../core/files";
import {
  FactCheck,
  FactCheckAnswer,
  isEndingCheck,
} from "../records/fact-check";
import { checksNow, endingGuessOf, isEndingKind, isEndingOpen } from "./checks";
import { factCheckKindOf } from "./doubts";
import { readMatterRecords } from "./matters";
import {
  FACT_CHECK_ANSWERS,
  FACT_CHECKS,
  readFactCheckAnswers,
  readFactChecks,
} from "./memory-files";
import { readPeople } from "./who";

// His fact checks: nothing is drawn. The open ones are the ending checks `checksNow` lists (`checks.ts`), put to him in a
// chat (`read_fact_checks`) and answered there (`correct_memory`, kind `fact_check`). A check is written to
// memory/fact-checks.jsonl only with his answer, as it was shown, so the answer reads back the same.

/** The ending checks as he is asked them: the step, why Life thinks it is done, the words it came from. */
export async function readEndingChecks() {
  return (await checksNow()).filter(isEndingKind).map((c) => ({
    doubts: ["a later step seems to show it done"],
    from: c.evidence.from,
    quote: c.evidence.quote,
    ref: c.ref,
    text: c.guess,
  }));
}

/**
 * Appends his answer to a fact check: first the check as it is shown (an open ending check: its guess as the text, the later step's channel as the source), then the answer, so a stored answer always has its check. A later answer replaces it.
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
  const doubted = new Set(
    lines.filter((s) => !isEndingCheck(s)).map((s) => s.ref)
  );
  const answered = new Set(
    [...readFactCheckAnswers()].flatMap(([r, a]) => (a.answer ? [r] : []))
  );
  if (link && o && isEndingOpen(ref, true, { answered, doubted })) {
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
          // Where the later step's words were said, as the check showed them (an episode has no channel).
          source:
            observations.find((x) => x.id === link.later)?.source.channel ??
            null,
          text: endingGuessOf(o.text),
          units: [o.unit],
        },
      ]);
    }
  } else if (!lines.some((s) => s.ref === ref) || (link && doubted.has(ref))) {
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
