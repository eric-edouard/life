import { join } from "node:path";
import { z } from "zod";
import { clock, daysBefore } from "../core/clock";
import { appendJsonl, readAppended } from "../core/files";
import { digest } from "../core/hash";
import { count, packed } from "../core/lists";
import { isPromptVersion } from "../models/prompt-parts";
import type { Episode } from "../records/episode";
import {
  type DirectionPin,
  type IconPin,
  type ImportantPin,
  type Matter,
  MatterBatch,
  MatterDirectionBatch,
  type MatterStep,
  type ProjectPin,
} from "../records/matter";
import { Correction } from "../records/observation";
import { SEARCHABLE_AT } from "../records/unit";
import {
  openTodoItemsOf,
  todoItemsOf,
} from "../todo-list/todo-items-from-ledger";
import { endingsRead } from "./endings";
import {
  episodeAt,
  type MatterStepNow,
  type MatterView,
  matterBookOf,
} from "./matter-read";
import {
  CONTACT_PEOPLE,
  CORRECTIONS,
  daysOf,
  deletionsNow,
  EPISODES,
  EXTRACTED,
  episodesWhere,
  FACT_CHECK_ANSWERS,
  FACT_CHECKS,
  INFERRED,
  LEDGER,
  LINKS,
  MATTER_DIRECTIONS,
  MATTERS,
  OBSERVATIONS,
  readBy,
  readLedger,
  readUnitsFor,
  SUPERSESSIONS,
  UNRESOLVED,
} from "./memory-files";
import { meContext } from "./model-context";
import { foundQuotes } from "./quote-check";
import { TRUTH } from "./read-truth";
import { reopenedAtOf } from "./retirements";
import { begin, readsOf } from "./run";
import { clip, isMailerHandle, UNKNOWN } from "./units";
import { episodeNow, observationsNow, type People } from "./who";
import { localDate, type Window } from "./zones";

// Matters (docs/glossary.md): the running things of his life he never declared (an errand for someone, a purchase, a
// repair, a dispute, a trip being arranged). One model call reads a span's episodes not placed yet, with the observations read
// from their units and his new to-do items, and the matters already running, and says which belongs to which matter (an
// episode is stored as its units: a day's episodes are rewritten, a unit keeps its id);
// code keeps a placement only when its record was shown and its words are found in that record's own text. Each call
// is one appended line of memory/matters.jsonl: the matters it placed records in, and every record it was asked about,
// so what is due is derived and nothing is paid twice. What is open in a matter, its status and people are worked out when read (`matter-read.ts`).

export const MATTERS_PROMPT = "memory-matters.v2";
/** What a reply calls a matter that starts in it. */
const NEW_ID = /^new-\d+$/;
/** The most characters of episodes one call is shown: a longer span takes several calls, in order. */
const CALL_CHARS = 60_000;
/** A matter the model is shown (open, done or full) has a step in this many days. */
const SHOWN_DAYS = 45;
/** A matter is full at this many steps or more than this many areas, as a reader sees it: it takes no more steps. */
const STEPS_MAX = 40;
const AREAS_MAX = 3;
/** How many of a shown matter's open steps and newest steps the model sees, and how long each step's words. */
const SHOWN_STEPS = 3;
const SHOWN_LATEST = 2;
const SHOWN_CHARS = 120;

/** An observation as a call is shown it. */
interface ShownObservation {
  id: string;
  text: string;
  type: string;
}
/**
 * An episode as a call is shown it, with the observations of its units not placed yet. A unit no episode holds that has observations
 * is shown as an episode of its own, by its id and title. `units` is code's: placing the episode places them.
 */
export interface ShownEpisode {
  day: string;
  id: string;
  observations: ShownObservation[];
  people: { name: string; role: string }[];
  title: string;
  units: string[];
  what: string;
}
/** One of his todoItems as a call is shown it, with the day it was made. */
export interface ShownTodoItem {
  day: string;
  key: string;
  notes: string;
  title: string;
}
/** What is due in a span: the episodes and todoItems no call was asked about yet. */
export interface MatterWork {
  episodes: ShownEpisode[];
  span: Window;
  todoItems: ShownTodoItem[];
}
/**
 * What a placement is checked against: for each record a call was shown, its day, the texts its quote may be found in
 * and the refs it is stored as (an episode's are its units).
 */
