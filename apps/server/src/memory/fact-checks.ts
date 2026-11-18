import { clock } from "../core/clock";
import { appendJsonl } from "../core/files";
import {
  FactCheck,
  FactCheckAnswer,
  isEndingCheck,
} from "../records/fact-check";
import { endingGuessOf, isEndingOpen } from "./checks";
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
// chat (`read_inbox`) and answered there (`answer_check`, `answer-check.ts`). A check is written to
// memory/fact-checks.jsonl only with his answer, as it was shown, so the answer reads back the same.

/**
 * Appends his answer to an open ending check and returns it: first the check as it is shown (its guess as the text, the later step's channel as the source), then the answer, so a stored answer always has its check.
 * Throws for any other ref: one answered already, an old doubt line, a step with no ending found.
 */
export async function recordFactCheckAnswer(
  ref: string,
  answer: "false" | "outdated",
  note?: string
) {
  const at = clock().toISOString();
  const { linkEndings, observations } = await readMatterRecords(
    await readPeople()
  );
  const link = linkEndings.get(ref);
  const o = link && observations.find((x) => x.id === ref);
  const lines = readFactChecks();
  const doubted = new Set(
    lines.filter((s) => !isEndingCheck(s)).map((s) => s.ref)
  );
  const answered = new Set(
    [...readFactCheckAnswers()].flatMap(([r, a]) => (a.answer ? [r] : []))
  );
  if (!(link && o && isEndingOpen(ref, { answered, doubted }))) {
    throw new Error(`Not done: no open ending check ${ref}.`);
  }
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
          observations.find((x) => x.id === link.later)?.source.channel ?? null,
        text: endingGuessOf(o.text),
        units: [o.unit],
      },
    ]);
  }
  const line: FactCheckAnswer = {
    answer,
    at,
    ...(note ? { note } : {}),
    ref,
    schemaVersion: 1,
  };
  appendJsonl(FACT_CHECK_ANSWERS, FactCheckAnswer, [line]);
  return line;
}
