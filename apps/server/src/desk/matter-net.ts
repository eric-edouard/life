import type { Database } from "bun:sqlite";
import { daysBefore } from "../core/clock";
import { closestOf, type Embedder, embedAll } from "../core/embedder";
import { readChangeStamp } from "../core/files";
import { packed } from "../core/lists";
import { log } from "../core/log";
import {
  agentOf,
  anchorsOf,
  assignmentOf,
  assignmentOfCard,
  openAssignments,
  openTurn,
  standingAgents,
} from "../host/desk-read";
import { isOnOrAfter } from "../host/event-channels";
import type { MessagePayload } from "../host/events";
import { decisionsNow } from "../memory/decisions";
import { MATTER_OVER_OUTCOME } from "../memory/held-matters";
import {
  endedStepsOf,
  isRunning,
  type MatterView,
  matterFinderOf,
  matterPeopleOf,
  matterTextOf,
} from "../memory/matter-read";
import { MATTER_BOOK_READS, readMatterBookAndRecords } from "../memory/matters";
import { readUnitsOf } from "../memory/memory-files";
import { agentForMatterOf } from "../memory/read-matters";
import { kindOf } from "../memory/sources";
import { embedderNow } from "../memory/vectors";
import type { People } from "../memory/who";
import { spokenLines } from "../memory/words";
import { dayNow } from "../memory/zones";
import type { OpenedBy } from "../records/registered-agent";
import { closeAssignment } from "./agent-actions";
import { type Desk, moveAssignment } from "./desk-store";
import {
  holdersOf,
  queue,
  type ReadPeople,
  routeOf,
  type WakeWhy,
} from "./event-queue";

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
/** How many of a matter's newest steps its net compares with. */
const NET_STEPS = 8;

/**
 * A matter's net: who it is with in any role, and the texts a new message
 * or recording is compared with in meaning: its name and goal, its next step, its newest steps' words. Pure.
 */
const netOf = (v: MatterView) => ({
  people: new Set(matterPeopleOf(v)),
  texts: [
    matterTextOf(v),
    ...(v.nextStep ? [v.nextStep.text] : []),
    ...v.steps.slice(-NET_STEPS).map((s) => s.text),
  ],
});

/** An assignment's matter as the net reads it: its people, and its texts' vectors. */
interface Net {
  assignment: string;
  people: ReadonlySet<string>;
  /** When the assignment was opened: nothing said before is new to it. */
  since: string;
  vectors: number[][];
}

/**
 * A text's vector as a query, kept per process by its text (no invalidation: the same text, the same vector).
 * ponytail: never pruned; it holds the active agents' matter texts as they change, a few thousand a year at most.
 */
const queries = new Map<string, number[]>();
/** An assignment the desk closes on its matter, and the outcome it closes with (`endOutcomeOf`). */
interface MatterEnd {
  assignment: string;
  outcome: string;
}
/** An open matter assignment the fold moves, and the agent that takes its matter (`agentForOf`). */
interface MatterFold {
  assignment: string;
  to: string;
}
const kept = new WeakMap<
  Database,
  { ends: MatterEnd[]; folds: MatterFold[]; key: string; nets: Net[] }
>();

/** The outcome of an agent ended because its matter is done: by his word or its own steps' endings, never a link's "probably". */
export const MATTER_DONE_OUTCOME = "its matter is done";

/**
 * Why the desk closes an assignment on its matter, as the outcome it closes with, or null: a matter that is done closes
 * any; one no longer running (probably done, dormant, closed) closes only one the desk opened (`MATTER_OVER_OUTCOME`,
 * after which it holds nothing): a link's "probably" is a model's reading until his word, and one he opened stays until
 * he stops it, or his word makes the matter done. Pure.
 */