type Known = Map<string, { day: string; refs: string[]; texts: string[] }>;

/** Every stored line, in the order written. */
export const readMatters = () =>
  readAppended(
    MATTERS,
    MatterBatch,
    (last?: MatterBatch[]) => [...(last ?? [])],
    (all, b) => {
      all.push(b);
    }
  );

/**
 * The matters as the lines of the current prompt say now, and every record they were offered: a new prompt version is
 * a new grouping (every record offered again, every matter a new id; the older lines stay as stored). A matter is its
 * latest name, areas and projects (the latest line naming it) and the union of its steps over the lines, a later line's
 * placement of a record winning (the record leaves the matter it was in). A matter he deleted is no matter any more.
 */
export function mattersNow(all: MatterBatch[], deleted = deletionsNow().refs) {
  const batches = all.filter((b) =>
    isPromptVersion(b.madeBy.prompt, MATTERS_PROMPT)
  );
  const byId = new Map<string, Matter & { steps: MatterStep[] }>();
  const placedIn = new Map<string, string>();
  const offered = new Set<string>();
  for (const b of batches) {
    for (const ref of b.offered) {
      offered.add(ref);
    }
    for (const m of b.matters) {
      const steps = new Map(byId.get(m.id)?.steps.map((x) => [x.ref, x]));
      for (const step of m.steps) {
        const was = placedIn.get(step.ref);
        const from = was && was !== m.id ? byId.get(was) : undefined;
        if (from) {
          from.steps = from.steps.filter((x) => x.ref !== step.ref);
        }
        placedIn.set(step.ref, m.id);
        steps.set(step.ref, step);
      }
      byId.set(m.id, { ...m, steps: [...steps.values()] });
    }
  }
  return {
    matters: [...byId.values()].filter(
      (m) => m.steps.length > 0 && !deleted.has(m.id)
    ),
    offered,
  };
}

/** A matter's newest step: the latest day, the last placed of a day. */
const latestOf = (m: { steps: MatterStep[] }) =>
  m.steps.reduce((a, b) => (b.day >= a.day ? b : a));

/** His pins as folded from his corrections (`readMatterPins`). */
interface HisPins {
  /** His Later on any check (`deferred`): its `until` by the check's ref, the latest for a ref. */
  deferred: Map<string, string>;
  /** Of those, the ones whose latest line waits for his arrival home (`home`): when it was written, by the same key. */
  deferredHome: Map<string, string>;
  directions: DirectionPin[];
  icons: IconPin[];
  important: ImportantPin[];
  projects: ProjectPin[];
  /** His Reopens (`matter-reopened`), for `reopenedAtOf`. */
  reopened: Correction[];
}

/** His Later on a check, the latest for its key; one that waits for home is kept apart too (`deferredHome`). */
function addDeferred(
  pins: HisPins,
  c: Extract<Correction, { kind: "deferred" }>
) {
  const key = laterKeyOf(c.ref);
  pins.deferred.set(key, c.until);
  if (c.home) {
    pins.deferredHome.set(key, c.at);
  } else {
    pins.deferredHome.delete(key);
  }
}

/** A correction's pin: when, its steps and the matter's id when it was written. */
const pinOf = (c: { at: string; matter?: string; steps: string[] }) => ({
  at: c.at,
  steps: c.steps,
  ...(c.matter ? { matter: c.matter } : {}),
});

