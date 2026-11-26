import { removeAllBut } from "../core/files";
import { newestWithin } from "../core/lists";
import type { Situation } from "../records/situation";
import { shownKeyOf } from "./deletions";
import { NIGHT_CHARS, NO_EVIDENCE, shownOf } from "./matter-directions";
import { readEvidence } from "./matter-evidence";
import { laterShownOf, type MatterView } from "./matter-read";
import {
  matterBookAgain,
  readMatterBookAndRecords,
  type readMatterRecords,
} from "./matters";
import { MATTER_SITUATIONS, matterSituationPath } from "./memory-files";
import { meContext } from "./model-context";
import { readMayKeep } from "./read-truth";
import { begin, inBatches, inputsOf, readsOf } from "./run";
import {
  MATTER_SITUATION_PROMPT as PROMPT,
  partsOf,
  promptNameNow,
  readStoredSituation,
} from "./situation-parts";
import type { People } from "./who";
import { dayNow } from "./zones";

// `bun life memory matter-situations`: the matter situation step (docs/glossary.md: matter situation), run at night after
// the matter directions. For each matter of two steps or more whose steps, open steps, goal or later records changed,
// one call reads them as the direction call is shown them (`shownOf`) with the units and payments found near its words
// (`readEvidence`), and writes the page he sees when opening the matter, as Markdown parts to him, each citing what it
// rests on (`situation-parts.ts`). A matter of one step gets no call: its step is its page. The digest holds refs and
// words only, never a name, a status, the evidence (a search's) or the clock, so a matter with nothing new costs no call.
// The newest within the night's size (`NIGHT_CHARS`), like the directions. Nothing is sent.

/** The matters that have a page of their own: two steps or more. */
const isPaged = (v: MatterView) => v.steps.length >= 2;

const idOfEvery = (ref: string) => ({ id: ref });

/** A matter's call input and its digest: what it was shown, less its name, people, call-local id, the clock and who said a later record. */
export const matterSituationInputOf = (
  v: MatterView,
  later: Parameters<typeof shownOf>[4],
  today: string,
  nameOf: (ref: string) => string
) => {
  const { id: _id, ...input } = shownOf(
    v,
    v.id,
    today,
    nameOf,
    later,
    idOfEvery
  );
  const { name: _name, people: _people, today: _today, ...digested } = input;
  return {
    digested: {
      ...digested,
      later: digested.later.map(({ said_by: _by, ...o }) => o),
    },
    input,
  };
};

const readStored = (matter: string) =>
  readStoredSituation(
    matterSituationPath(matter),
    shownKeyOf.matterSituation(matter)
  );

/** `records`: the matter records the night already read (`readMatterRecords`), read here when not given. */
export async function matterSituations(
  people: People,
  {
    records,
    today = dayNow(),
  }: {
    records?: Awaited<ReturnType<typeof readMatterRecords>>;
    today?: string;
  } = {}
) {
  const mayKeep = readMayKeep();
  const { book, records: read } = records
    ? { book: matterBookAgain(records, today), records }
    : await readMatterBookAndRecords(people, today);
  const paged = book.filter(isPaged);
  const due = paged.flatMap((v) => {
    const later = laterShownOf(v, read.observations, read.refOf);
    const { digested, input } = matterSituationInputOf(
      v,
      later,
      today,
      people.nameOf
    );
    // His words on what Life may keep are an input, like the person situation's.
    const inputs = inputsOf(promptNameNow(PROMPT, mayKeep), {
      ...digested,
      ...(mayKeep === undefined ? {} : { mayKeep }),
    });
    return readStored(v.id)?.inputs === inputs
      ? []
      : [{ input, inputs, later, v }];
  });
  const chosen = newestWithin(due, NIGHT_CHARS, {
    at: (m) => m.v.steps.at(-1)?.at ?? "",
    size: (m) => JSON.stringify(m.input).length,
  });
  const evidence = await readEvidence(chosen, today);
  const step = await begin("matter-situation", "main", { prompt: PROMPT });
  let written = 0;
  await inBatches(chosen, step, (m, dir) =>
    step.attempt(
      async () => {
        const found = evidence.get(m.v.id) ?? NO_EVIDENCE;
        const shown = m.input;
        const input = { matter: { ...shown, ...found } };
        const ids = [
          ...shown.steps.map((s) => s.id),
          ...shown.open.map((s) => s.id),
          ...shown.later.map((o) => o.id),
        ].filter((id): id is string => id !== undefined);
        const reply = await step.ask({
          context: meContext(people.truth),
          dir,
          input,
          prompt: PROMPT,
          reads: readsOf([
            ...ids.map((unit) => ({ source: "memory" as const, unit })),
            ...found.units.map((u) => ({ source: u.source, unit: u.id })),
          ]),
        });
        const situation: Situation = {
          built: step.now.toISOString(),
          inputs: m.inputs,
          madeBy: step.madeBy(PROMPT),
          parts: partsOf(
            reply,
            new Set([
              ...ids,
              ...found.units.map((u) => u.id),
              ...found.payments.map((p) => p.id),
            ]),
            input
          ),
          schemaVersion: 2,
          subject: m.v.id,
        };
        await Bun.write(
          matterSituationPath(m.v.id),
          `${JSON.stringify(situation, null, 1)}\n`
        );
        written += 1;
      },
      { matter: m.v.id }
    )
  );
  // A matter gone from the book, or left with one step, loses its situation.
  const gone = await removeAllBut(
    MATTER_SITUATIONS,
    new Set(paged.map((v) => matterSituationPath(v.id)))
  );
  return step.end({ due: due.length, gone, matters: chosen.length, written });
}
