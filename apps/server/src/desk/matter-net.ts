import type { Database } from "bun:sqlite";
import { daysBefore } from "../core/clock";
import { closestOf, type Embedder, embedAll } from "../core/embedder";
import { readChangeStamp } from "../core/files";
import { packed } from "../core/lists";
import { log } from "../core/log";
import { activeAgents, anchorsOf } from "../host/desk-read";
import type { MessagePayload } from "../host/events";
import { matterFinderOf, netOf } from "../memory/matter-read";
import { readMatterBook } from "../memory/matters";
import {
  CORRECTIONS,
  EPISODES,
  EXTRACTED,
  LEDGER,
  LINKS,
  MATTERS,
  OBSERVATIONS,
  readUnitsOf,
  SUPERSESSIONS,
} from "../memory/memory-files";
import { kindOf } from "../memory/sources";
import { embedderNow } from "../memory/vectors";
import type { People } from "../memory/who";
import { spokenLines } from "../memory/words";
import { dayNow } from "../memory/zones";
import type { Desk } from "./desk-store";

// The wide net (his word of 18 Nov 2026, the agent asks spec's "His yes and his addition"): an agent on a matter is woken
// by anything new related to it: a message from one of its people, or any new message or recording of his pendant whose
// meaning is close to the matter (the Mac's own embedder: no model call, nothing leaves the Mac). A wake only queues its
// facts (`matter.related`); the agent reads the words itself, as data, and the nightly matters step still decides what
// belongs to the matter.

export const MATTER_RELATED = "matter.related";
/**
 * At or above this similarity a text is close to one of a matter's texts. On his data (18 Nov 2026, 159 running
 * matters, two weeks of messages and a week of recordings): about 7 in 10 of the wakes it makes are about their
 * matter, one a matter every 6 days; made-up related messages scored 0.64 to 0.71, unrelated ones 0.32 at most.
 */
const CLOSE_AT = 0.55;
/** A text shorter than this is never compared in meaning ("ok", "thanks"). */
const MIN_CHARS = 20;
/** A recording's new words are compared in parts of at most this many characters (the embedder reads about 2,000 bytes). */
const PART_CHARS = 1500;
/**
 * What the matter book is read from (its steps, endings, his word, the to-do items): a change to any of them builds the
 * nets again, so a matter he marks done ends its agent on the next poll. Units are left out, as the checks do: the
 * watcher writes them every few minutes, and a matter changes only through the files here.
 */
const NETS_READ = [
  CORRECTIONS,
  EPISODES,
  EXTRACTED,
  LEDGER,
  LINKS,
  MATTERS,
  OBSERVATIONS,
  SUPERSESSIONS,
];

/** An agent's matter as the net reads it: its people, and its texts' vectors. */
interface Net {
  agent: string;
  /** Its matter is done (by his word or its own steps' endings, never a link's "probably"): the desk ends the agent. */
  isDone: boolean;
  people: ReadonlySet<string>;
  /** When the agent started: nothing said before is new to it. */
  since: string;
  vectors: number[][];
}

/**
 * A text's vector as a query, kept per process by its text (no invalidation: the same text, the same vector).
 * ponytail: never pruned; it holds the active agents' matter texts as they change, a few thousand a year at most.
 */
const queries = new Map<string, number[]>();
const kept = new WeakMap<Database, { key: string; nets: Net[] }>();

const embedderOf = (desk: Desk) =>
  desk.embedder === undefined ? embedderNow() : desk.embedder;

/** The vectors of `texts` as queries, or none when the embedder fails (logged): the net then matches by people only. */
async function queryVectors(embedder: Embedder | null, texts: string[]) {
  const missing = texts.filter((t) => !queries.has(t));
  if (embedder && missing.length > 0) {
    try {
      const vectors = await embedder.embed(missing, "query");
      for (const [i, t] of missing.entries()) {
        queries.set(t, vectors[i] ?? []);
      }
    } catch (error) {
      log("desk.net", { error: String(error), ok: false, what: "embed" });
      return null;
    }
  }
  return texts.flatMap((t) => {
    const v = queries.get(t);
    return v ? [v] : [];
  });
}

/**
 * The nets of the active agents on a matter (an agent on a project has none), its matter found by its anchors. The
 * matter book is read again only once the agents, their anchors, his day or what it is read from (`NETS_READ`, by its
 * change stamp: stats, no read) changed; a net whose vectors
 * the embedder could not make is not kept, so the next poll tries again.
 */
export async function netsOf(desk: Desk, people: People) {
  const { db } = desk;
  const agents = activeAgents(db).flatMap((a) => {
    const steps = anchorsOf(db, a.id);
    return steps.length > 0 ? [{ a, steps }] : [];
  });
  if (agents.length === 0) {
    return [];
  }
  const key = JSON.stringify([
    readChangeStamp(NETS_READ),
    dayNow(),
    agents.map(({ a, steps }) => [a.id, steps]),
  ]);
  const was = kept.get(db);
  if (was?.key === key) {
    return was.nets;
  }
  const find = matterFinderOf(await readMatterBook(people, dayNow()));
  const embedder = embedderOf(desk);
  let isWhole = true;
  const nets: Net[] = [];
  for (const { a, steps } of agents) {
    const v = find(steps);
    if (!v) {
      continue;
    }
    const net = netOf(v);
    // biome-ignore lint/performance/noAwaitInLoops: one embedder, one batch at a time
    const vectors = await queryVectors(embedder, net.texts);
    isWhole &&= vectors !== null;
    nets.push({
      agent: a.id,
      isDone: v.status === "done",
      people: net.people,
      since: a.created_at,
      vectors: vectors ?? [],
    });
  }
  if (isWhole) {
    kept.set(db, { key, nets });
  }
  return nets;
}

