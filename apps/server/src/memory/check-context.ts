import type { CheckGroup } from "../core/names";
import { LIFE_ASKER } from "../core/names";
import type { Quote } from "./check-quotes";
import type { CheckInputs, Line } from "./checks";
import { type Check, LIFE_CHECKS, preTickedOf } from "./life-checks";
import { matterPeopleOf } from "./matter-read";
import { newMatterOffersOf } from "./read-matters";

// What every kind of check builder shares (`checks.ts`): the lookups made once (`Ctx`) and a guess ranked by what rides on it.

export interface Ranked {
  /** What the guess also rests on, for its cause (`causeOf`): an ending's later step. */
  basis?: string;
  check: Omit<Check, "confirm" | "lifeLinks" | "matter">;
  /** For the order (`inboxOrderOf`): when a decision was asked, else the newest day among the lines it rides on; a decision's `matter` as its ask resolved it, the finder's pick on a tie. */
  day: string;
  matter?: string;
  /** What it rests on, quoted into its context by `checksOf`. */
  quote?: Quote;
}

export type MatterId = CheckInputs["matters"][number];

/** `CheckInputs` with the lookups every builder shares, made once. */
export interface Ctx extends CheckInputs {
  byId: ReadonlyMap<string, Line>;
  /** Every step any matter holds, open or not. */
  matterSteps: ReadonlySet<string>;
  /** The open matters holding a step, by the step's ref, and involving a person, by the person's ref. */
  mattersByPerson: ReadonlyMap<string, Set<MatterId>>;
  mattersByStep: ReadonlyMap<string, Set<MatterId>>;
  /** The matters offered as new matters (`newMatterOffersOf`), by id: their your move card waits until the offer ends. */
  offered: ReturnType<typeof newMatterOffersOf>;
}

export function ctxOf(c: CheckInputs): Ctx {
  const mattersByStep = new Map<string, Set<MatterId>>();
  const mattersByPerson = new Map<string, Set<MatterId>>();
  const add = (by: Map<string, Set<MatterId>>, ref: string, m: MatterId) =>
    by.set(ref, (by.get(ref) ?? new Set()).add(m));
  for (const m of c.matters.filter((x) => x.open)) {
    for (const s of m.steps) {
      add(mattersByStep, s.ref, m);
    }
    for (const r of matterPeopleOf(m)) {
      add(mattersByPerson, r, m);
    }
  }
  return {
    ...c,
    byId: new Map(c.lines.map((l) => [l.id, l])),
    matterSteps: new Set(c.matters.flatMap((m) => m.steps.map((s) => s.ref))),
    mattersByPerson,
    mattersByStep,
    offered: newMatterOffersOf(c),
  };
}

/** What every kind that shows no sentence of its own carries in the fields of `Said`. */
export const NO_SAID = { said: null, since: null } as const;

/** The open matters something rides on: their ids and how many. */
export const ridingOf = (matters: Iterable<MatterId> = []) => {
  const matterIds = [...matters].map((m) => m.id);
  return { matterIds, matters: matterIds.length };
};

/** What rides on a guess: the kept `lines` using it, the open matters holding one of them or one of `refs`, the pages they show on. */
export function ridesOn(c: Ctx, lines: Line[], refs: string[]) {
  const matters = new Set([
    ...lines.flatMap((l) => [...(c.mattersByStep.get(l.id) ?? [])]),
    ...refs.flatMap((r) => [...(c.mattersByPerson.get(r) ?? [])]),
  ]);
  const shownOn = new Set(
    [...refs, ...lines.flatMap((l) => [l.about ?? "", ...l.subjects])].map(
      (r) => c.people.refOf(r)
    )
  );
  return {
    ...ridingOf(matters),
    observations: lines.filter((l) => c.kept.has(l.id)).length,
    pages: [...shownOn].filter((r) => c.paged.has(r)).length,
  };
}

/** The kept lines each ref in `refsOf(line)` appears in. */
export const keptBy = (c: Ctx, refsOf: (l: Line) => string[]) => {
  const by = new Map<string, Line[]>();
  for (const l of c.lines) {
    for (const ref of c.kept.has(l.id) ? refsOf(l) : []) {
      by.set(ref, [...(by.get(ref) ?? []), l]);
    }
  }
  return by;
};

export function ranked(
  c: Ctx,
  group: Exclude<CheckGroup, "decision">,
  fields: Pick<Check, "about" | "question" | "ref"> & Partial<Check>,
  lines: Line[],
  refs: string[],
  quote: Quote | null
): Ranked[] {
  const rides = ridesOn(c, lines, refs);
  const kind = group === "ending" ? "ending" : "person";
  return rides.matters + rides.observations > 0
    ? [
        {
          check: {
            about: fields.about,
            asker: LIFE_ASKER,
            at: null,
            clips: fields.clips ?? [],
            contactsCard: fields.contactsCard,
            context: fields.context ?? LIFE_CHECKS[group].context,
            deadline: null,
            draft: null,
            goal: null,
            group,
            kind,
            likelyPeople: fields.likelyPeople ?? [],
            links: [],
            notSent: null,
            onMatters: [],
            onSilence: null,
            options: [...LIFE_CHECKS[group].options],
            preTicked: preTickedOf({ group, kind }),
            question: fields.question,
            ref: fields.ref,
            ridesOn: rides,
            said: fields.said ?? null,
            since: fields.since ?? null,
            subject: null,
            title: LIFE_CHECKS[group].title,
          },
          day: lines.reduce((m, l) => (l.date > m ? l.date : m), ""),
          quote: quote ?? undefined,
        },
      ]
    : [];
}
