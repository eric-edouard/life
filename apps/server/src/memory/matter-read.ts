import { DAY, daysBefore } from "../core/clock";
import type { Episode } from "../records/episode";
import {
  entryLine,
  isListed,
  type LedgerEntry,
  stands,
} from "../records/ledger-entry";
import {
  type DirectionPin,
  LATER_SHOWN,
  type Matter,
  type NextStep,
} from "../records/matter";
import type { Observation } from "../records/observation";
import { KEEP_AT, TOP_AT } from "../records/unit";
import {
  isOpenTodoItem,
  type LedgerTodoItem,
} from "../todo-list/todo-items-from-ledger";
import { OWNER } from "./read-truth";
import { dayStart, localDate } from "./zones";

// A matter as it reads now (docs/glossary.md: matter, matter status): everything about it is worked out here from the
// stored line (its steps, `matters.ts`) and the records as they stand, never stored. One rule for "open": a matter is
// open while any of its to-dos, promises or waits has no ending; one with none of them (a trip, an event) is open until
// it has been quiet `QUIET_DAYS` past its last step and date. A lone open observation or to-do item that no matter holds
// is a matter of one.

const STATUSES = [
  "done",
  "probably_done",
  "waiting_on_someone",
  "moving",
  "stuck",
  "dormant",
] as const;
type MatterStatus = (typeof STATUSES)[number];

/** A step in this many days or less: the matter is moving. */
const MOVING_DAYS = 14;
/** An open step's date passed this many days ago or less: the matter is stuck; an older one has no say. */
const STUCK_DAYS = 30;
/** A matter with nothing to do is done once its last step and every date are this many days past. */
const QUIET_DAYS = 7;

type StepObservation = Pick<
  Observation,
  | "area"
  | "at"
  | "date"
  | "id"
  | "importance"
  | "modality"
  | "quote"
  | "speaker"
  | "subjects"
  | "text"
  | "type"
  | "unit"
  | "when"
>;
type StepTodoItem = Pick<
  LedgerTodoItem,
  "at" | "closedAt" | "fields" | "key" | "ref"
>;
type Line = Pick<Matter, "areas" | "id" | "name" | "projects"> & {
  steps: Pick<Matter["steps"][number], "ref">[];
};

/** The records a matter's steps are read from, as they stand today. */
export interface MatterRecords {
  /** Every record id as it stands now: observations and episodes (what a link's two ends must be). */
  current: ReadonlySet<string>;
  /** The directions pinned to matters' steps: Life's drafts (memory/matter-directions.jsonl) and his word (`matter-direction`). */
  directions: readonly DirectionPin[];
  /** Each unit's episode (`readBy`). */
  episodeOf: ReadonlyMap<string, Episode>;
  /** A person ref that is a mail sender no one answers: a no-reply address or his agents' reports (`isMailerHandle`). */
  isMailer: (ref: string) => boolean;
  ledger: readonly LedgerEntry[];
  /** The links' endings not yet his word (`endingsRead`), by the observation they end: it ends "probably". `at`: the later record's instant. */
  linkEndings: ReadonlyMap<
    string,
    { at: string; later: string; quote: string }
  >;
  observations: readonly StepObservation[];
  /** Who a person ref is as of today (`People.refOf`). */
  refOf: (ref: string) => string;
  /** The observations that ended for sure, by id: replaced by a newer one (`replacedBy`) or said outdated (`why`, his or an agent's note); `at`, the instant of that evidence. */
  retired: ReadonlyMap<
    string,
    { at: string; replacedBy?: string; why: string }
  >;
  /** Every to-do item the ledger holds, open or not. */
  todoItems: readonly StepTodoItem[];
}

/** A matter's goal or next step as it reads now, who said it (Life's draft or his word) and when. */
export type ByWhom<T> = T & { at: string; by: "life" | "owner" };

/** How a step ended, and when (`at`, the instant of the evidence, never of the run that found it): its observation retired (replaced, or a word that it is done), its to-do item ticked or removed, or a link (`quote`: the later step's words), not yet his word. */
type StepEnding = { at: string } & (
  | { by: "record"; replacedBy?: string; why: string }
  | { by: "ticked" }
  | { by: "link"; quote: string }
);

