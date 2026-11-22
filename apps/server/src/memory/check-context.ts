import type { CheckGroup } from "../core/names";
import { LIFE_ASKER } from "../core/names";
import type { InferredPerson } from "../records/observation";
import type { AtOrganization } from "./at-organization";
import type { Quote } from "./check-quotes";
import type { NameContext, nameGroupsOf } from "./check-sentences";
import type { Decision } from "./decision-lines";
import type { AgentHold } from "./held-matters";
import {
  type BeingFixed,
  type Check,
  LIFE_CHECKS,
  preTickedOf,
} from "./life-checks";
import {
  isAwaitingHisWord,
  type MatterStepNow,
  type MatterView,
  matterPeopleOf,
} from "./matter-read";
import { newMatterOffersOf } from "./read-matters";
import type { samePersonPairsOf } from "./same-person";
import type { GuessedQueueItem } from "./voice-guesses";
import type { People, Shown } from "./who";
import type { YourMoveInputs } from "./your-move";

// What every kind of check builder shares (`checks.ts`): the lookups made once (`Ctx`) and a guess ranked by what rides on it.

/** A kept line as the checks read it. */
export type Line = Pick<
  Shown,
  | "about"
  | "confidence"
  | "date"
  | "id"
  | "quote"
  | "speaker"
  | "subjects"
  | "text"
  | "unit"
> & { source: Pick<Shown["source"], "channel"> };

/** Where and when a record was said, in words: "whatsapp, 7 Sep". */
export type Where = string;

/** Everything the checks are worked out from; `checksNow` reads it, `checksOf` is pure over it. */
export interface CheckInputs {
  /** Refs of the fact-check answers he gave (any answer settles that line's check). */
  answered: ReadonlySet<string>;
  /** The people of his directory who may be at an organization of it (`atOrganizationPairsOf`), worked out once by the reader. */
  atOrganizations: readonly AtOrganization[];
  /** The open decisions (`decisionsNow`), each as asked by the agent holding it now, with its session (`HeldRead.cardHolders`). */
  decisions: readonly (Decision & { session?: string })[];
  /** The matters he dismissed as new matter checks, each as the steps it was pinned to (`readDismissedMatterPins`). */
  dismissed: readonly (readonly string[])[];
  /** Refs of the old doubt lines drawn before 14 Nov 2026 (stored fact checks that are not ending checks): an answer by ref would land on them. */
  doubted: ReadonlySet<string>;
  /** Each step a link ended, not yet his word (`endingsRead`): it reads probably ended until he answers. */
  endings: ReadonlyMap<string, { later: string; quote: string }>;
  /** His complaints at work with the caretaker, by the cause each names (`causeOf`): that card shows it being fixed. */
  fixing?: ReadonlyMap<string, BeingFixed>;
  /** Every registered agent's anchors as facts (host's `heldByAgents`), for the hold rule (`isHeldOf`); null while the desk is off or unreadable: then no new matter is offered. */
  heldByAgents: readonly AgentHold[] | null;
  /** Whether a matter's next step is not checked yet (`directionDueOf`, by the matter's id): none is offered while it is due. */
  isDirectionDue: (matter: string) => boolean;
  /** Whether the hand-out takes a matter (by its id): `desk.handOut` is set and it is one of his (`isOneOfHis`); it then gets no Start. */
  isForHandOut: (matter: string) => boolean;
  /** Whether a matter (by its id) is of a parked or done project (`isParkedMatterOf`): the hand-out starts none, nor is one offered, nor is his move asked. */
  isParked: (matter: string) => boolean;
  /** Every observation that shows, and the ids of those that are kept: active, at or above `KEEP_AT`. */
  kept: ReadonlySet<string>;
  lines: readonly Line[];
  matterRank?: YourMoveInputs["matterRank"];
  matters: readonly (Pick<
    MatterView,
    | "goal"
    | "id"
    | "lone"
    | "name"
    | "newestOpenStep"
    | "nextStep"
    | "open"
    | "owedTo"
    | "projects"
    | "status"
    | "waitingOn"
    | "with"
  > & {
    important?: boolean;
    openSteps?: YourMoveInputs["matters"][number]["openSteps"];
    steps: Pick<MatterStepNow, "at" | "day" | "quote" | "ref">[];
  })[];
  /** What each name check shows of its sentence, by the name's key (`readNameContexts`); a name whose unit could not be read has none. */
  nameContexts: ReadonlyMap<string, NameContext>;
  /** The names Life cannot place, one group per name (`nameGroupsOf`), worked out once by the reader. */
  nameGroups: ReturnType<typeof nameGroupsOf<Line>>;
  notNow?: YourMoveInputs["notNow"];
  paged: ReadonlySet<string>;
  people: Pick<
    People,
    | "ambiguousCards"
    | "candidatesFor"
    | "contacts"
    | "isGuess"
    | "nameOf"
    | "names"
    | "partyOf"
    | "refOf"
    | "resolve"
  > & {
    inferred: Pick<
      InferredPerson,
      | "at"
      | "confidence"
      | "evidence"
      | "id"
      | "name"
      | "namesAndHandles"
      | "relation"
    >[];
  };
  places?: YourMoveInputs["places"];
  /** The guesses that may be someone else (`samePersonPairsOf`), worked out once by the reader. */
  samePersons: ReturnType<typeof samePersonPairsOf>;
  /** The chat or thread a unit is in, by unit id: where a step was said (`to`); only the units the steps of endings and new matters are in. */
  titles: ReadonlyMap<string, string>;
  /** His day now (`dayNow`): a new matter is offered for `NEW_MATTER_DAYS` from its first step's day. */
  today: string;
  /** The voices lifelog asks him to name (`readNamingQueue`), with the voice naming's guesses (`withVoiceGuesses`). */
  voices: readonly GuessedQueueItem[];
  /** Where a record that is not a line was said: units and episodes, by id. */
  where: ReadonlyMap<string, Where>;
}

export interface Ranked {
  /** What the guess also rests on, for its cause (`causeOf`): an ending's later step. */
  basis?: string;
  check: Omit<Check, "confirm" | "lifeLinks" | "matter">;
  /** For the order (`inboxOrderOf`): when a decision was asked, else the newest day among the lines it rides on; a decision's `matter` as its ask resolved it, the finder's pick on a tie. */
  day: string;
  matter?: string;
  /** For the order: a your move card's matter's place in his ranking (`YourMoveInputs.matterRank`). */
  matterRank?: number;
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
  for (const m of c.matters.filter(isAwaitingHisWord)) {
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