/**
 * What is pinned to matters' steps (`pinnedOf` finds each one's matter): the directions (`directionsOf`: Life's drafts,
 * then his `matter-direction`), his important marks (`matter-important`, on or off), his icons (`matter-icon`, a key
 * or null), his projects (`matter-project`), each with when it was written, and his Later on any check (`deferred`, by its ref);
 * a Life draft reading a matter over is dropped once he reopened one of its steps after it (`matter-reopened`). Both files are folded incrementally (`readAppended`): a read parses only
 * the lines appended since the last.
 */
export function readMatterPins() {
  const drafts = readAppended(
    MATTER_DIRECTIONS,
    MatterDirectionBatch,
    (last?: DirectionPin[]) => [...(last ?? [])],
    (all, b) => {
      for (const d of b.directions) {
        all.push({ at: b.at, by: "life", ...d });
      }
    }
  );
  const his = readAppended(
    CORRECTIONS,
    Correction,
    (last?: HisPins) => ({
      deferred: new Map(last?.deferred),
      deferredHome: new Map(last?.deferredHome),
      directions: [...(last?.directions ?? [])],
      icons: [...(last?.icons ?? [])],
      important: [...(last?.important ?? [])],
      projects: [...(last?.projects ?? [])],
      reopened: [...(last?.reopened ?? [])],
    }),
    (pins, c) => {
      if (c.kind === "matter-direction") {
        pins.directions.push({
          ...pinOf(c),
          by: "owner",
          ...(c.goal ? { goal: c.goal } : {}),
          ...(c.nextStep ? { nextStep: c.nextStep } : {}),
        });
      } else if (c.kind === "matter-important") {
        pins.important.push({ ...pinOf(c), important: c.important });
      } else if (c.kind === "matter-icon") {
        pins.icons.push({ ...pinOf(c), icon: c.icon });
      } else if (c.kind === "matter-project") {
        pins.projects.push({ ...pinOf(c), project: c.project });
      } else if (c.kind === "deferred") {
        addDeferred(pins, c);
      } else if (c.kind === "matter-reopened") {
        pins.reopened.push(c);
      }
    }
  );
  // A Life draft reading a matter over before his Reopen of one of its steps is lifted: the latest of his words wins.
  const reopened = reopenedAtOf(his.reopened);
  const standing = drafts.filter(
    (d) =>
      !(
        d.endingRecords &&
        d.steps.some((ref) => (reopened.get(ref) ?? "") > d.at)
      )
  );
  return { ...his, directions: [...standing, ...his.directions] };
}

/** What his Later holds: a check's ref, but a your move card's matter whole (`move:<matter>/<step>` → `move:<matter>`). */
const MOVE_STEP = /^(move:[^/]*)\/.*$/;
const laterKeyOf = (ref: string) => ref.replace(MOVE_STEP, "$1");

/** Until when his Later holds check `ref` at `now` (its latest `deferred`), or undefined once it passed or when none does. */
export function laterUntilOf(ref: string, now = clock()) {
  const until = readMatterPins().deferred.get(laterKeyOf(ref));
  return until && Date.parse(until) > now.getTime() ? until : undefined;
}

/**
 * The records every span of a run and every matter's steps are read from, as they stand today: all episodes, all
 * observations, the ledger (`matterBookOf`). Read once. What ended an observation for sure
 * is its being retired (a newer one replaced it, or he said it is outdated; his right to an ending check is the same
 * `outdated` word); a link not yet his word ends it probably (`endingsRead`).
 */