export interface MatterStepNow {
  at: string;
  day: string;
  /** How it ended; none while it is open (or for an episode or a list entry, which never end). */
  ending?: StepEnding;
  kind: "episode" | "ledger" | "todo_item" | Observation["type"];
  priority?: string;
  quote: string;
  ref: string;
  text: string;
  urgent?: boolean;
  when?: string;
  /** The one person a step is with: an observation's speaker when not him, else the first person it names; an episode's first person taking part. */
  with?: string;
}

export interface MatterView {
  areas: string[];
  /** The records its latest direction cites as showing it over (a "looks over" draft has no `nextStep`); within the links step's reach (`isOutOfReach`). */
  endingRecords?: readonly string[];
  /** Where it is going (`directionsOf`); none until Life drafts one or he says it. */
  goal?: ByWhom<{ text: string }>;
  /** An open step he said himself: his to-do item, or an observation he spoke (`isOneOfHis`). */
  hasOwnOpenStep: boolean;
  id: string;
  /** A matter of one: no matter line holds its record. */
  lone: boolean;
  name: string;
  /** The newest open step: a record, never what to do (that is `nextStep`). */
  newestOpenStep?: MatterStepNow;
  /** What moves it now (`directionsOf`); none until Life drafts one or he says it. */
  nextStep?: ByWhom<NextStep>;
  open: boolean;
  /** Its to-dos, promises, waits and to-do items with no ending, oldest first. */
  openSteps: MatterStepNow[];
  /** Whom he owes: who asked, or whom he promised. */
  owedTo: string[];
  projects: string[];
  status: MatterStatus;
  steps: MatterStepNow[];
  waitingOn: string[];
  /** Every other person its current steps are with (`matterOf`): its open steps, or every step of one with nothing to do. */
  with: string[];
}

/** The steps that can be open: a to-do, a promise, a wait, a to-do item. */
export const ACTIONABLE: MatterStepNow["kind"][] = [
  "promise",
  "to_do",
  "todo_item",
  "waiting_on_someone",
];
const isPerson = (r: string) =>
  r.startsWith("person:") || r.startsWith("unknown:");
const uniq = <T>(list: T[]) => [...new Set(list)];
export const daysFrom = (from: string, to: string) =>
  Math.round((Date.parse(to) - Date.parse(from)) / DAY);
/** An episode's instant, like an observation's: its local start in the zone of that day, else the day's start (before the day's timed steps). */
export const episodeAt = (m: Pick<Episode, "day" | "start">) =>
  dayStart(m.day, undefined, m.start?.slice(11, 16) || undefined)
    .toISOString()
    .replace(".000", "");
/** Whether a step ended. */
export const isEnded = (s: Pick<MatterStepNow, "ending">) =>
  s.ending !== undefined;
const isOpenStep = (s: MatterStepNow) =>
  ACTIONABLE.includes(s.kind) && !isEnded(s);
/** Whether a step still waits on his word to end: open, or ended only by a link ("probably", until his word). */
export const isOpenUntilHisWord = (s: MatterStepNow) =>
  isOpenStep(s.ending?.by === "link" ? { ...s, ending: undefined } : s);

/** The lookups over the records, built once for every matter. `offered`: every record a matters call was shown (`mattersNow`). */
function indexOf(rec: MatterRecords, offered: ReadonlySet<string>) {
  return {
    byId: new Map(rec.observations.map((o) => [o.id, o])),
    byRef: Map.groupBy(
      rec.todoItems.filter((t) => t.ref),
      (t) => t.ref as string
    ),
    byUnit: Map.groupBy(rec.observations, (o) => o.unit),
    offered,
    rec,
    todo: new Map(rec.todoItems.map((t) => [t.key, t])),
  };
}
type Index = ReturnType<typeof indexOf>;