/** Why a text is related to a net: its person, else its meaning (with how close), else not. */
type Why = { why: "person" } | { similarity: number; why: "meaning" };

/**
 * For each text (`person`: who wrote or said it, none for his own), each net it relates to and why: by its person, or by
 * its meaning at `CLOSE_AT` or more. The texts are embedded as passages, once; when the embedder is missing or fails
 * (logged), only people match and `isWhole` is false.
 */
async function relatedOf(
  desk: Desk,
  nets: Net[],
  texts: { person: string | null; text: string }[]
) {
  const embedder = embedderOf(desk);
  const compared = texts.filter((t) => t.text.length >= MIN_CHARS);
  let vectors: number[][] = [];
  let isWhole = compared.length === 0 || !nets.some((n) => n.vectors.length);
  if (embedder && !isWhole) {
    try {
      vectors = await embedAll(
        embedder,
        compared.map((t) => t.text)
      );
      isWhole = true;
    } catch (error) {
      log("desk.net", { error: String(error), ok: false, what: "embed" });
    }
  }
  const vectorOf = new Map(compared.map((t, i) => [t, vectors[i]]));
  const related = texts.map((t) =>
    nets.flatMap((net): (Why & { agent: string })[] => {
      if (t.person && net.people.has(t.person)) {
        return [{ agent: net.agent, why: "person" }];
      }
      const vector = vectorOf.get(t);
      const similarity = vector ? closestOf(net.vectors, vector) : -1;
      return similarity >= CLOSE_AT
        ? [
            {
              agent: net.agent,
              similarity: Math.round(similarity * 100) / 100,
              why: "meaning",
            },
          ]
        : [];
    })
  );
  return { isWhole, related };
}

/** The new messages each net relates to (`relatedOf`): one wake each, its facts and why. */
export async function relatedMessages(
  desk: Desk,
  nets: Net[],
  messages: { fromMe: boolean; m: MessagePayload; text: string }[]
) {
  // ponytail: with the embedder down, a message is matched by its person only and the cursor moves on; the nightly
  // matters step still places it. Hold the cursor if a missed wake ever matters.
  const { related } = await relatedOf(
    desk,
    nets,
    messages.map((x) => ({
      person: x.fromMe ? null : x.m.person,
      text: x.text,
    }))
  );
  return messages.flatMap((x, i) =>
    (related[i] ?? []).map(({ agent, ...why }) => ({
      agent,
      eventId: x.m.id,
      payload: { ...x.m, ...why },
    }))
  );
}

/** Per desk, how far each recording was read (its unit's end), in this process: after a restart, read again from each agent's start. */
const heardTo = new WeakMap<Database, Map<string, string>>();

/**
 * The new words of his pendant's recordings (the voice units of today and yesterday, as the watcher wrote them once
 * their speech was complete) that a net relates to: per recording, the lines after what was read of it (and after the
 * agent started), by who spoke or in parts by meaning. A recording whose words can't be read is read again next poll.
 */
export async function relatedRecordings(
  desk: Desk,
  nets: Net[],
  people: People
) {
  if (nets.length === 0) {
    return [];
  }
  const read = heardTo.get(desk.db) ?? new Map<string, string>();
  heardTo.set(desk.db, read);
  const today = dayNow();
  const oldest = nets.map((n) => n.since).toSorted()[0] ?? "";
  const voice = readUnitsOf([daysBefore(today, 1), today]).filter(
    (u) => kindOf(u.source) === "voice" && !u.drop
  );
  // Only the two days are kept: an older recording is never read again.
  const held = new Set(voice.map((u) => u.id));
  for (const id of read.keys()) {
    if (!held.has(id)) {
      read.delete(id);
    }
  }
  const units = voice.filter((u) => u.end > (read.get(u.id) ?? oldest));
  if (units.length === 0) {
    return [];
  }
  let spoken: Awaited<ReturnType<typeof spokenLines>>;
  try {
    spoken = await spokenLines(units, people.resolve, people.truth);
  } catch (error) {
    log("desk.net", { error: String(error), ok: false, what: "voice" });
    return [];
  }
  const wakes = await Promise.all(
    units.map(async (u) => {
      const from = read.get(u.id) ?? oldest;
      const lines = (spoken.get(u.id) ?? []).filter((l) => l.at > from);
      const parts = packed(lines, PART_CHARS, (l) => l.text.length + 1);
      const { isWhole, related } = await relatedOf(desk, nets, [
        ...lines.map((l) => ({ person: people.refOf(l.speaker), text: "" })),
        ...parts.map((p) => ({
          person: null,
          text: p.map((l) => l.text).join("\n"),
        })),
      ]);
      if (isWhole) {
        read.set(u.id, u.end);
      }
      const at = lines.at(-1)?.at ?? u.end;
      // One wake per agent and recording's new words: by a person first, else its closest part.
      const best = new Map<string, Why>();
      for (const r of related.flat()) {
        const had = best.get(r.agent);
        if (
          !had ||
          (had.why === "meaning" &&
            (r.why === "person" || r.similarity > had.similarity))
        ) {
          const { agent, ...why } = r;
          best.set(agent, why);
        }
      }
      return [...best].flatMap(([agent, why]) =>
        at > (nets.find((n) => n.agent === agent)?.since ?? "")
          ? [
              {
                agent,
                eventId: `${u.id}@${at}`,
                payload: { at, id: u.id, source: u.source, ...why },
              },
            ]
          : []
      );
    })
  );
  return wakes.flat();
}
