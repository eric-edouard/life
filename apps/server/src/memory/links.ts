import { join } from "node:path";
import { z } from "zod";
import { appendJsonl, readAppended } from "../core/files";
import { stamp } from "../models/llm";
import { Link, LinkBatch } from "../records/link";
import type { Observation } from "../records/observation";
import { LINKS, readIndex } from "./memory-files";
import { foundQuotes } from "./quote-check";
import { openCandidatesOf } from "./read-open-items";
import { OWNER } from "./read-truth";
import { begin, chunks, inBatches } from "./run";
import { observationsNow, type People } from "./who";

// Links (docs/glossary.md): two observations tied. The one relation read so far is "ends": a later observation shows
// that an open thing between him and a person (a promise, a wait, a to-do of his) happened or was dropped. One model
// call per person is shown their open things and the later observations about them; code keeps a link only when both
// ends were shown, the later one is later, and the words given are found in the later one's own quote. Each judged
// batch is one appended line of memory/links.jsonl: the result, and the record of which pairs were already judged, so
// what is due is derived and nothing is paid twice. Nothing reads the links yet (in shadow); a link never deletes: what
// it ends is worked out when read (`endingsOf`). Off until his `links` setting.

const PROMPT = "memory-links.v1";
/** The most open things, and later observations, one call is shown. */
const OPEN_MAX = 40;
const LATER_MAX = 40;
/** The most calls a night makes, and the most of them one person takes: a long backlog neither starves nor is starved. */
const NIGHT_CALLS = 100;
const SUBJECT_CALLS = 10;
/** What a call's reply is allowed, in tokens, for the count shown before a run. */
const REPLY_TOKENS = 400;

/** An observation as a call is shown it. */
interface Shown {
  day: string;
  id: string;
  quote: string;
  said_by: string;
  text: string;
  type: string;
}
/** What one call judges: some of a person's open things against some later observations about them. */
interface Call {
  later: Observation[];
  open: Observation[];
}
/** One person's due work tonight: the open things, and the later observations in the chunks to judge, oldest first. */
export interface SubjectWork {
  chunks: Observation[][];
  open: Observation[];
  subject: string;
}

const readBatches = () =>
  readAppended(
    LINKS,
    LinkBatch,
    (last?: LinkBatch[]) => [...(last ?? [])],
    (all, b) => {
      all.push(b);
    }
  );

/**
 * What each open thing is ended by: its first link, in the order judged, whose two ends are both current (`isCurrent`:
 * an end re-read away counts for nothing, as a replacement re-read away retires nothing; the pair is judged again
 * under its new ids). The one place that decides what a link ends.
 */
export function endingsOf(
  batches: LinkBatch[],
  isCurrent: (id: string) => boolean
) {
  const endings = new Map<string, Link & { at: string }>();
  for (const b of batches) {
    for (const l of b.links) {
      if (
        !endings.has(l.earlier) &&
        isCurrent(l.earlier) &&
        isCurrent(l.later)
      ) {
        endings.set(l.earlier, { ...l, at: b.at });
      }
    }
  }
  return endings;
}

/**
 * One person's work: the later observations about them that some open thing has not been judged against yet (a pair
 * is judged once a batch holds the open thing in `open` and the later one in `offered`), oldest first, in chunks of
 * `LATER_MAX`, with the open things they are due for. Nothing when nothing is due.
 */
export function subjectWorkOf(
  subject: string,
  open: Observation[],
  later: Observation[],
  batches: LinkBatch[]
): SubjectWork | null {
  const judged = new Set(
    batches
      .filter((b) => b.subject === subject)
      .flatMap((b) => b.open.flatMap((o) => b.offered.map((l) => `${o} ${l}`)))
  );
  const isDue = (o: Observation, l: Observation) =>
    l.at > o.at && !judged.has(`${o.id} ${l.id}`);
  const due = later
    .filter((l) => open.some((o) => isDue(o, l)))
    .toSorted((a, b) => a.at.localeCompare(b.at));
  const dueOpen = open.filter((o) => due.some((l) => isDue(o, l)));
  return due.length > 0
    ? { chunks: chunks(due, LATER_MAX), open: dueOpen, subject }
    : null;
}

/** The calls a night takes: the people whose due work is oldest first, each up to `SUBJECT_CALLS`, `NIGHT_CALLS` in all. */
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

const Reply = z.object({
  links: z
    .array(
      z.object({ earlier: z.string(), later: z.string(), quote: z.string() })
    )
    .default([]),
});