/** The records a matter line names: the episodes holding its unit steps (an observation step is itself and brings none), the observations (any placed, and those at `KEEP_AT` or more of its units that no matters call was shown: one it was shown and left out stays out), the to-do items (placed, or made from one of those observations). */
function recordsOf(line: Line, ix: Index) {
  const episodes = new Map<string, Episode>();
  const observations = new Map<string, StepObservation>();
  const items = new Map<string, StepTodoItem>();
  for (const { ref } of line.steps) {
    const observation = ix.byId.get(ref);
    // A unit step is a unit's ref and brings its episode; an observation step is the step itself.
    const episode = observation ? undefined : ix.rec.episodeOf.get(ref);
    const item = ix.todo.get(ref);
    if (episode) {
      episodes.set(episode.id, episode);
    }
    for (const o of ix.byUnit.get(ref) ?? []) {
      if (o.importance >= KEEP_AT && !ix.offered.has(o.id)) {
        observations.set(o.id, o);
      }
    }
    if (observation) {
      observations.set(ref, observation);
    }
    if (item) {
      items.set(ref, item);
    }
  }
  for (const id of observations.keys()) {
    for (const item of ix.byRef.get(id) ?? []) {
      items.set(item.key, item);
    }
  }
  return {
    episodes: [...episodes.values()],
    items: [...items.values()],
    observations: [...observations.values()],
  };
}

/** Where a matter stands on `today`: done when ended, probably done when a link ended one of its steps; stuck when the newest open step's date has passed, or another open step's within `STUCK_DAYS`; waiting when the newest open step is a wait (never the drafted `nextStep`); moving with a step in `MOVING_DAYS`; else dormant. Silence alone is never stuck. */
function statusOf(
  open: boolean,
  steps: MatterStepNow[],
  newestOpen: MatterStepNow | undefined,
  today: string
): MatterStatus {
  if (!open) {
    return steps.some((s) => s.ending?.by === "link")
      ? "probably_done"
      : "done";
  }
  const passed = (s: MatterStepNow) => Boolean(s.when && s.when < today);
  if (
    (newestOpen && passed(newestOpen)) ||
    steps.some(
      (s) =>
        isOpenStep(s) &&
        passed(s) &&
        daysFrom(s.when as string, today) <= STUCK_DAYS
    )
  ) {
    return "stuck";
  }
  if (newestOpen?.kind === "waiting_on_someone") {
    return "waiting_on_someone";
  }
  const newest = steps.at(-1) as MatterStepNow;
  return daysFrom(newest.day, today) <= MOVING_DAYS ? "moving" : "dormant";
}

/** How a step ended, as the records say now: an observation retired or found ended by a link, a to-do item ticked. */
function endingOf(ref: string, rec: MatterRecords): StepEnding | undefined {
  const retired = rec.retired.get(ref);
  if (retired) {
    return { by: "record", ...retired };
  }
  const link = rec.linkEndings.get(ref);
  return link && { at: link.at, by: "link", quote: link.quote };
}

/** The steps of a matter's records, in time order. */
function stepsOf(
  { episodes, items, observations }: ReturnType<typeof recordsOf>,
  rec: MatterRecords
): MatterStepNow[] {
  const isSomeone = (r: string) =>
    r !== OWNER && isPerson(r) && !rec.isMailer(r);
  const person = (o: StepObservation) =>
    [o.speaker, ...o.subjects.filter((s) => s !== o.speaker)].find(isSomeone);
  const held = new Set(observations.map((o) => o.id));
  const made = new Set(items.map((t) => t.key));
  return [
    ...episodes.map(
      (m): MatterStepNow => ({
        at: episodeAt(m),
        day: (m.start ?? m.day).slice(0, 10),
        kind: "episode",
        quote: m.what,
        ref: m.id,
        text: m.title,
        with: m.people.find((p) => p.role !== "told" && isSomeone(p.ref))?.ref,
      })
    ),
    ...observations.map(
      (o): MatterStepNow => ({
        at: o.at,
        day: o.date,
        ending: endingOf(o.id, rec),
        kind: o.type,
        quote: o.quote,
        ref: o.id,
        text: o.text,
        when: o.when ?? undefined,
        with: person(o),
      })
    ),
    ...items.map(({ at, closedAt, fields: f, key }): MatterStepNow => {
      const title = String(f.title ?? "");
      return {
        at,
        day: localDate(at),
        ending: isOpenTodoItem({ fields: f })
          ? undefined
          : { at: closedAt ?? at, by: "ticked" },
        kind: "todo_item",
        priority: (f.priority as string | null) ?? undefined,
        quote: title,
        ref: key,
        text: title,
        urgent: Boolean(f.urgent || f.flagged),
        when: f.due ? `${f.due}`.slice(0, 10) : undefined,
      };
    }),
    ...rec.ledger
      .filter(
        (a) =>
          isListed(a) &&
          stands(a) &&
          a.instruction &&
          held.has(a.instruction.ref) &&
          !made.has(a.id)
      )
      .map(
        (a): MatterStepNow => ({
          at: a.at,
          day: localDate(a.at),
          kind: "ledger",
          quote: a.instruction?.quote ?? "",
          ref: a.id,
          text: entryLine(a),
        })
      ),
  ].toSorted((a, b) => a.day.localeCompare(b.day) || a.at.localeCompare(b.at));
}

