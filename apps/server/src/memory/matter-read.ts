import { DAY } from "../core/clock";
import type { Episode } from "../records/episode";
import {
  entryLine,
  isListed,
  type LedgerEntry,
  stands,
} from "../records/ledger-entry";
import type { Matter } from "../records/matter";
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
// open while its newest to-do, promise or wait has no ending. A lone open observation or to-do item that no matter
// holds is a matter of one.

const STATUSES = [
  "done",
  "waiting_on_someone",
  "moving",
  "stuck",
  "dormant",
] as const;
type MatterStatus = (typeof STATUSES)[number];

/** A step in this many days or less: the matter is moving. */
const MOVING_DAYS = 14;

type StepObservation = Pick<
  Observation,
  | "area"
  | "at"
  | "date"
  | "id"
  | "importance"
  | "quote"
  | "speaker"
  | "subjects"
  | "text"
  | "type"
  | "unit"
  | "when"
>;
type StepTodoItem = Pick<LedgerTodoItem, "at" | "fields" | "key" | "ref">;
type Line = Pick<Matter, "areas" | "id" | "name" | "projects"> & {
  steps: Pick<Matter["steps"][number], "ref">[];
};

/** The records a matter's steps are read from, as they stand today. */
export interface MatterRecords {
  /** Every record id as it stands now: observations and episodes (what a link's two ends must be). */
  current: ReadonlySet<string>;
  /** The observations that ended: retired, replaced by a newer one or said outdated. */
  endings: ReadonlySet<string>;
  /** Each unit's episode (`readBy`). */
  episodeOf: ReadonlyMap<string, Episode>;
  ledger: readonly LedgerEntry[];
  /** The links' endings not yet his word (`endingsRead`), by the observation they end: shown "maybe done", ending nothing. */
  maybe: ReadonlyMap<string, { quote: string }>;
  observations: readonly StepObservation[];
  /** Who a person ref is as of today (`People.refOf`). */
  refOf: (ref: string) => string;
  /** Every to-do item the ledger holds, open or not. */
  todoItems: readonly StepTodoItem[];
}

export interface MatterStepNow {
  at: string;
  day: string;
  /** Whether it ended: an observation by a link, a to-do item by being ticked or removed. */
  ended: boolean;
  kind: "episode" | "ledger" | "todo_item" | Observation["type"];
  /** The words of a later step a link found to end it, not yet his word. */
  maybe?: string;
  priority?: string;
  quote: string;
  ref: string;
  text: string;
  urgent?: boolean;
  when?: string;
  /** The person a to-do, promise or wait is with: its speaker when not him, else the first person it names. */
  with?: string;
}