export async function readMatterRecords(people: People) {
  const [episodes, { observations, statusInputs }] = await Promise.all([
    episodesWhere(() => true),
    observationsNow(people),
  ]);
  const ledger = readLedger();
  // The one rule for "current": the records as they stand now (an end re-read away counts for nothing).
  const current = new Set([
    ...observations.map((o) => o.id),
    ...episodes.map((e) => e.id),
  ]);
  // Each ending at the instant of its evidence, never of the run that found it (a re-read or a re-judge stamps nothing).
  const atOf = new Map<string, string>([
    ...episodes.map((e): [string, string] => [e.id, episodeAt(e)]),
    ...observations.map((o): [string, string] => [o.id, o.at]),
  ]);
  const reopenedAt = reopenedAtOf(people.corrections);
  // A link whose evidence came before his Reopen of its step ends nothing: the latest of his words wins.
  const linkEndings = new Map(
    [...endingsRead((ref) => current.has(ref)).linkEndings].flatMap(
      ([ref, l]) => {
        const at = atOf.get(l.later) ?? l.at;
        const reopened = reopenedAt.get(ref);
        return reopened && Date.parse(reopened) >= Date.parse(at)
          ? []
          : [[ref, { ...l, at }] as const];
      }
    )
  );
  const retired = new Map(
    [...statusInputs.retired].map(([id, r]) => [
      id,
      r.by === id
        ? { at: r.at, why: r.why, ...(r.dropped ? { dropped: r.dropped } : {}) }
        : { at: atOf.get(r.by) ?? r.at, replacedBy: r.by, why: r.why },
    ])
  );
  return {
    current,
    ...readMatterPins(),
    episodeOf: readBy(episodes),
    episodes,
    isMailer: (ref: string) =>
      ref.startsWith(UNKNOWN) && isMailerHandle(ref.slice(UNKNOWN.length)),
    ledger,
    linkEndings,
    observations,
    refOf: people.refOf,
    retired,
    todoItems: [...todoItemsOf(ledger).values()],
  };
}

/**
 * Every file the matter book is read from, units aside (the watcher writes them every few minutes, and a matter changes
 * only through these): its steps, endings, directions, his word, the to-do items and the people. A reader keyed by a
 * change stamp of the book spreads this list, so a new read here reaches every such key.
 */
export const MATTER_BOOK_READS = [
  CONTACT_PEOPLE,
  CORRECTIONS,
  EPISODES,
  EXTRACTED,
  FACT_CHECK_ANSWERS,
  FACT_CHECKS,
  INFERRED,
  LEDGER,
  LINKS,
  MATTER_DIRECTIONS,
  MATTERS,
  OBSERVATIONS,
  SUPERSESSIONS,
  TRUTH,
  UNRESOLVED,
];

/** Every matter on `today`, as the stored lines and the records say now (`matterBookOf`), with the records it was read from. */
export async function readMatterBookAndRecords(people: People, today: string) {
  const records = await readMatterRecords(people);
  return {
    book: matterBookOf(mattersNow(readMatters()), records, today),
    records,
  };
}

/** The book again on `today` from records already read: the stored lines and his pins read afresh (directions written since included), no history read. */
export const matterBookAgain = (
  records: Awaited<ReturnType<typeof readMatterRecords>>,
  today: string
) =>
  matterBookOf(
    mattersNow(readMatters()),
    { ...records, ...readMatterPins() },
    today
  );

/** Every matter on `today`, as the stored lines and the records say now (`matterBookOf`). */
export const readMatterBook = async (people: People, today: string) =>
  (await readMatterBookAndRecords(people, today)).book;

/** The calls a span's work takes: its episodes packed by size, in order, the todoItems with the first. */
export function callsOf(work: MatterWork) {
  const groups =
    work.episodes.length > 0
      ? packed(work.episodes, CALL_CHARS, (e) => JSON.stringify(e).length)
      : [[]];
  return groups
    .map((episodes, i) => ({
      episodes,
      todoItems: i === 0 ? work.todoItems : [],
    }))
    .filter((c) => c.episodes.length + c.todoItems.length > 0);
}
type Call = ReturnType<typeof callsOf>[number];

/**
 * What is due in a span, from the records as they stand and what was offered (`mattersNow`): each episode with a unit
 * not offered yet or an observation not offered yet, shown with those observations only. Pure.
 */
export function pendingOf(
  episodes: ShownEpisode[],
  todoItems: ShownTodoItem[],
  offered: ReadonlySet<string>
) {
  return {
    episodes: episodes.flatMap((e) => {
      const observations = e.observations.filter((f) => !offered.has(f.id));
      return observations.length > 0 || e.units.some((u) => !offered.has(u))
        ? [{ ...e, observations }]
        : [];
    }),
    todoItems: todoItems.filter((r) => !offered.has(r.key)),
  };
}

