import { removeAllBut } from "../core/files";
import { newestWithin } from "../core/lists";
import type { Situation } from "../records/situation";
import { isUnderway } from "../records/truth";
import { shownKeyOf } from "./deletions";
import { isRunning, type MatterView, nextStepNow } from "./matter-read";
import { matterBookAgain, readMatterRecords } from "./matters";
import { meContext } from "./model-context";
import { openDecisions, projectOf } from "./read-matters";
import { readMayKeep } from "./read-truth";
import { begin, inBatches, inputsOf, readsOf } from "./run";
import {
  PROJECT_SITUATIONS,
  PROJECT_SITUATION_PROMPT as PROMPT,
  partsOf,
  projectSituationPath,
  promptNameNow,
  readStoredSituation,
} from "./situation-parts";
import { clip } from "./units";
import type { People } from "./who";

// `bun life memory project-situations`: the project situation step (docs/glossary.md: situation). For each project underway
// (`isUnderway`) that shows a running matter, one call reads its directory entry and those matters as they read now and
// writes the page he sees when opening the project, as Markdown parts to him (`situation-parts.ts`), each citing the
// matter steps it rests on. Rebuilt whole, never from its last version, and only when what
// it was shown changed: its directory entry and the open matters under it, by refs, never the clock (a matter going
// dormant by days alone, a renamed project or person rebuilds nothing). Who is eligible today (a running matter) is the clock's.
// Nothing is sent. A project's situation is read by `read_matters` of that project and by an agent's packet.

/** The most characters of matters one project's call is shown, the newest first. */
const CALL_CHARS = 30_000;
/** How many of a matter's newest steps the call sees, and how long each one's words. */
const SHOWN_STEPS = 12;
const SHOWN_OPEN = 30;
const SHOWN_CHARS = 200;

/**
 * A matter as the call is shown it, its words bounded so a large matter still fits: the goal, the next step as it reads
 * now (`nextStepNow`: his pending decision while a card is open), its newest open steps and steps. `withOf` names who a
 * step is with: the call's names, the digest's refs. Never its name or status: those move with a rename or the clock.
 */
const shownOf = (
  v: MatterView,
  decisions: ReturnType<typeof openDecisions>,
  withOf: (ref: string) => string
) => {
  const next = nextStepNow(v, decisions);
  return {
    ...(v.goal ? { goal: v.goal.text } : {}),
    ...(next ? { next_step: next.text } : {}),
    open: v.openSteps.slice(-SHOWN_OPEN).map((s) => ({
      ...(s.when ? { due: s.when } : {}),
      kind: s.kind,
      ref: s.ref,
      text: clip(s.text, SHOWN_CHARS),
      ...(s.with ? { with: withOf(s.with) } : {}),
    })),
    steps: v.steps.slice(-SHOWN_STEPS).map((s) => ({
      day: s.day,
      ...(s.ending ? { ended: true } : {}),
      kind: s.kind,
      ref: s.ref,
      text: clip(s.text, SHOWN_CHARS),
    })),
  };
};

/** The steps a matter's call shows, whose refs a line may cite. */
const shownStepsOf = (v: MatterView) => [
  ...v.openSteps.slice(-SHOWN_OPEN),
  ...v.steps.slice(-SHOWN_STEPS),
];

/**
 * Who gets a situation and what its call is shown: each project underway with a running matter today (the clock's
 * eligibility), shown all the open matters under it, dormant ones too (so one going dormant changes nothing), the
 * newest within `CALL_CHARS`.
 */
export const projectTargetsOf = (
  book: readonly MatterView[],
  people: People,
  decisions: ReturnType<typeof openDecisions>
) => {
  const { truth } = people;
  const of = projectOf(truth);
  return truth.projects.filter(isUnderway).flatMap((p) => {
    const open = book.filter((v) => v.open && of(v)?.id === p.id);
    if (!open.some(isRunning)) {
      return [];
    }
    // Only a matter with an open step is shown: one open only for being recent (nothing to do on it) closes with the
    // clock alone, which must not regenerate the situation. Sized as the call renders it, its name and status too.
    const matters = newestWithin(
      open.filter((v) => v.openSteps.length > 0),
      CALL_CHARS,
      {
        at: (v) => v.steps.at(-1)?.at ?? "",
        size: (v) =>
          JSON.stringify({
            ...shownOf(v, decisions, people.nameOf),
            name: v.name,
            status: v.status,
          }).length,
      }
    );
    return matters.length === 0 ? [] : [{ matters, project: p }];
  });
};

type Target = ReturnType<typeof projectTargetsOf>[number];

/** What a project's digest holds: its directory entry's facts and its matters' words by refs, never a name, a status or the clock. */
export const projectInputOf = (
  t: Target,
  decisions: ReturnType<typeof openDecisions>
) => ({
  entry: {
    deadlines: t.project.deadlines,
    notes: clip(t.project.notes.trim(), 2000),
    project: t.project.id,
    status: t.project.status,
  },
  matters: t.matters.map((v) => shownOf(v, decisions, String)),
});

/** `records`: the matter records the night already read (`readMatterRecords`), read here when not given. */
export async function projectSituations(
  people: People,
  records?: Awaited<ReturnType<typeof readMatterRecords>>
) {
  const mayKeep = readMayKeep();
  const step = await begin("project-situation", "main", { prompt: PROMPT });
  const decisions = openDecisions();
  const targets = projectTargetsOf(
    matterBookAgain(records ?? (await readMatterRecords(people)), step.today),
    people,
    decisions
  );
  let written = 0;
  await inBatches(targets, step, (t, dir) =>
    step.attempt(
      async () => {
        const { project: p } = t;
        const { entry, matters } = projectInputOf(t, decisions);
        // His words on what Life may keep are an input, like the person situation's.
        const inputs = inputsOf(promptNameNow(PROMPT, mayKeep), {
          entry,
          matters,
          ...(mayKeep === undefined ? {} : { mayKeep }),
        });
        const stored = readStoredSituation(
          projectSituationPath(p.id),
          shownKeyOf.projectSituation(p.id)
        );
        if (stored?.inputs === inputs) {
          return;
        }
        const shownRefs = t.matters.flatMap(shownStepsOf);
        const shown = [...new Set(shownRefs.map((s) => s.ref))];
        const input = {
          entry: { ...entry, name: t.project.name },
          matters: t.matters.map((v) => ({
            ...shownOf(v, decisions, people.nameOf),
            name: v.name,
            status: v.status,
          })),
          today: step.today,
        };
        const reply = await step.ask({
          context: meContext(people.truth),
          dir,
          input,
          prompt: PROMPT,
          reads: readsOf(
            shownRefs.map((s) => ({ source: "memory", unit: s.ref }))
          ),
        });
        const situation: Situation = {
          built: step.now.toISOString(),
          inputs,
          madeBy: step.madeBy(PROMPT),
          parts: partsOf(reply, new Set(shown), input),
          schemaVersion: 2,
          shown,
          subject: p.id,
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
