import { join } from "node:path";
import { z } from "zod";
import { appendJsonl, readAppended } from "../core/files";
import { digest } from "../core/hash";
import { count, packed } from "../core/lists";
import { stamp } from "../models/llm";
import type { Episode } from "../records/episode";
import { type Matter, MatterBatch, type MatterStep } from "../records/matter";
import { SEARCHABLE_AT } from "../records/unit";
import {
  openTodoItemsOf,
  todoItemsOf,
} from "../todo-list/todo-items-from-ledger";
import { type MatterRecords, matterBookOf } from "./matter-read";
import {
  daysOf,
  episodesWhere,
  MATTERS,
  readBy,
  readLedger,
  readUnitsFor,
} from "./memory-files";
import { meContext } from "./model-context";
import { foundQuotes } from "./quote-check";
import { begin } from "./run";
import { episodeNow, observationsNow, type People } from "./who";
import { localDate, type Window } from "./zones";

// Matters (docs/glossary.md): the running things of his life he never declared (an errand for someone, a purchase, a
// repair, a dispute, a trip being arranged). One model call reads a span's episodes not placed yet, with the observations read
// from their units and his new to-do items, and the matters already running, and says which belongs to which matter (an
// episode is stored as its units: a day's episodes are rewritten, a unit keeps its id);
// code keeps a placement only when its record was shown and its words are found in that record's own text. Each call
// is one appended line of memory/matters.jsonl: the matters it placed records in, and every record it was asked about,
// so what is due is derived and nothing is paid twice. What is open in a matter, its status and people are worked out when read (`matter-read.ts`). Off until his `matters` setting.

const PROMPT = "memory-matters.v1";
/** What a reply calls a matter that starts in it. */
const NEW_ID = /^new-\d+$/;
/** The most characters of episodes one call is shown: a longer span takes several calls, in order. */
const CALL_CHARS = 60_000;

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
 * The matters as the lines say now, and every record ever offered. A matter is its latest name, areas and projects (the
 * latest line naming it) and the union of its steps over the lines, a later line's placement of a record winning
 * (the record leaves the matter it was in).
 */
export function mattersNow(batches: MatterBatch[]) {
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
    matters: [...byId.values()].filter((m) => m.steps.length > 0),
    offered,
  };
}

/** A matter's newest step: the latest day, the last placed of a day. */
const latestOf = (m: { steps: MatterStep[] }) =>
  m.steps.reduce((a, b) => (b.day >= a.day ? b : a));

/**
 * The records a matter's steps are read from, as they stand today (`matterBookOf`). `endingsFor`: what each observation
 * was ended by, given which observations are current (`endingsNow`, links.ts); none without it.
 */
export async function readMatterRecords(
  people: People,
  endingsFor: (
    isCurrent: (id: string) => boolean
  ) => MatterRecords["endings"] = () => new Map()
): Promise<MatterRecords> {
  const [episodes, { observations }] = await Promise.all([
    episodesWhere(() => true),
    observationsNow(people),
  ]);
  const current = new Set(observations.map((o) => o.id));
  const ledger = readLedger();
  return {
    endings: endingsFor((id) => current.has(id)),
    episodeOf: readBy(episodes),
    ledger,
    observations,
    refOf: people.refOf,
    todoItems: [...todoItemsOf(ledger).values()],
  };
}

/** Every matter on `today`, as the stored lines and the records say now (`matterBookOf`). */
export const readMatterBook = async (
  people: People,
  today: string,
  endingsFor?: Parameters<typeof readMatterRecords>[1]
) =>
  matterBookOf(
    mattersNow(readMatters()).matters,
    await readMatterRecords(people, endingsFor),
    today
  );

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

/** The records every span of a run is read from: all episodes, all observations. Read once, a backfill's weeks share it. */
export async function readMatterRecords(people: People) {
  const [episodes, { observations }] = await Promise.all([
    episodesWhere(() => true),
    observationsNow(people),
  ]);
  return { episodes, observations };
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
 * A reply's matters as kept: an id from `open` or `new-N` (a new matter's real id is `mint`'s, never the model's); each
 * step a record the call was shown, placed once, with its words found in that record's own text (stored as found
 * there, an episode as each of its units); an area or project that is not in his directory dropped. Anything else is dropped, never trusted. A matter left
 * with no step, or no name, is dropped.
 */
