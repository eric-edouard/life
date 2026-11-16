import { join } from "node:path";
import { z } from "zod";
import { daysBefore } from "../core/clock";
import { appendJsonl } from "../core/files";
import { stamp } from "../models/llm";
import { Link, LinkBatch } from "../records/link";
import type { Observation } from "../records/observation";
import { endingsNow, readBatches } from "./endings";
import {
  ACTIONABLE,
  episodeAt,
  isEnded,
  type MatterStepNow,
  matterBookOf,
  matterPeopleOf,
} from "./matter-read";
import { mattersNow, readMatterRecords, readMatters } from "./matters";
import { LINKS } from "./memory-files";
import { foundQuotes } from "./quote-check";
import { OWNER } from "./read-truth";
import { begin, chunks, inBatches } from "./run";
import type { People } from "./who";
import { dayNow } from "./zones";

// Links (docs/glossary.md): two records tied. The one relation read so far is "ends": a later record (an observation,
// or an episode) shows that an open step of a matter (a promise, a wait, a to-do of his) happened or was dropped. One
// model call per matter is shown its open steps and its later records (`laterRecordsOf`: its own later steps, and since
// v3 its people's records of the week after that no matter holds, so an ending never ties two matters); code keeps a
// link only when both ends were shown, the later one is later (`isLater`), and the words given are found in the later
// one's own quote. Each judged batch is one appended line of memory/links.jsonl: the result, and the
// record of which pairs were already judged, so what is due is derived and nothing is paid twice. A link never
// deletes: what it ends is worked out when read (`endingsOf`). Off until his `links` setting.

const PROMPT = "memory-links.v3";
/** The most open steps, and later steps, one call is shown. */
const OPEN_MAX = 40;
const LATER_MAX = 40;
/** The most of its people's records a matter is shown beyond its own steps, and the days after its newest open step they may be from. */
const LATER_RECORDS_MAX = 20;
const LATER_RECORDS_DAYS = 7;
/** The most calls a night makes, and the most of them one matter takes: a long backlog neither starves nor is starved. */
const NIGHT_CALLS = 100;
const SUBJECT_CALLS = 10;
/** What a call's reply is allowed, in tokens, for the count shown before a run. */
const REPLY_TOKENS = 400;

/** A step as a call is shown it: `id` is an observation's or an episode's. */
interface Shown {
  at: string;
  day: string;
  id: string;
  quote: string;
  said_by?: string;
  text: string;
  type: string;
}
/** What one call judges: some of a matter's open steps against some of its later steps. */
interface Call {
  later: Shown[];
  open: Shown[];
}
/** One matter's due work tonight: its open steps, and its later steps in the chunks to judge, oldest first. `subject` is the matter's id. */
export interface SubjectWork {
  chunks: Shown[][];
  name: string;
  open: Shown[];
  subject: string;
}

/**
 * One matter's work: the later steps that some open step has not been judged against yet (a pair is judged once a
 * batch holds the open step in `open` and the later one in `offered`), oldest first, in chunks of `LATER_MAX`, with
 * the open steps they are due for. Nothing when nothing is due.
 */
export function subjectWorkOf(
  matter: { id: string; name: string },
  open: Shown[],
  later: Shown[],
  batches: LinkBatch[]
): SubjectWork | null {
  const judged = new Set(
    batches.flatMap((b) =>
      b.open.flatMap((o) => b.offered.map((l) => `${o} ${l}`))
    )
  );
  const isDue = (o: Shown, l: Shown) =>
    isLater(o, l) && !judged.has(`${o.id} ${l.id}`);
  const due = later
    .filter((l) => open.some((o) => isDue(o, l)))
    .toSorted((a, b) => a.at.localeCompare(b.at));
  const dueOpen = open.filter((o) => due.some((l) => isDue(o, l)));
  return due.length > 0
    ? {
        chunks: chunks(due, LATER_MAX),
        name: matter.name,
        open: dueOpen,
        subject: matter.id,
      }
    : null;
}

/** The calls a night takes: the matters whose due work is oldest first, each up to `SUBJECT_CALLS`, `NIGHT_CALLS` in all. */
export function nightOf(work: SubjectWork[]) {
  const callsOf = (w: SubjectWork) => Math.ceil(w.open.length / OPEN_MAX);
  let room = NIGHT_CALLS;
  return work
    .toSorted((a, b) =>
      (a.chunks[0]?.[0]?.at ?? "").localeCompare(b.chunks[0]?.[0]?.at ?? "")
    )
    .flatMap((w) => {
      const each = callsOf(w);
      // At least one chunk while the night has room for it: someone with very many open things is never left out.
      const n = Math.min(
        w.chunks.length,
        Math.max(
          Math.floor(Math.min(room, SUBJECT_CALLS) / each),
          Number(each <= room)
        )
      );
      room -= n * each;
      return n > 0 ? [{ ...w, chunks: w.chunks.slice(0, n) }] : [];
    });
}

