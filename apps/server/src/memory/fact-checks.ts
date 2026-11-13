import { clock } from "../core/clock";
import { appendJsonl } from "../core/files";
import { settings } from "../core/settings";
import { FactCheck } from "../records/fact-check";
import { type Doubt, doubtsOf, drawFactChecks, plain } from "./doubts";
import { isEndingAsk, readBatches } from "./endings";
import { readMatterRecords } from "./matters";
import {
  FACT_CHECKS,
  openFactChecks,
  readFactChecks,
  readObservations,
} from "./memory-files";
import { readPeople } from "./who";
import { dayNow, localDate } from "./zones";

// His fact checks: the memory lines Life is least sure of (`doubtful` only, never recorded text), drawn each night, put to
// him in a chat (`read_fact_checks`) and answered there (`correct_memory`, kind `fact_check`: memory/fact-check-answers.jsonl).

/** How many stay open at once. */
const OPEN = 5;
const WHY: Record<Doubt, string> = {
  "guessed-person": "who it's about is only guessed",
  "low-confidence": "the reading itself was unsure",
};

/** Draws new ones until OPEN are open. The caller holds the lock (`drawFactChecks`). */
export async function topUpFactChecks(now = clock().getTime()) {
  const room = OPEN - openFactChecks(now).length;
  return room > 0 ? (await drawFactChecks(room)).length : 0;
}

/** The most ending asks in a day. */
const ENDING_ASKS_A_DAY = 3;

/**
 * After a link found an ending, asks him in conversation whether it is right: a fact check on the open step ("Done?
 * <the step>", the later step's words as its quote), the oldest ending first, at most `ENDING_ASKS_A_DAY` a day, one
 * ever for an open step (an answer is by `ref`). Nothing while his `endings` setting is off. The caller holds the lock.
 */
export async function askEndings(now = clock()) {
  if (!settings().endings) {
    return 0;
  }
  const checked = readFactChecks();
  const room =
    ENDING_ASKS_A_DAY -
    checked.filter((s) => isEndingAsk(s) && localDate(s.at) === dayNow(now))
      .length;
  if (room <= 0) {
    return 0;
  }
  const asked = new Set(checked.map((s) => s.ref));
  const { maybe, observations } = await readMatterRecords(await readPeople());
  const byId = new Map(observations.map((o) => [o.id, o]));
  const asks = [...maybe]
    .filter(([ref]) => !asked.has(ref) && byId.has(ref))
    .toSorted((a, b) => a[1].at.localeCompare(b[1].at))
    .slice(0, room)
    .flatMap(([ref, link]) => {
      const o = byId.get(ref);
      return o
        ? [
            {
              at: now.toISOString(),
              date: o.date,
              group: o.subjects[0] ?? "episodes",
              kind:
                o.modality === "plan" || o.modality === "reported"
                  ? o.modality
                  : ("fact" as const),
              later: link.later,
              ref,
              schemaVersion: 1 as const,
              source: o.source.channel,
              text: `Done? ${o.text}`,
              units: [o.unit],
            },
          ]
        : [];
    });
  appendJsonl(FACT_CHECKS, FactCheck, asks);
  return asks.length;
}

/** The open fact checks as he is asked them: the memory line word for word, why Life doubts it, the words it came from. */
export async function readOpenFactChecks(now = clock().getTime()) {
  const open = openFactChecks(now);
  const [observations, people] = await Promise.all([
    readObservations(),
    readPeople(),
  ]);
  const byId = new Map(observations.map((o) => [o.id as string, o]));
  const quotes = new Map(
    readBatches().flatMap((b) =>
      b.links.map((l) => [`${l.earlier} ${l.later}`, l.quote] as const)
    )
  );
  return open.map((s) => {
    const o = byId.get(s.ref);
    return {
      doubts: s.later
        ? ["a later step seems to show it done"]
        : (o ? doubtsOf(o, people.refOf) : []).map((d) => WHY[d]),
      from: `${s.source ?? "an episode"}, ${plain(s.date)}`,
      quote: s.later
        ? (quotes.get(`${s.ref} ${s.later}`) ?? null)
        : (o?.quote ?? null),
      ref: s.ref,
      text: s.text,
    };
  });
}