/** Whether a matter with nothing to do is still going on `today`: a step or a date within `QUIET_DAYS`. */
const isGoingOn = (steps: MatterStepNow[], today: string) =>
  steps.some(
    (s) =>
      daysFrom(s.day, today) <= QUIET_DAYS ||
      (s.when !== undefined && daysFrom(s.when, today) <= QUIET_DAYS)
  );

/**
 * One matter as it reads on `today` (a day): its steps in time order (`stepsOf`), whether it is open, its people by
 * role, projects and areas, matter status and newest open step. Null when none of its records is left. Pure.
 */
export function matterOf(
  line: Line,
  ix: Index,
  today: string,
  lone = false
): MatterView | null {
  const { rec } = ix;
  const records = recordsOf(line, ix);
  const steps = stepsOf(records, rec);
  const newest = steps.at(-1);
  if (!newest) {
    return null;
  }
  const openSteps = steps.filter(isOpenStep);
  const hasAction = steps.some((s) => ACTIONABLE.includes(s.kind));
  const open = hasAction ? openSteps.length > 0 : isGoingOn(steps, today);
  const newestOpenStep = openSteps.at(-1);
  // Its people are where it stands now: the people its open steps are with (every step's, for one with nothing to do,
  // by the rule of `open`). History stays on the steps; an episode's cast (a sitting, on any subject) never counts.
  const current = hasAction ? openSteps : steps;
  const roleOf = (isRole: (s: MatterStepNow) => boolean) =>
    uniq(
      current.flatMap((s) => (s.with && isRole(s) ? [rec.refOf(s.with)] : []))
    );
  // A to-do is owed to its person only when that person asked it (its speaker), never to whom his own or his agent's names.
  const owedTo = roleOf(
    (s) =>
      s.kind === "promise" ||
      (s.kind === "to_do" && ix.byId.get(s.ref)?.speaker === s.with)
  );
  const waitingOn = roleOf((s) => s.kind === "waiting_on_someone");
  return {
    areas: uniq([
      ...line.areas,
      ...records.observations.flatMap((o) => (o.area ? [o.area] : [])),
    ]),
    hasOwnOpenStep: openSteps.some(
      (s) => s.kind === "todo_item" || ix.byId.get(s.ref)?.speaker === OWNER
    ),
    id: line.id,
    lone,
    name: line.name,
    newestOpenStep,
    open,
    openSteps,
    owedTo,
    projects: uniq([
      ...line.projects,
      ...records.observations.flatMap((o) =>
        o.subjects
          .filter((s) => s.startsWith("project:"))
          .map((s) => s.slice(8))
      ),
    ]),
    status: statusOf(open, steps, newestOpenStep, today),
    steps,
    waitingOn,
    with: roleOf(() => true).filter(
      (r) => !(owedTo.includes(r) || waitingOn.includes(r))
    ),
  };
}

/** Everyone a matter involves, by role: whom he owes, whom he waits on, who else is with it. */
export const matterPeopleOf = (
  v: Pick<MatterView, "owedTo" | "waitingOn" | "with">
) => uniq([...v.owedTo, ...v.waitingOn, ...v.with]);