/** Whether `l` can end `o`: said after it; an episode from the same day on (a call that settles it the same day counts, the words decide). */
export const isLater = (o: Shown, l: Shown) =>
  l.type === "episode" ? l.day >= o.day : l.at > o.at;

const Reply = z.object({
  links: z
    .array(
      z.object({ earlier: z.string(), later: z.string(), quote: z.string() })
    )
    .default([]),
});

/**
 * A reply's links as kept: both ends among those shown, the later one said after the earlier, and the words given
 * found in the later step's own quote (stored as found there). Anything else is dropped, never trusted. Every
 * link that passes is kept; `endingsOf` alone decides which one ends a thing.
 */
export function keptLinks(reply: unknown, call: Call): Link[] {
  const open = new Map(call.open.map((o) => [o.id, o]));
  const later = new Map(call.later.map((o) => [o.id, o]));
  return Reply.parse(reply).links.flatMap((l) => {
    const [a, b] = [open.get(l.earlier), later.get(l.later)];
    const [found] = b ? foundQuotes([l.quote], [{ text: b.quote }]) : [];
    return a && b && isLater(a, b) && found
      ? [
          Link.parse({
            earlier: a.id,
            later: b.id,
            quote: found.text.slice(0, 300),
            relation: "ends",
          }),
        ]
      : [];
  });
}

/**
 * A matter's steps split for a call: the open ones (promises, waits and to-dos of his that are observations no link
 * ended) and the later ones (the other observations and the episodes; never a plan or a condition, never another
 * open step, so a step repeating a promise is no ending).
 */
export function splitSteps(
  steps: MatterStepNow[],
  byId: ReadonlyMap<string, { modality?: string | null }>
) {
  const isOpen = (s: MatterStepNow) =>
    byId.has(s.ref) && ACTIONABLE.includes(s.kind) && !isEnded(s);
  return {
    later: steps.filter((s) => {
      const o = byId.get(s.ref);
      return (
        !isOpen(s) &&
        (s.kind === "episode" ||
          (o && o.modality !== "plan" && o.modality !== "conditional"))
      );
    }),
    open: steps.filter(isOpen),
  };
}

type LaterObservation = Pick<
  Observation,
  "at" | "date" | "id" | "modality" | "speaker" | "subjects" | "type"
>;

/**
 * A matter's later records beyond its own steps: its people's observations (speaker or a subject, as `refOf` reads
 * them now) from its oldest open step's day to `LATER_RECORDS_DAYS` after its newest, that no matter holds, never a
 * plan, a condition or a promise, wait or to-do; the earliest `LATER_RECORDS_MAX`. One held elsewhere is that matter's
 * (September's rent is not ended by November's).
 */
export function laterRecordsOf<T extends LaterObservation>(
  open: readonly MatterStepNow[],
  people: ReadonlySet<string>,
  observations: readonly T[],
  isHeld: (id: string) => boolean,
  refOf: (ref: string) => string
) {
  const days = open.map((s) => s.day).toSorted();
  const [from, last] = [days[0], days.at(-1)];
  if (!(from && last)) {
    return [];
  }
  const to = daysBefore(last, -LATER_RECORDS_DAYS);
  return observations
    .filter(
      (o) =>
        o.date >= from &&
        o.date <= to &&
        !isHeld(o.id) &&
        !ACTIONABLE.includes(o.type) &&
        o.modality !== "plan" &&
        o.modality !== "conditional" &&
        [o.speaker, ...o.subjects].some((r) => people.has(refOf(r)))
    )
    .toSorted((a, b) => a.at.localeCompare(b.at))
    .slice(0, LATER_RECORDS_MAX);
}

/**
 * The open matters, each with its open steps (promises, waits and to-dos of his with no ending: a step a link already
 * ended is not judged again) and its later records (`splitSteps`, then `laterRecordsOf`), as a call is shown them. A
 * matter of one has no work. The records are read once, the book built from them.
 */
async function readOpenMatters(people: People) {
  const records = await readMatterRecords(people);
  const book = matterBookOf(mattersNow(readMatters()), records, dayNow());
  const byId = new Map(records.observations.map((o) => [o.id, o]));
  const held = new Set(
    book.flatMap((m) => (m.lone ? [] : m.steps.map((s) => s.ref)))
  );
  const said = (speaker: string) =>
    speaker === OWNER ? "him" : people.nameOf(speaker);
  const shown = (s: MatterStepNow): Shown => {
    const o = byId.get(s.ref);
    return {
      at: s.at,
      day: s.day,
      id: s.ref,
      quote: s.quote,
      said_by: o && said(o.speaker),
      text: s.text,
      type: s.kind,
    };
  };
  return book.flatMap((m) => {
    if (!m.open || m.lone) {
      return [];
    }
    const { later, open } = splitSteps(m.steps, byId);
    const matterPeople = new Set(
      [...matterPeopleOf(m), ...open.flatMap((s) => s.with ?? [])].map(
        records.refOf
      )
    );
    const others = laterRecordsOf(
      open,
      matterPeople,
      records.observations,
      (id) => held.has(id),
      records.refOf
    ).map(
      (o): Shown => ({
        at: o.at,
        day: o.date,
        id: o.id,
        quote: o.quote,
        said_by: said(o.speaker),
        text: o.text,
        type: o.type,
      })
    );
    return open.length > 0
      ? [
          {
            id: m.id,
            later: [...later.map(shown), ...others],
            name: m.name,
            open: open.map(shown),
          },
        ]
      : [];
  });
}