export const endOutcomeOf = (
  openedBy: OpenedBy,
  v: Parameters<typeof isRunning>[0]
) => {
  if (v.status === "done") {
    return MATTER_DONE_OUTCOME;
  }
  return openedBy === "desk" && !isRunning(v) ? MATTER_OVER_OUTCOME : null;
};

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
 * What the open assignments on a matter (an agent's own has none) read of it, its matter found by its anchors: the
 * nets, the assignments to close on it (`endOutcomeOf`; steps no matter holds count once every one has ended,
 * `endedStepsOf`), and those the fold moves to the agent that takes their matter (`agentForMatterOf`, among the
 * standing agents). The matter book is read again only once the assignments, their anchors, the standing agents, his
 * day or what it is read from (`MATTER_BOOK_READS`, by its change stamp: stats, no read) changed; a net whose vectors the embedder could not make
 * is not kept, so the next poll tries again.
 */
async function readOnMatters(desk: Desk, people: People) {
  const { db } = desk;
  const onMatters = openAssignments(db).flatMap((a) => {
    const steps = anchorsOf(db, a.id);
    return steps.length > 0 ? [{ a, steps }] : [];
  });
  if (onMatters.length === 0) {
    return { ends: [], folds: [], nets: [] };
  }
  const standing = standingAgents(db);
  const key = JSON.stringify([
    readChangeStamp(MATTER_BOOK_READS),
    dayNow(),
    onMatters.map(({ a, steps }) => [a.id, a.agent_id, steps]),
    standing,
  ]);
  const was = kept.get(db);
  if (was?.key === key) {
    return was;
  }
  const today = dayNow();
  const { book, records } = await readMatterBookAndRecords(people, today);
  const find = matterFinderOf(book);
  // No standing agent: nothing to fold into.
  const take =
    standing.length > 0
      ? agentForMatterOf(standing, people.truth)
      : () => undefined;
  const embedder = embedderOf(desk);
  let isWhole = true;
  const nets: Net[] = [];
  const ends: MatterEnd[] = [];
  const folds: MatterFold[] = [];
  for (const { a, steps } of onMatters) {
    const v = find(steps);
    const ended = v ?? endedStepsOf(steps, records, today);
    const outcome = ended && endOutcomeOf(a.opened_by, ended);
    if (outcome) {
      ends.push({ assignment: a.id, outcome });
    }
    if (!v) {
      continue;
    }
    const to = take(v);
    if (to && to !== a.agent_id) {
      folds.push({ assignment: a.id, to });
    }
    const net = netOf(v);
    // biome-ignore lint/performance/noAwaitInLoops: one embedder, one batch at a time
    const vectors = await queryVectors(embedder, net.texts);
    isWhole &&= vectors !== null;
    nets.push({
      assignment: a.id,
      people: net.people,
      since: a.opened_at,
      vectors: vectors ?? [],
    });
  }
  const read = { ends, folds, key, nets };
  if (isWhole) {
    kept.set(db, read);
  }
  return read;
}

/** The nets of the open assignments on a matter (`readOnMatters`). */
export const netsOf = async (desk: Desk, people: People) =>
  (await readOnMatters(desk, people)).nets;

/** The open assignments to close on their matter, each with its outcome (`readOnMatters`). */
export const matterEndsOf = async (desk: Desk, people: People) =>
  (await readOnMatters(desk, people)).ends;

/** Why a text is related to a net: its person, else its meaning (with how close), else not. */
type Why = Exclude<WakeWhy, { why: "wait" }>;

/** `why` as a wake's payload shows it: a similarity to two places (`routeOf` ranks the full one). */
const shownOf = (why: Why) =>
  why.why === "meaning"
    ? { ...why, similarity: Math.round(why.similarity * 100) / 100 }
    : why;

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
    nets.flatMap((net): (Why & { assignment: string })[] => {
      if (t.person && net.people.has(t.person)) {
        return [{ assignment: net.assignment, why: "person" }];
      }
      const vector = vectorOf.get(t);
      const similarity = vector ? closestOf(net.vectors, vector) : -1;
      return similarity >= CLOSE_AT
        ? [
            {
              assignment: net.assignment,
              similarity,
              why: "meaning",
            },
          ]
        : [];
    })
  );
  return { isWhole, related };
}