/**
 * A reply's links as kept: both ends among those shown, the later one said after the earlier, and the words given
 * found in the later observation's own quote (stored as found there). Anything else is dropped, never trusted. Every
 * link that passes is kept; `endingsOf` alone decides which one ends a thing.
 */
export function keptLinks(reply: unknown, call: Call): Link[] {
  const open = new Map(call.open.map((o) => [o.id, o]));
  const later = new Map(call.later.map((o) => [o.id, o]));
  return Reply.parse(reply).links.flatMap((l) => {
    const [a, b] = [open.get(l.earlier), later.get(l.later)];
    const [found] = b ? foundQuotes([l.quote], [{ text: b.quote }]) : [];
    return a && b && b.at > a.at && found
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
 * What the links step has to judge, from the index (the open things, as `openCandidatesOf` finds them: the one rule
 * of what is open) and the observations as they read today: for each person an open thing is with, the later
 * observations about them (what they or he said that names them; never a plan or a condition, never another open
 * thing). `counts` is the whole of what is due, before the night's cap. Null when the index is not built.
 */
export async function readLinkWork(people: People) {
  const candidates = readIndex((db) => openCandidatesOf(db, "1 = 1"));
  if (!candidates) {
    return null;
  }
  const { observations } = await observationsNow(people);
  const byId = new Map(observations.map((o) => [o.id, o]));
  const openIds = new Set(candidates.map((c) => c.id));
  const batches = readBatches();
  const bySubject = Map.groupBy(
    candidates.filter((c) => c.person?.startsWith("person:")),
    (c) => c.person as string
  );
  const work = [...bySubject].flatMap(([subject, list]) => {
    const open = list.flatMap((c) => byId.get(c.id) ?? []);
    const later = observations.filter(
      (o) =>
        !openIds.has(o.id) &&
        o.modality !== "plan" &&
        o.modality !== "conditional" &&
        (o.speaker === subject || o.entities.includes(subject))
    );
    return subjectWorkOf(subject, open, later, batches) ?? [];
  });
  const calls = work.flatMap((w) =>
    w.chunks.flatMap((later) =>
      chunks(w.open, OPEN_MAX).map((open) => ({ later, open }))
    )
  );
  const chars = (list: Observation[]) =>
    list.reduce((n, o) => n + o.text.length + o.quote.length + 60, 0);
  return {
    counts: {
      calls: calls.length,
      noSubject: candidates.length - [...bySubject.values()].flat().length,
      open: new Set(work.flatMap((w) => w.open.map((o) => o.id))).size,
      people: work.length,
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
 * Judges the night's work (`readLinkWork`), a few people at a time: each chunk of later observations against the
 * person's open things, one appended line per chunk once all its calls returned (a failed call leaves the chunk due).
 * A failure costs that person's chunk only, never the night.
 */
export async function links(pending: LinkWork, people: People) {
  const step = await begin("links", "main", { prompt: PROMPT });
  const shown = (o: Observation): Shown => ({
    day: o.date,
    id: o.id,
    quote: o.quote,
    said_by: o.speaker === OWNER ? "him" : people.nameOf(o.speaker),
    text: o.text,
    type: o.type,
  });
  let found = 0;
  await inBatches(pending.work, step, async (w, dir) => {
    for (const [i, later] of w.chunks.entries()) {
      // biome-ignore lint/performance/noAwaitInLoops: one person's chunks in order, each appended when whole
      await step.attempt(
        async () => {
          const kept: Link[] = [];
          for (const [j, open] of chunks(w.open, OPEN_MAX).entries()) {
            // biome-ignore lint/performance/noAwaitInLoops: a chunk's calls in order, a failed one leaves it due
            const reply = await step.ask({
              dir: join(dir, `${i + 1}-${j + 1}`),
              input: {
                later: later.map(shown),
                open: open.map(shown),
                with: people.nameOf(w.subject),
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
  return step.end({ links: found, people: pending.work.length });
}

/**
 * A person's open things, each with the ending the links step found (its words and day) or none: how a link is checked
 * by eye while nothing reads them (`bun life memory links <person>`).
 */
export async function readEndings(people: People, ref: string) {
  const { observations } = await observationsNow(people);
  const byId = new Map(observations.map((o) => [o.id, o]));
  const endings = endingsOf(readBatches(), (id) => byId.has(id));
  const open =
    readIndex((db) =>
      openCandidatesOf(db, "1 = 1").filter((c) => c.person === ref)
    ) ?? [];
  return open.map((c) => {
    const end = endings.get(c.id);
    const by = end && byId.get(end.later);
    return `${c.line}\n    ${by ? `ended ${by.date}: "${end.quote}" (${by.id})` : "no ending found"}`;
  });
}