/**
 * What the links step has to judge: for each open matter, its open steps and its later steps (`readOpenMatters`)
 * not judged yet. `counts` is the whole of what is due, before the night's cap.
 */
export async function readLinkWork(people: People) {
  const batches = readBatches();
  const work = (await readOpenMatters(people)).flatMap(
    (m) => subjectWorkOf(m, m.open, m.later, batches) ?? []
  );
  const calls = work.flatMap((w) =>
    w.chunks.flatMap((later) =>
      chunks(w.open, OPEN_MAX).map((open) => ({ later, open }))
    )
  );
  const chars = (list: Shown[]) =>
    list.reduce((n, o) => n + o.text.length + o.quote.length + 60, 0);
  return {
    counts: {
      calls: calls.length,
      matters: work.length,
      open: new Set(work.flatMap((w) => w.open.map((o) => o.id))).size,
      // A ceiling: what is shown at 3 characters a token, plus a full reply for each call.
      tokens: Math.round(
        calls.reduce((n, c) => n + chars(c.open) + chars(c.later), 0) / 3 +
          calls.length * REPLY_TOKENS
      ),
    },
    work: nightOf(work),
  };
}
export type LinkWork = NonNullable<Awaited<ReturnType<typeof readLinkWork>>>;

/**
 * Judges the night's work (`readLinkWork`), a few matters at a time: each chunk of later steps against the matter's
 * open steps, one appended line per chunk once all its calls returned (a failed call leaves the chunk due). A failure
 * costs that matter's chunk only, never the night.
 */
export async function links(pending: LinkWork) {
  const step = await begin("links", "main", { prompt: PROMPT });
  const shown = ({ at: _at, ...s }: Shown) => s;
  let found = 0;
  await inBatches(pending.work, step, async (w, dir) => {
    for (const [i, later] of w.chunks.entries()) {
      // biome-ignore lint/performance/noAwaitInLoops: one matter's chunks in order, each appended when whole
      await step.attempt(
        async () => {
          const kept: Link[] = [];
          for (const [j, open] of chunks(w.open, OPEN_MAX).entries()) {
            // biome-ignore lint/performance/noAwaitInLoops: a chunk's calls in order, a failed one leaves it due
            const reply = await step.ask({
              dir: join(dir, `${i + 1}-${j + 1}`),
              input: {
                later: later.map(shown),
                matter: w.name,
                open: open.map(shown),
              },
              prompt: PROMPT,
            });
            kept.push(...keptLinks(reply, { later, open }));
          }
          appendJsonl(LINKS, LinkBatch, [
            {
              at: step.now.toISOString(),
              links: kept,
              madeBy: stamp(step.llm, PROMPT, step.run),
              offered: later.map((o) => o.id),
              open: w.open.map((o) => o.id),
              schemaVersion: 1,
              subject: w.subject,
            },
          ]);
          found += kept.length;
        },
        { page: w.subject }
      );
    }
  });
  return step.end({ links: found, matters: pending.work.length });
}

/**
 * A matter's open steps, each with the ending the links step found (its words and day) or none: how a link is checked
 * by eye while nothing reads them (`bun life memory links <matter id>`).
 */
export async function readEndings(people: People, id: string) {
  const records = await readMatterRecords(people);
  const { endings } = endingsNow((ref) => records.current.has(ref));
  const matter = matterBookOf(
    mattersNow(readMatters()),
    records,
    dayNow()
  ).find((m) => m.id === id);
  // The later record may be any current one, in this matter or none.
  const dayOf = new Map([
    ...records.observations.map((o): [string, string] => [o.id, o.date]),
    ...records.episodes.map((e): [string, string] => [
      e.id,
      episodeAt(e).slice(0, 10),
    ]),
  ]);
  const isObservation = new Set(records.observations.map((o) => o.id));
  return (matter?.steps ?? [])
    .filter((s) => isObservation.has(s.ref) && ACTIONABLE.includes(s.kind))
    .map((s) => {
      const end = endings.get(s.ref);
      return `- ${s.ref} ${s.day} ${s.kind}: ${s.text}\n    ${end ? `ended ${dayOf.get(end.later)}: "${end.quote}" (${end.later})` : "no ending found"}`;
    });
}