export interface MatterView {
  areas: string[];
  id: string;
  /** A matter of one: no matter line holds its record. */
  lone: boolean;
  /** The words that show its next step maybe done (a link, not yet his word); the matter stays open. */
  maybe?: string;
  name: string;
  /** The newest open step: what is next. */
  next?: MatterStepNow;
  open: boolean;
  /** Whom he owes: who asked, or whom he promised. */
  owedTo: string[];
  projects: string[];
  status: MatterStatus;
  steps: MatterStepNow[];
  told: string[];
  waitingOn: string[];
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

/** The lookups over the records, built once for every matter. `placed`: the observations some matter line names. */
function indexOf(rec: MatterRecords, placed: ReadonlySet<string>) {
  return {
    byId: new Map(rec.observations.map((o) => [o.id, o])),
    byRef: Map.groupBy(
      rec.todoItems.filter((t) => t.ref),
      (t) => t.ref as string
    ),
    byUnit: Map.groupBy(rec.observations, (o) => o.unit),
    placed,
    rec,
    todo: new Map(rec.todoItems.map((t) => [t.key, t])),
  };
}
type Index = ReturnType<typeof indexOf>;

/** The records a matter line names: the episodes holding its units (and those of its placed observations), the observations (any placed, and those at `KEEP_AT` or more of its units), the to-do items (placed, or made from one of those observations). */
function recordsOf(line: Line, ix: Index) {
  const episodes = new Map<string, Episode>();
  const observations = new Map<string, StepObservation>();
  const items = new Map<string, StepTodoItem>();
  for (const { ref } of line.steps) {
    const observation = ix.byId.get(ref);
    // A unit step is a unit's ref; an observation step brings the episode of its unit.
    const episode = ix.rec.episodeOf.get(observation?.unit ?? ref);
    const item = ix.todo.get(ref);
    if (episode) {
      episodes.set(episode.id, episode);
    }
    for (const o of ix.byUnit.get(ref) ?? []) {
      if (o.importance >= KEEP_AT && !ix.placed.has(o.id)) {
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

/** Where a matter stands on `today`: done when ended; stuck when an open step's date has passed; waiting when the next step is a wait; moving with a step in `MOVING_DAYS`; else dormant. Silence alone is never stuck. */
function statusOf(
  open: boolean,
  openSteps: MatterStepNow[],
  next: MatterStepNow | undefined,
  newest: MatterStepNow,
  today: string
): MatterStatus {
  if (!open) {
    return "done";
  }
  if (openSteps.some((s) => s.when && s.when < today)) {
    return "stuck";
  }
  if (next?.kind === "waiting_on_someone") {
    return "waiting_on_someone";
  }
  return daysFrom(newest.day, today) <= MOVING_DAYS ? "moving" : "dormant";
}

/** The steps of a matter's records, in time order. */
function stepsOf(
  { episodes, items, observations }: ReturnType<typeof recordsOf>,
  rec: MatterRecords
): MatterStepNow[] {
  const person = (o: StepObservation) =>
    [o.speaker, ...o.subjects.filter((s) => s !== o.speaker)].find(
      (r) => r !== OWNER && isPerson(r)
    );
  const held = new Set(observations.map((o) => o.id));
  const made = new Set(items.map((t) => t.key));
  return [
    ...episodes.map(
      (m): MatterStepNow => ({
        // An instant, like the others: its local start in the zone of that day, else the day's start (before the day's timed steps).
        at: dayStart(m.day, undefined, m.start?.slice(11, 16) || undefined)
          .toISOString()
          .replace(".000", ""),
        day: (m.start ?? m.day).slice(0, 10),
        ended: false,
        kind: "episode",
        quote: m.what,
        ref: m.id,
        text: m.title,
      })
    ),
    ...observations.map(
      (o): MatterStepNow => ({
        at: o.at,
        day: o.date,
        ended: rec.endings.has(o.id),
        kind: o.type,
        maybe: rec.maybe.get(o.id)?.quote,
        quote: o.quote,
        ref: o.id,
        text: o.text,
        when: o.when ?? undefined,
        with: person(o),
      })
    ),
    ...items.map(({ at, fields: f, key }): MatterStepNow => {
      const title = String(f.title ?? "");
      return {
        at,
        day: localDate(at),
        ended: !isOpenTodoItem({ fields: f }),
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
          ended: false,
          kind: "ledger",
          quote: a.instruction?.quote ?? "",
          ref: a.id,
          text: entryLine(a),
        })
      ),
  ].toSorted((a, b) => a.day.localeCompare(b.day) || a.at.localeCompare(b.at));
}

/**
 * One matter as it reads on `today` (a day): its steps in time order (`stepsOf`), whether it is open, its people by
 * role, projects and areas, matter status and next step. Null when none of its records is left. Pure.
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
  const actionable = steps.filter((s) => ACTIONABLE.includes(s.kind));
  const last = actionable.at(-1);
  const open = !last?.ended;
  const next = open ? last : undefined;
  const openSteps = open ? actionable.filter((s) => !s.ended) : [];
  const roleOf = (
    kinds: MatterStepNow["kind"][],
    byOthers: (s: MatterStepNow) => boolean = () => true
  ) =>
    uniq(
      openSteps.flatMap((s) =>
        s.with && kinds.includes(s.kind) && byOthers(s)
          ? [rec.refOf(s.with)]
          : []
      )
    );
  const peopleOf = (...roles: string[]) =>
    uniq(
      records.episodes.flatMap((m) =>
        m.people
          .filter((p) => roles.includes(p.role))
          .map((p) => rec.refOf(p.ref))
          .filter((r) => r !== OWNER)
      )
    );
  return {
    areas: uniq([
      ...line.areas,
      ...records.observations.flatMap((o) => (o.area ? [o.area] : [])),
    ]),
    id: line.id,
    lone,
    maybe: next?.maybe,
    name: line.name,
    next,
    open,
    owedTo: roleOf(
      ["promise", "to_do"],
      (s) => s.kind !== "to_do" || ix.byId.get(s.ref)?.speaker !== OWNER
    ),
    projects: uniq([
      ...line.projects,
      ...records.observations.flatMap((o) =>
        o.subjects
          .filter((s) => s.startsWith("project:"))
          .map((s) => s.slice(8))
      ),
    ]),
    status: statusOf(open, openSteps, next, newest, today),
    steps,
    told: peopleOf("told"),
    waitingOn: roleOf(["waiting_on_someone"]),
    with: peopleOf("with", "organizer"),
  };
}

/** Running: open and not dormant. What the matters step shows the model and what `read_matters` lists. */
export const isRunning = (v: Pick<MatterView, "open" | "status">) =>
  v.open && v.status !== "dormant";

/** What a lone observation is: his own promise, wait or to-do, at the top importance. */
const isOpenKind = (o: StepObservation) =>
  o.importance === TOP_AT &&
  (o.type === "promise" ||
    o.type === "waiting_on_someone" ||
    (o.type === "to_do" && o.speaker === OWNER));

/**
 * Every matter as it reads on `today`, the newest step first: the stored ones (`lines`), then a matter of one for each
 * open observation and open to-do item no matter holds (a to-do item made from an observation joins it). Pure.
 */
export function matterBookOf(
  lines: readonly Line[],
  rec: MatterRecords,
  today: string
) {
  const ix = indexOf(
    rec,
    new Set(lines.flatMap((l) => l.steps.map((s) => s.ref)))
  );
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
    .filter((o) => isOpenKind(o) && !held.has(o.id) && !rec.endings.has(o.id))
    .flatMap((o) => lone(o.id, o.text));
  const loneItems = rec.todoItems
    .filter((t) => isOpenTodoItem(t) && !held.has(t.key))
    .flatMap((t) => lone(t.key, String(t.fields.title ?? "")));
  return [...views, ...loneObservations, ...loneItems].toSorted((a, b) =>
    (b.steps.at(-1)?.day ?? "").localeCompare(a.steps.at(-1)?.day ?? "")
  );
}
