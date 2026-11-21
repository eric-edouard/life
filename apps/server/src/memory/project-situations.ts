import { removeAllBut } from "../core/files";
import { newestWithin } from "../core/lists";
import {
  type ProjectSituation,
  ProjectSituationLine,
} from "../records/situation";
import { isUnderway } from "../records/truth";
import { isRunning, type MatterView } from "./matter-read";
import { readMatterBook } from "./matters";
import { meContext } from "./model-context";
import {
  PROJECT_SITUATIONS,
  PROMPT,
  projectSituationPath,
  promptNameNow,
  readStored,
} from "./project-situation-read";
import { projectOf } from "./read-matters";
import { readMayKeep } from "./read-truth";
import { begin, inBatches, inputsOf, readsOf } from "./run";
import { shownLines } from "./situations";
import { clip } from "./units";
import type { People } from "./who";

// `bun life memory project-situations`: the project situation step (docs/glossary.md: situation). For each project underway
// (`isUnderway`) that shows a running matter, one call reads its directory entry and those matters as they read now and
// writes where the project stands: what it is doing now, what is blocked and on whom, what was decided lately, the next
// deadline; each line citing the matter steps it rests on. Rebuilt whole, never from its last version, and only when what
// it was shown changed (never the clock, so a matter going dormant by days alone rebuilds nothing).
// Nothing is sent. A project's situation is read by `read_matters` of that project and by an agent's packet.

/** The most characters of matters one project's call is shown, the newest first. */
const CALL_CHARS = 30_000;
/** How many of a matter's newest steps the call sees, and how long each one's words. */
const SHOWN_STEPS = 12;
const SHOWN_CHARS = 200;

/** A matter as the call is shown it. `status` is shown but never digested: it moves with the clock. */
const shownOf = (v: MatterView, nameOf: People["nameOf"]) => ({
  ...(v.goal ? { goal: v.goal.text } : {}),
  ...(v.nextStep ? { next_step: v.nextStep.text } : {}),
  name: v.name,
  open: v.openSteps.map((s) => ({
    ...(s.when ? { due: s.when } : {}),
    kind: s.kind,
    ref: s.ref,
    text: clip(s.text, SHOWN_CHARS),
    ...(s.with ? { with: nameOf(s.with) } : {}),
  })),
  steps: v.steps.slice(-SHOWN_STEPS).map((s) => ({
    day: s.day,
    ...(s.ending ? { ended: true } : {}),
    kind: s.kind,
    ref: s.ref,
    text: clip(s.text, SHOWN_CHARS),
  })),
});

/** Who gets a situation and what its call is shown: each project underway with its running matters, the newest within `CALL_CHARS`. */
export const projectTargetsOf = (
  book: readonly MatterView[],
  people: People
) => {
  const { truth } = people;
  const of = projectOf(truth);
  return truth.projects.filter(isUnderway).flatMap((p) => {
    const matters = newestWithin(
      book.filter((v) => isRunning(v) && of(v)?.id === p.id),
      CALL_CHARS,
      {
        at: (v) => v.steps.at(-1)?.at ?? "",
        size: (v) => JSON.stringify(shownOf(v, people.nameOf)).length,
      }
    );
    return matters.length === 0 ? [] : [{ matters, project: p }];
  });
};

type Target = ReturnType<typeof projectTargetsOf>[number];

/** What a project's digest holds, and the call is shown besides `status` and `today`: its directory entry and its matters' words, never the clock. */
export const projectInputOf = (t: Target, nameOf: People["nameOf"]) => ({
  entry: {
    deadlines: t.project.deadlines,
    name: t.project.name,
    notes: clip(t.project.notes.trim(), 2000),
    status: t.project.status,
  },
  matters: t.matters.map((v) => shownOf(v, nameOf)),
});

export async function projectSituations(people: People) {
  const mayKeep = readMayKeep();
  const step = await begin("project-situation", "main", { prompt: PROMPT });
  const book = await readMatterBook(people, step.today);
  const targets = projectTargetsOf(book, people);
  let written = 0;
  await inBatches(targets, step, (t, dir) =>
    step.attempt(
      async () => {
        const { project: p } = t;
        const { entry, matters } = projectInputOf(t, people.nameOf);
        // His words on what Life may keep are an input, like the person situation's.
        const inputs = inputsOf(promptNameNow(mayKeep), {
          entry,
          matters,
          ...(mayKeep === undefined ? {} : { mayKeep }),
        });
        if (readStored(p.id)?.inputs === inputs) {
          return;
        }
        const shownRefs = t.matters.flatMap((v) => [
          ...v.openSteps,
          ...v.steps.slice(-SHOWN_STEPS),
        ]);
        const reply = await step.ask({
          context: meContext(people.truth),
          dir,
          input: {
            entry,
            matters: t.matters.map((v, i) => ({
              ...matters[i],
              status: v.status,
            })),
            today: step.today,
          },
          prompt: PROMPT,
          reads: readsOf(
            shownRefs.map((s) => ({ source: "memory", unit: s.ref }))
          ),
        });
        const lines = shownLines(
          reply,
          new Set(shownRefs.map((s) => s.ref)),
          ProjectSituationLine
        );
        // A reply with no line citing what it was shown is a failed call: the last situation stays, the next run retries.
        if (lines.length === 0) {
          throw new Error("no line cites the steps it was shown");
        }
        const situation: ProjectSituation = {
          built: step.now.toISOString(),
          inputs,
          lines,
          madeBy: step.madeBy(PROMPT),
          project: p.id,
          schemaVersion: 1,
        };
        await Bun.write(
          projectSituationPath(p.id),
          `${JSON.stringify(situation, null, 1)}\n`
        );
        written += 1;
      },
      { project: t.project.id }
    )
  );
  // A project no longer underway, or with no running matter, loses its situation.
  const gone = await removeAllBut(
    PROJECT_SITUATIONS,
    new Set(targets.map((t) => projectSituationPath(t.project.id)))
  );
  return step.end({ gone, projects: targets.length, written });
}