/** An observation as `shownEpisodesOf` reads it. */
type ObservationNow = ShownObservation & {
  date: string;
  importance: number;
  unit: string;
};

/**
 * The episodes that overlap `span`, each with its units (a unit under the one episode that holds it, `readBy`, as
 * extraction reads it), their observations at importance `SEARCHABLE_AT` or more (a small step of an errand is often rated low)
 * and the people it names; then each unit no episode holds that has such an observation in the span, as an episode of its own
 * left untitled (its id is the unit's: `readMatterWork` names it). In day order. Pure.
 */
export function shownEpisodesOf(
  span: Window,
  episodes: Episode[],
  observations: ObservationNow[],
  people: Pick<People, "nameOf" | "refOf">
): ShownEpisode[] {
  const byEpisode = readBy(episodes);
  const shown = observations.filter((o) => o.importance >= SEARCHABLE_AT);
  const observationsOf = Map.groupBy(shown, (o) => o.unit);
  const asShown = (o: ObservationNow): ShownObservation => ({
    id: o.id,
    text: o.text,
    type: o.type,
  });
  const held = episodes
    .filter((m) => daysOf(m)[1] >= span.from && daysOf(m)[0] <= span.to)
    .map((m): ShownEpisode => {
      const units = m.units.filter(
        (u) => byEpisode.get(u) === m && !m.copies.includes(u)
      );
      return {
        day: daysOf(m)[0],
        id: m.id,
        observations: units.flatMap((u) =>
          (observationsOf.get(u) ?? []).map(asShown)
        ),
        people: episodeNow(m, people.refOf).people.map((p) => ({
          name: people.nameOf(p.ref),
          role: p.role,
        })),
        title: m.title,
        units,
        what: m.what,
      };
    });
  const lone = [...observationsOf].flatMap(([unit, of]): ShownEpisode[] => {
    const day = of[0]?.date ?? "";
    return byEpisode.has(unit) || day < span.from || day > span.to
      ? []
      : [
          {
            day,
            id: unit,
            observations: of.map(asShown),
            people: [],
            title: "",
            units: [unit],
            what: "",
          },
        ];
  });
  return [...held, ...lone].toSorted((a, b) => a.day.localeCompare(b.day));
}

/**
 * What the matters step has to place in `span`: its episodes (`shownEpisodesOf`, a lone unit named by its title) and his
 * open to-do items made in it, less what was offered. Null when a source failed: an episode must never be placed from
 * a span read only in part. `records` is `readMatterRecords`', read here when not given.
 */
export async function readMatterWork(
  span: Window,
  people: People,
  failed: string[],
  records?: Awaited<ReturnType<typeof readMatterRecords>>
): Promise<MatterWork | null> {
  if (failed.length > 0) {
    return null;
  }
  const { episodes, observations } =
    records ?? (await readMatterRecords(people));
  const placed = shownEpisodesOf(span, episodes, observations, people);
  const lone = placed.filter((e) => e.id === e.units[0]);
  const titles = new Map(
    readUnitsFor(
      lone.map((e) => e.id),
      lone.map((e) => e.day)
    ).map((u) => [u.id, u.title])
  );
  const shown = placed.map((e) => ({
    ...e,
    title: titles.get(e.id) ?? e.title,
  }));
  const todoItems = openTodoItemsOf(readLedger()).flatMap((r) => {
    const day = localDate(r.at);
    const title = String(r.fields.title ?? "");
    return title && day >= span.from && day <= span.to
      ? [{ day, key: r.key, notes: String(r.fields.notes ?? ""), title }]
      : [];
  });
  return {
    ...pendingOf(shown, todoItems, mattersNow(readMatters()).offered),
    span,
  };
}