/** The new messages each net relates to (`relatedOf`), each from when its assignment was opened on: one wake each, its facts and why (`by`, for `routeOf`). */
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
  const since = new Map(nets.map((n) => [n.assignment, n.since]));
  return messages.flatMap((x, i) =>
    (related[i] ?? []).flatMap(({ assignment, ...why }) =>
      isOnOrAfter(x.m, since.get(assignment) ?? "")
        ? [
            {
              assignment,
              by: why as WakeWhy,
              eventId: x.m.id,
              payload: { ...x.m, ...shownOf(why) },
            },
          ]
        : []
    )
  );
}

/** Per desk, how far each recording was read (its unit's end), in this process: after a restart, read again from each assignment's opening. */
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
      // One wake per assignment and recording's new words: by a person first, else its closest part.
      const best = new Map<string, Why>();
      for (const r of related.flat()) {
        const had = best.get(r.assignment);
        if (
          !had ||
          (had.why === "meaning" &&
            (r.why === "person" || r.similarity > had.similarity))
        ) {
          const { assignment, ...why } = r;
          best.set(assignment, why);
        }
      }
      return [...best].flatMap(([assignment, why]) =>
        at > (nets.find((n) => n.assignment === assignment)?.since ?? "")
          ? [
              {
                assignment,
                by: why as WakeWhy,
                eventId: `${u.id}@${at}`,
                payload: { at, id: u.id, source: u.source, ...shownOf(why) },
              },
            ]
          : []
      );
    })
  );
  return wakes.flat();
}

/** Queues his pendant's new recordings for one assignment of each agent on a matter they relate to (`relatedRecordings`, `routeOf`). */
export async function pollRecordings(desk: Desk, readPeopleNow: ReadPeople) {
  const assignments = openAssignments(desk.db);
  if (assignments.length === 0) {
    return;
  }
  const people = await readPeopleNow();
  const wakes = routeOf(
    await relatedRecordings(desk, await netsOf(desk, people), people),
    holdersOf(desk.db, assignments)
  );
  desk.db.transaction(() => queue(desk.db, MATTER_RELATED, wakes))();
}

/**
 * The fold (his word of 20 Nov 2026): every matter sits with the agent that takes it (`agentForOf`). Each open matter
 * assignment held by another agent moves to it (`moveAssignment`) once its agent has no turn running, with its wait,
 * anchors, times, events, notes file and cards (each card's owner row written first, so it stays on its assignment and
 * his next answer wakes the new agent); the agent it leaves ends when it holds nothing more, "folded into the <name>
 * agent". Its turns stay its own: nothing running is cut.
 */
export async function foldAssignments(desk: Desk, readPeopleNow: ReadPeople) {
  const { db } = desk;
  if (openAssignments(db).length === 0) {
    return;
  }
  const { folds } = await readOnMatters(desk, await readPeopleNow());
  const decisions = decisionsNow();
  for (const { assignment, to } of folds) {
    const s = assignmentOf(db, assignment);
    const target = agentOf(db, to);
    // Moved onto an active agent only: an earlier move this pass may have ended it.
    if (
      !(s && target?.status === "active") ||
      s.closed_at ||
      openTurn(db, s.agent_id)
    ) {
      continue;
    }
    const outcome = `folded into the ${target.name ?? target.id} agent`;
    db.transaction(() => {
      for (const d of decisions) {
        if (d.agent === s.agent_id && assignmentOfCard(db, d) === s.id) {
          db.run(
            "insert or ignore into card (decision_id, assignment_id) values (?, ?)",
            [d.id, s.id]
          );
        }
      }
      moveAssignment(db, s.id, to, outcome);
    })();
    log("desk.fold", { assignment, from: s.agent_id, to });
  }
}

/** Closes each open assignment whose matter is over for it (`matterEndsOf`, `endOutcomeOf`), with why. */
export async function endAgentsOnOverMatters(
  desk: Desk,
  readPeopleNow: ReadPeople
) {
  if (openAssignments(desk.db).length === 0) {
    return;
  }
  const ends = await matterEndsOf(desk, await readPeopleNow());
  for (const e of ends) {
    // biome-ignore lint/performance/noAwaitInLoops: one card withdrawn at a time
    await closeAssignment(desk, e.assignment, e.outcome);
  }
}
