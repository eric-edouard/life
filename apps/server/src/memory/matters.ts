import { join } from "node:path";
import { z } from "zod";
import { daysBefore } from "../core/clock";
import { appendJsonl, readAppended } from "../core/files";
import { digest } from "../core/hash";
import { count, packed } from "../core/lists";
import { stamp } from "../models/llm";
import { type Matter, MatterBatch, type MatterMember } from "../records/matter";
import { KEEP_AT } from "../records/unit";
import { openLinked } from "../todo-list/linked";
import { daysOf, episodesWhere, MATTERS, readBy, readLedger } from "./ledger";
import { foundQuotes } from "./observe";
import { begin, meContext } from "./run";
import { episodeNow, observationsNow, type People } from "./who";
import { localDate, type Window } from "./zones";

// Matters (docs/glossary.md): the running things of his life he never declared (an errand for someone, a purchase, a
// repair, a dispute, a trip being arranged). One model call reads a span's episodes not placed yet, with the facts read
// from their units and his new reminders, and the matters already running, and says which belongs to which matter;
// code keeps a placement only when its record was shown and its words are found in that record's own text. Each call
// is one appended line of memory/matters.jsonl: the matters it placed records in, and every record it was asked about,
// so what is due is derived and nothing is paid twice. Nothing reads the matters yet (in shadow) but the listing
// (`bun life memory matters list`). Off until his `matters` setting.

const PROMPT = "memory-matters.v1";
/** What a reply calls a matter that starts in it. */
const NEW_ID = /^new-\d+$/;
/** The most characters of episodes one call is shown: a longer span takes several calls, in order. */
const CALL_CHARS = 60_000;
/** A matter whose newest member is older than this, before the span's end, is no longer shown as running. */
const OPEN_DAYS = 60;

/** A fact as a call is shown it. */
interface Fact {
  id: string;
  text: string;
  type: string;
}
/** An episode as a call is shown it: its units not placed yet, each with its facts not placed yet. */
export interface ShownEpisode {
  day: string;
  people: { name: string; role: string }[];
  title: string;
  units: { facts: Fact[]; id: string }[];
  what: string;
}
/** One of his reminders as a call is shown it, with the day it was made. */
export interface ShownReminder {
  day: string;
  key: string;
  notes: string;
  title: string;
}
/** What is due in a span: the episodes and reminders no call was asked about yet. */
export interface MatterWork {
  episodes: ShownEpisode[];
  reminders: ShownReminder[];
  span: Window;
}
/** What a placement is checked against: for each record a call was shown, its day and the texts its quote may be found in. */
type Known = Map<string, { day: string; texts: string[] }>;

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
 * The matters as the lines say now, and every record ever offered. A matter is its latest name, area and projects (the
 * latest line naming it) and the union of its members over the lines, a later line's placement of a record winning
 * (the record leaves the matter it was in).
 */
export function mattersNow(batches: MatterBatch[]) {
  const byId = new Map<string, Matter & { members: MatterMember[] }>();
  const placedIn = new Map<string, string>();
  const offered = new Set<string>();
  for (const b of batches) {
    for (const ref of b.offered) {
      offered.add(ref);
    }
    for (const m of b.matters) {
      const members = new Map(byId.get(m.id)?.members.map((x) => [x.ref, x]));
      for (const member of m.members) {
        const was = placedIn.get(member.ref);
        const from = was && was !== m.id ? byId.get(was) : undefined;
        if (from) {
          from.members = from.members.filter((x) => x.ref !== member.ref);
        }
        placedIn.set(member.ref, m.id);
        members.set(member.ref, member);
      }
      byId.set(m.id, { ...m, members: [...members.values()] });
    }
  }
  return {
    matters: [...byId.values()].filter((m) => m.members.length > 0),
    offered,
  };
}

/** A matter's newest member: the latest day, the last placed of a day. */
const latestOf = (m: { members: MatterMember[] }) =>
  m.members.reduce((a, b) => (b.day >= a.day ? b : a));

/** The calls a span's work takes: its episodes packed by size, in order, the reminders with the first. */
export function callsOf(work: MatterWork) {
  const groups =
    work.episodes.length > 0
      ? packed(work.episodes, CALL_CHARS, (e) => JSON.stringify(e).length)
      : [[]];
  return groups
    .map((episodes, i) => ({
      episodes,
      reminders: i === 0 ? work.reminders : [],
    }))
    .filter((c) => c.episodes.length + c.reminders.length > 0);
}
type Call = ReturnType<typeof callsOf>[number];

/**
 * What is due in a span, from the records as they stand and what was offered (`mattersNow`): each episode with the
 * units, and the facts of those units, not offered yet; an episode with nothing left is not shown. Pure.
 */
export function pendingOf(
  episodes: ShownEpisode[],
  reminders: ShownReminder[],
  offered: ReadonlySet<string>
) {
  return {
    episodes: episodes.flatMap((e) => {
      const units = e.units.flatMap((u) => {
        const facts = u.facts.filter((f) => !offered.has(f.id));
        return facts.length > 0 || !offered.has(u.id) ? [{ ...u, facts }] : [];
      });
      return units.length > 0 ? [{ ...e, units }] : [];
    }),
    reminders: reminders.filter((r) => !offered.has(r.key)),
  };
}

/**
 * What the matters step has to place in `span`, from the episodes that overlap it (a unit under the one episode that
 * holds it, `readBy`, as extraction reads it), their facts that show at importance `KEEP_AT` or more, the people the
 * episode names, and his open reminders made in it. Null when a source failed: an episode must never be placed from a
 * span read only in part.
 */