/** Running: open and not dormant. What `read_matters` lists. */
export const isRunning = (v: Pick<MatterView, "open" | "status">) =>
  v.open && v.status !== "dormant";

/** What a lone observation is: his own promise, wait or to-do, at the top importance. */
const isOpenKind = (o: StepObservation) =>
  o.importance === TOP_AT &&
  (o.type === "promise" ||
    o.type === "waiting_on_someone" ||
    (o.type === "to_do" && o.speaker === OWNER));

/** What a matter is to its finder: its id and its steps' ids. */
interface Found {
  id: string;
  steps: readonly { ref: string }[];
}

/**
 * The finder of the matter `refs` name, over `book`: the one holding the most of them (as its id or its steps' ids: a
 * unit can be a step of several matters), on a tie the one with the fewest steps (a matter inside a bigger one keeps
 * its own), then the first holder of the earliest ref (an agent's anchors, a pinned direction, a single id). Pure;
 * built once for many lookups.
 */
export function matterFinderOf<V extends Found>(book: readonly V[]) {
  const holders = new Map<string, V[]>();
  for (const v of book) {
    for (const ref of new Set([v.id, ...v.steps.map((s) => s.ref)])) {
      const held = holders.get(ref) ?? [];
      held.push(v);
      holders.set(ref, held);
    }
  }
  return (refs: readonly string[]) => {
    const held = new Map<V, number>();
    for (const ref of new Set(refs)) {
      for (const v of holders.get(ref) ?? []) {
        held.set(v, (held.get(v) ?? 0) + 1);
      }
    }
    let best: [V, number] | undefined;
    for (const [v, n] of held) {
      if (
        !best ||
        n > best[1] ||
        (n === best[1] && v.steps.length < best[0].steps.length)
      ) {
        best = [v, n];
      }
    }
    return best?.[0];
  };
}

/** The matter `refs` name (`matterFinderOf`), for one lookup. */
export const matterOfSteps = <V extends Found>(
  book: readonly V[],
  refs: readonly string[]
) => matterFinderOf(book)(refs);

/** Whether `v` got a step, or a step's ending, that `pin` was not drafted on: its next step is then out of date. Pure. */
const isNewerThan = (
  v: { steps: readonly MatterStepNow[] },
  pin: DirectionPin
) =>
  v.steps.some(
    (s) => !pin.steps.includes(s.ref) || (s.ending && s.ending.at > pin.at)
  );

/** How many days from its first step a new matter is offered: Life's "Start an agent on this?" lapses after them, and nothing starts. */
export const NEW_MATTER_DAYS = 7;
/** The last day of a matter's offer window (`NEW_MATTER_DAYS` from its first step's day); none for a matter with no step. Pure. */
export const offerEndOf = (v: { steps: readonly { day: string }[] }) => {
  const [first] = v.steps;
  return first && daysBefore(first.day, 1 - NEW_MATTER_DAYS);
};

type LaterObservation = Pick<
  Observation,
  "at" | "date" | "id" | "modality" | "speaker" | "subjects" | "type"
>;

/**
 * A matter's later records beyond its own steps: its people's observations (speaker or a subject, as `refOf` reads
 * them now) from its oldest open step's day on, however late (a wait is answered when it is), that are not `isHeld`,
 * never a plan, a condition or a promise, wait or to-do. The one selection of "what happened since": the links step
 * (`isHeld`: `isOutOfReach`), the directions and the new matter check (`isHeld`: its own steps). No cap: each links pair
 * is asked once per prompt, so a night asks only what is new.
 */
export function laterRecordsOf<T extends LaterObservation>(
  open: readonly MatterStepNow[],
  people: ReadonlySet<string>,
  observations: readonly T[],
  isHeld: (id: string) => boolean,
  refOf: (ref: string) => string
) {
  const [from] = open.map((s) => s.day).toSorted();
  if (!from) {
    return [];
  }
  return observations.filter(
    (o) =>
      o.date >= from &&
      !isHeld(o.id) &&
      !ACTIONABLE.includes(o.type) &&
      o.modality !== "plan" &&
      o.modality !== "conditional" &&
      [o.speaker, ...o.subjects].some((r) => people.has(refOf(r)))
  );
}