/** What a call is shown, as the records a reply may place and where each one's words are found. */
function knownOf(call: Call): Known {
  const known: Known = new Map();
  for (const e of call.episodes) {
    known.set(e.id, { day: e.day, refs: e.units, texts: [e.title, e.what] });
    for (const f of e.observations) {
      known.set(f.id, { day: e.day, refs: [f.id], texts: [f.text] });
    }
  }
  for (const r of call.todoItems) {
    known.set(r.key, { day: r.day, refs: [r.key], texts: [r.title] });
  }
  return known;
}

const Reply = z.object({
  matters: z
    .array(
      z.object({
        areas: z.array(z.string()).default([]),
        id: z.string(),
        name: z.string().default(""),
        projects: z.array(z.string()).default([]),
        steps: z
          .array(z.object({ quote: z.string(), ref: z.string() }))
          .default([]),
      })
    )
    .default([]),
});

/**
 * A reply's matters as kept, and how many steps it put in a matter that may take none (`refusedSteps`: a full one, or an id it was
 * not shown): an id from `joinable` or `new-N` (a new matter's real id is `mint`'s, never the model's); each
 * step a record the call was shown, placed once, with its words found in that record's own text (stored as found
 * there, an episode as each of its units); an area or project that is not in his directory dropped. Anything else is dropped, never trusted. A matter left
 * with no step, or no name, is dropped.
 */
export function placedOf(
  reply: unknown,
  known: Known,
  joinable: ReadonlyMap<string, string>,
  directory: { areas: ReadonlySet<string>; projects: ReadonlySet<string> },
  mint: (id: string) => string
): { kept: Matter[]; refusedSteps: number } {
  const seen = new Set<string>();
  const byId = new Map<string, Matter>();
  let refusedSteps = 0;
  for (const m of Reply.parse(reply).matters) {
    const id = NEW_ID.test(m.id) ? mint(m.id) : m.id;
    if (!(joinable.has(id) || NEW_ID.test(m.id))) {
      refusedSteps += m.steps.length;
      continue;
    }
    const name = (m.name.trim() || joinable.get(m.id) || "").slice(0, 120);
    const steps = m.steps.flatMap(({ quote, ref }) => {
      const item = known.get(ref);
      const [found] = foundQuotes(
        [quote],
        item?.texts.map((text) => ({ text })) ?? []
      );
      if (!(item && found)) {
        return [];
      }
      return item.refs.flatMap((r) => {
        if (seen.has(r)) {
          return [];
        }
        seen.add(r);
        return [{ day: item.day, quote: found.text.slice(0, 300), ref: r }];
      });
    });
    if (name && steps.length > 0) {
      const was = byId.get(id);
      byId.set(id, {
        areas: m.areas.filter((a) => directory.areas.has(a)),
        id,
        name,
        projects: m.projects.filter((p) => directory.projects.has(p)),
        steps: [...(was?.steps ?? []), ...steps],
      });
    }
  }
  return { kept: [...byId.values()], refusedSteps };
}

/**
 * The matters a call is shown on `to` (a day): every grouped one with a step in the last `SHOWN_DAYS`, open, done or
 * full (its reader view at `STEPS_MAX` steps or more than `AREAS_MAX` areas: it takes no more), each with its open steps
 * and newest steps in short words. Pure.
 */
export function mattersShownOf(book: readonly MatterView[], to: string) {
  const since = daysBefore(to, SHOWN_DAYS);
  const words = (list: MatterStepNow[]) =>
    list.map((x) => ({ day: x.day, text: clip(x.text, SHOWN_CHARS) }));
  return book.flatMap((v) =>
    v.lone || (v.steps.at(-1)?.day ?? "") < since
      ? []
      : [
          {
            areas: v.areas,
            id: v.id,
            latest: words(v.steps.slice(-SHOWN_LATEST)),
            name: v.name,
            openSteps: words(v.openSteps.slice(-SHOWN_STEPS)),
            projects: v.projects,
            status: statusShownOf(v),
          },
        ]
  );
}