export async function readMatterWork(
  span: Window,
  people: People,
  failed: string[]
): Promise<MatterWork | null> {
  if (failed.length > 0) {
    return null;
  }
  const [episodes, { observations }] = await Promise.all([
    episodesWhere(() => true),
    observationsNow(people),
  ]);
  const byEpisode = readBy(episodes);
  const facts = Map.groupBy(
    observations.filter((o) => o.importance >= KEEP_AT),
    (o) => o.unit
  );
  const shown = episodes
    .filter((m) => daysOf(m)[1] >= span.from && daysOf(m)[0] <= span.to)
    .map((m): ShownEpisode => {
      const { people: named } = episodeNow(m, people.refOf);
      return {
        day: daysOf(m)[0],
        people: named.map((p) => ({
          name: people.nameOf(p.ref),
          role: p.role,
        })),
        title: m.title,
        units: m.units
          .filter((u) => byEpisode.get(u) === m && !m.copies.includes(u))
          .map((id) => ({
            facts: (facts.get(id) ?? []).map((o) => ({
              id: o.id,
              text: o.text,
              type: o.type,
            })),
            id,
          })),
        what: m.what,
      };
    });
  const reminders = openLinked(readLedger()).flatMap((r) => {
    const day = localDate(r.at);
    const title = String(r.fields.title ?? "");
    return title && day >= span.from && day <= span.to
      ? [{ day, key: r.key, notes: String(r.fields.notes ?? ""), title }]
      : [];
  });
  return {
    ...pendingOf(shown, reminders, mattersNow(readMatters()).offered),
    span,
  };
}

/** What a call is shown, as the records a reply may place and where each one's words are found. */
function knownOf(call: Call): Known {
  const known: Known = new Map();
  for (const e of call.episodes) {
    for (const u of e.units) {
      known.set(u.id, { day: e.day, texts: [e.title, e.what] });
      for (const f of u.facts) {
        known.set(f.id, { day: e.day, texts: [f.text] });
      }
    }
  }
  for (const r of call.reminders) {
    known.set(r.key, { day: r.day, texts: [r.title] });
  }
  return known;
}

const Reply = z.object({
  matters: z
    .array(
      z.object({
        area: z.string().nullish(),
        id: z.string(),
        members: z
          .array(z.object({ quote: z.string(), ref: z.string() }))
          .default([]),
        name: z.string().default(""),
        projects: z.array(z.string()).default([]),
      })
    )
    .default([]),
});

/**
 * A reply's matters as kept: an id from `open` or `new-N` (a new matter's real id is `mint`'s, never the model's); each
 * member a record the call was shown, placed once, with its words found in that record's own text (stored as found
 * there); an area or project that is not on his map dropped. Anything else is dropped, never trusted. A matter left
 * with no member, or no name, is dropped.
 */
export function placedOf(
  reply: unknown,
  known: Known,
  open: ReadonlyMap<string, string>,
  map: { areas: ReadonlySet<string>; projects: ReadonlySet<string> },
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
    const members = m.members.flatMap(({ quote, ref }) => {
      const item = known.get(ref);
      const [found] = foundQuotes(
        [quote],
        item?.texts.map((text) => ({ text })) ?? []
      );
      if (!(item && found) || seen.has(ref)) {
        return [];
      }
      seen.add(ref);
      return [{ day: item.day, quote: found.text.slice(0, 300), ref }];
    });
    if (id && name && members.length > 0) {
      const was = byId.get(id);
      byId.set(id, {
        area: m.area && map.areas.has(m.area) ? m.area : null,
        id,
        members: [...(was?.members ?? []), ...members],
        name,
        projects: m.projects.filter((p) => map.projects.has(p)),
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
export async function matters(work: MatterWork, people: People) {
  const step = await begin("matters", "main", { prompt: PROMPT });
  const { truth } = people;
  const context = {
    ...meContext(truth),
    projects: truth.projects.map((p) => ({ id: p.id, name: p.name })),
  };
  const map = {
    areas: new Set(truth.areas.map((a) => a.id)),
    projects: new Set(truth.projects.map((p) => p.id)),
  };
  let placed = 0;
  for (const [i, call] of callsOf(work).entries()) {
    // biome-ignore lint/performance/noAwaitInLoops: a call sees the matters the one before placed
    await step.attempt(
      async () => {
        const horizon = daysBefore(work.span.to, OPEN_DAYS);
        const open = mattersNow(readMatters()).matters.flatMap((m) => {
          const latest = latestOf(m);
          return latest.day >= horizon
            ? [
                {
                  id: m.id,
                  latest: { day: latest.day, text: latest.quote },
                  name: m.name,
                },
              ]
            : [];
        });
        const reply = await step.ask({
          context,
          dir: join(step.dir, `call-${i + 1}`),
          input: {
            episodes: call.episodes,
            open,
            reminders: call.reminders.map(({ key, notes, title }) => ({
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
          map,
          (n) => `matter_${digest("sha256", `${at}\n${first}\n${n}`, 12)}`
        );
        appendJsonl(MATTERS, MatterBatch, [
          {
            at,
            madeBy: stamp(step.llm, PROMPT, step.run),
            matters: kept,
            offered: [...known.keys()],
            schemaVersion: 1,
          },
        ]);
        placed += kept.reduce((n, m) => n + m.members.length, 0);
      },
      { call: i + 1 }
    );
  }
  return step.end({ placed });
}

/** The matters, one line each: name, area, projects, how many records and the day of the newest (`bun life memory matters list`). */
export const matterLines = (batches = readMatters()) =>
  mattersNow(batches).matters.map(
    (m) =>
      `${m.name} · area ${m.area ?? "none"} · projects ${m.projects.join(", ") || "none"} · ${count(m.members.length, "member")} · newest ${latestOf(m).day}`
  );