/** The newest `LATER_SHOWN` of `v`'s later records from outside it (`laterRecordsOf`: all but its own steps), oldest first: what its direction is drafted against. Pure. */
export function laterShownOf<T extends LaterObservation>(
  v: Pick<MatterView, "openSteps" | "owedTo" | "steps" | "waitingOn" | "with">,
  observations: readonly T[],
  refOf: (ref: string) => string
) {
  const own = new Set(v.steps.map((s) => s.ref));
  return laterRecordsOf(
    v.openSteps,
    new Set(matterPeopleOf(v)),
    observations,
    (id) => own.has(id),
    refOf
  )
    .toSorted((a, b) => a.at.localeCompare(b.at))
    .slice(-LATER_SHOWN);
}

/**
 * Each matter's goal and next step from the pins as written (`directionsOf`): a pin belongs to the matter its steps find
 * (`matterFinderOf`), so a re-group keeps it. The goal: his latest word, else Life's latest draft. The next step: the
 * latest pin's, his or Life's (a Life draft replaces it even with none: the matter looks over); Life drafts again once
 * `isDirectionDue`. Pure.
 */
export function directionsOf<V extends Found>(
  book: readonly V[],
  pins: readonly DirectionPin[]
) {
  const find = matterFinderOf(book);
  const out = new Map<
    V,
    Pick<MatterView, "goal" | "nextStep"> & { latest?: DirectionPin }
  >();
  for (const p of pins.toSorted((a, b) => a.at.localeCompare(b.at))) {
    const v = find(p.steps);
    if (!v) {
      continue;
    }
    const was = out.get(v) ?? {};
    out.set(v, {
      goal:
        p.goal && !(was.goal?.by === "owner" && p.by === "life")
          ? { at: p.at, by: p.by, text: p.goal }
          : was.goal,
      ...(p.nextStep || p.by === "life"
        ? {
            latest: p,
            nextStep: p.nextStep && { ...p.nextStep, at: p.at, by: p.by },
          }
        : { latest: was.latest, nextStep: was.nextStep }),
    });
  }
  return out;
}

/**
 * Whether Life drafts `v`'s direction: running and grouped, with none yet or a step newer than its latest pin; or, when
 * that pin is Life's, a blind one (no `laterShown`: drafted before it saw later records) or, while `v` is in its offer
 * window (`offerEndOf`), one of its newest later records (`later`, read only then) that the draft was not shown. His own
 * pin is never redrafted over an outside record. Pure.
 */
export const isDirectionDue = (
  v: MatterView,
  latest: DirectionPin | undefined,
  later: () => readonly string[],
  today: string
) => {
  if (v.lone || !isRunning(v)) {
    return false;
  }
  if (!(latest && v.goal) || isNewerThan(v, latest)) {
    return true;
  }
  const end = offerEndOf(v);
  const { laterShown } = latest;
  return (
    latest.by === "life" &&
    (!laterShown ||
      Boolean(
        end && today <= end && later().some((id) => !laterShown.includes(id))
      ))
  );
};

/**
 * The test of "which matters of `book` are due a direction" (`isDirectionDue`), by matter id: for the night's step and
 * the new matter check. The later records are read (`laterShownOf`) only for a matter in its offer window whose latest
 * pin is Life's. Pure.
 */
export function directionDueOf(
  book: readonly MatterView[],
  rec: Pick<MatterRecords, "directions" | "observations" | "refOf">,
  today: string
) {
  const directions = directionsOf(book, rec.directions);
  const byId = new Map(book.map((v) => [v.id, v]));
  return (id: string) => {
    const v = byId.get(id);
    return (
      v !== undefined &&
      isDirectionDue(
        v,
        directions.get(v)?.latest,
        () => laterShownOf(v, rec.observations, rec.refOf).map((o) => o.id),
        today
      )
    );
  };
}

/** How many of a matter's newest steps its net compares with. */
const NET_STEPS = 8;