/** How a call is shown a matter: `full` (it takes no more steps), else `open` or `done`. */
const statusShownOf = (v: Pick<MatterView, "areas" | "open" | "steps">) => {
  if (isFullMatter(v)) {
    return "full";
  }
  return v.open ? "open" : "done";
};

/** A matter that takes no more steps: as a reader sees it, `STEPS_MAX` steps or more, or more than `AREAS_MAX` areas. */
export const isFullMatter = (v: Pick<MatterView, "areas" | "steps">) =>
  v.steps.length >= STEPS_MAX || v.areas.length > AREAS_MAX;

/**
 * Places a span's work (`readMatterWork`), one call after another (a call sees the matters the one before placed), each
 * appended as one line once its reply is checked (a failed call leaves its records due). The only writer of
 * memory/matters.jsonl; callers hold the memory lock.
 */
export async function matters(
  work: MatterWork,
  people: People,
  records: Awaited<ReturnType<typeof readMatterRecords>>
) {
  const step = await begin("matters", "fast", { prompt: MATTERS_PROMPT });
  const { truth } = people;
  const context = {
    ...meContext(truth),
    projects: truth.projects.map((p) => ({ id: p.id, name: p.name })),
  };
  const directory = {
    areas: new Set(truth.areas.map((a) => a.id)),
    projects: new Set(truth.projects.map((p) => p.id)),
  };
  const observationOf = new Map(records.observations.map((o) => [o.id, o]));
  let placed = 0;
  let refusedSteps = 0;
  for (const [i, call] of callsOf(work).entries()) {
    // biome-ignore lint/performance/noAwaitInLoops: a call sees the matters the one before placed
    await step.attempt(
      async () => {
        const shown = mattersShownOf(
          matterBookOf(mattersNow(readMatters()), records, work.span.to),
          work.span.to
        );
        const reply = await step.ask({
          context,
          dir: join(step.dir, `call-${i + 1}`),
          input: {
            episodes: call.episodes.map(({ units: _, ...e }) => e),
            shown,
            todoItems: call.todoItems.map(({ key, notes, title }) => ({
              key,
              notes,
              title,
            })),
          },
          prompt: MATTERS_PROMPT,
          reads: readsOf([
            ...call.episodes.map((e) => ({
              source: "memory" as const,
              unit: e.id,
            })),
            ...call.episodes
              .flatMap((e) => e.observations)
              .flatMap(({ id }) => observationOf.get(id) ?? [])
              .map((o) => ({ source: o.source.channel, unit: o.unit })),
            ...call.todoItems.map((r) => ({
              source: "memory" as const,
              unit: r.key,
            })),
            ...shown.map((m) => ({
              source: "memory" as const,
              unit: m.id,
            })),
          ]),
        });
        const known = knownOf(call);
        const at = step.now.toISOString();
        const [first] = known.keys();
        const { kept, refusedSteps: no } = placedOf(
          reply,
          known,
          new Map(
            shown.flatMap((m) => (m.status === "full" ? [] : [[m.id, m.name]]))
          ),
          directory,
          (n) => `matter_${digest("sha256", `${at}\n${first}\n${n}`, 12)}`
        );
        appendJsonl(MATTERS, MatterBatch, [
          {
            at,
            madeBy: step.madeBy(MATTERS_PROMPT),
            matters: kept,
            offered: [...new Set([...known.values()].flatMap((k) => k.refs))],
            schemaVersion: 1,
          },
        ]);
        placed += kept.reduce((n, m) => n + m.steps.length, 0);
        refusedSteps += no;
      },
      { call: i + 1 }
    );
  }
  return step.end({ placed, refusedSteps });
}

/** The matters, one line each: name, areas, projects, how many records and the day of the newest (`bun life memory matters list`). */
export const matterLines = (batches = readMatters()) =>
  mattersNow(batches).matters.map(
    (m) =>
      `${m.name} · areas ${m.areas.join(", ") || "none"} · projects ${m.projects.join(", ") || "none"} · ${count(m.steps.length, "step")} · newest ${latestOf(m).day}`
  );