export function placedOf(
  reply: unknown,
  known: Known,
  open: ReadonlyMap<string, string>,
  directory: { areas: ReadonlySet<string>; projects: ReadonlySet<string> },
  mint: (id: string) => string
): Matter[] {
  const seen = new Set<string>();
  const byId = new Map<string, Matter>();
  for (const m of Reply.parse(reply).matters) {
    const id = NEW_ID.test(m.id) ? mint(m.id) : m.id;
    if (!(open.has(id) || NEW_ID.test(m.id))) {
      continue;
    }
    const name = (m.name.trim() || open.get(m.id) || "").slice(0, 120);
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
  return [...byId.values()];
}

/**
 * Places a span's work (`readMatterWork`), one call after another (a call sees the matters the one before placed), each
 * appended as one line once its reply is checked (a failed call leaves its records due). The only writer of
 * memory/matters.jsonl; callers hold the memory lock.
 */
export async function matters(
  work: MatterWork,
  people: People,
  endingsFor?: Parameters<typeof readMatterRecords>[1]
) {
  const step = await begin("matters", "fast", { prompt: PROMPT });
  const { truth } = people;
  const context = {
    ...meContext(truth),
    projects: truth.projects.map((p) => ({ id: p.id, name: p.name })),
  };
  const directory = {
    areas: new Set(truth.areas.map((a) => a.id)),
    projects: new Set(truth.projects.map((p) => p.id)),
  };
  const records = await readMatterRecords(people, endingsFor);
  let placed = 0;
  for (const [i, call] of callsOf(work).entries()) {
    // biome-ignore lint/performance/noAwaitInLoops: a call sees the matters the one before placed
    await step.attempt(
      async () => {
        // What is still running: not done, not dormant (`matterOf`), as of the span's end.
        const open = matterBookOf(
          mattersNow(readMatters()).matters,
          records,
          work.span.to
        ).flatMap((v) =>
          v.lone || !v.open || v.status === "dormant"
            ? []
            : [
                {
                  areas: v.areas,
                  id: v.id,
                  latest: {
                    day: v.steps.at(-1)?.day ?? "",
                    text: v.steps.at(-1)?.quote ?? "",
                  },
                  name: v.name,
                  projects: v.projects,
                },
              ]
        );
        const reply = await step.ask({
          context,
          dir: join(step.dir, `call-${i + 1}`),
          input: {
            episodes: call.episodes.map(({ units: _, ...e }) => e),
            open,
            todoItems: call.todoItems.map(({ key, notes, title }) => ({
              key,
              notes,
              title,
            })),
          },
          prompt: PROMPT,
        });
        const known = knownOf(call);
        const at = step.now.toISOString();
        const [first] = known.keys();
        const kept = placedOf(
          reply,
          known,
          new Map(open.map((m) => [m.id, m.name])),
          directory,
          (n) => `matter_${digest("sha256", `${at}\n${first}\n${n}`, 12)}`
        );
        appendJsonl(MATTERS, MatterBatch, [
          {
            at,
            madeBy: stamp(step.llm, PROMPT, step.run),
            matters: kept,
            offered: [...new Set([...known.values()].flatMap((k) => k.refs))],
            schemaVersion: 1,
          },
        ]);
        placed += kept.reduce((n, m) => n + m.steps.length, 0);
      },
      { call: i + 1 }
    );
  }
  return step.end({ placed });
}

/** The matters, one line each: name, areas, projects, how many records and the day of the newest (`bun life memory matters list`). */
export const matterLines = (batches = readMatters()) =>
  mattersNow(batches).matters.map(
    (m) =>
      `${m.name} · areas ${m.areas.join(", ") || "none"} · projects ${m.projects.join(", ") || "none"} · ${count(m.steps.length, "step")} · newest ${latestOf(m).day}`
  );