/**
 * A matter's net (the desk's wide net, `desk/matter-net.ts`): who it is with in any role, and the texts a new message
 * or recording is compared with in meaning: its name and goal, its next step, its newest steps' words. Pure.
 */
export const netOf = (v: MatterView) => ({
  people: new Set(matterPeopleOf(v)),
  texts: [
    v.goal ? `${v.name}: ${v.goal.text}` : v.name,
    ...(v.nextStep ? [v.nextStep.text] : []),
    ...v.steps.slice(-NET_STEPS).map((s) => s.text),
  ],
});

/**
 * `v`'s next step as it reads now: waiting on his decision while one he has not answered is about one of its steps
 * (`wait_decision`, never stored), else its `nextStep`. Pure.
 */
export function nextStepNow(
  v: Pick<MatterView, "nextStep"> & { steps: readonly { ref: string }[] },
  openDecisions: readonly { question: string; subject?: string }[]
):
  | (Omit<NextStep, "kind"> & {
      by?: "life" | "owner";
      kind: NextStep["kind"] | "wait_decision";
    })
  | undefined {
  const refs = new Set(v.steps.map((s) => s.ref));
  const d = openDecisions.find((x) => x.subject && refs.has(x.subject));
  return d
    ? {
        kind: "wait_decision" as const,
        text: d.question,
        waitsOn: "his decision",
      }
    : v.nextStep;
}

/**
 * Every matter as it reads on `today`, the newest step first: the stored ones (`mattersNow`'s), then a matter of one for each
 * open observation and open to-do item no matter holds (a to-do item made from an observation joins it). Pure.
 */
export function matterBookOf(
  {
    matters: lines,
    offered,
  }: { matters: readonly Line[]; offered: ReadonlySet<string> },
  rec: MatterRecords,
  today: string
) {
  const ix = indexOf(rec, offered);
  const views = lines.flatMap((l) => matterOf(l, ix, today) ?? []);
  const held = new Set(views.flatMap((v) => v.steps.map((s) => s.ref)));
  const lone = (id: string, name: string) => {
    const view = matterOf(
      {
        areas: [],
        id,
        name: name.slice(0, 120),
        projects: [],
        steps: [{ ref: id }],
      },
      ix,
      today,
      true
    );
    for (const s of view?.steps ?? []) {
      held.add(s.ref);
    }
    return view?.open ? [view] : [];
  };
  const loneObservations = rec.observations
    .filter((o) => isOpenKind(o) && !held.has(o.id) && !rec.retired.has(o.id))
    .flatMap((o) => lone(o.id, o.text));
  const loneItems = rec.todoItems
    .filter((t) => isOpenTodoItem(t) && !held.has(t.key))
    .flatMap((t) => lone(t.key, String(t.fields.title ?? "")));
  const book = [...views, ...loneObservations, ...loneItems];
  const directions = directionsOf(book, rec.directions);
  return book
    .map((v) => {
      const d = directions.get(v);
      return d
        ? {
            ...v,
            ...(d.goal ? { goal: d.goal } : {}),
            ...(d.nextStep ? { nextStep: d.nextStep } : {}),
            ...(d.latest?.endingRecords
              ? { endingRecords: d.latest.endingRecords }
              : {}),
          }
        : v;
    })
    .toSorted((a, b) =>
      (b.steps.at(-1)?.day ?? "").localeCompare(a.steps.at(-1)?.day ?? "")
    );
}

/**
 * The matters that ended on `day` (a local day), by their steps: closed, and the newest ending among their to-dos,
 * promises, waits and to-do items falls on it. A trip done by quiet has no ending and is not listed. Each with that last
 * step, to say how it ended. Pure.
 */
export function doneOnOf(
  book: readonly MatterView[],
  day: string,
  dayOf: (at: string) => string
) {
  return book.flatMap((v) => {
    const last = v.open
      ? undefined
      : v.steps
          .filter((s) => ACTIONABLE.includes(s.kind) && s.ending)
          .toSorted((a, b) =>
            (a.ending?.at ?? "").localeCompare(b.ending?.at ?? "")
          )
          .at(-1);
    return last?.ending && dayOf(last.ending.at) === day
      ? [{ last, matter: v }]
      : [];
  });
}
