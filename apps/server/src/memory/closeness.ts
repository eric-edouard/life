import { z } from "zod";
import { DAY, daysBefore } from "../core/clock";
import { appendJsonl, rowsOf } from "../core/files";
import { stamp } from "../models/llm";
import type { MadeBy } from "../records/fields";
import { Closeness, ClosenessLevel } from "../records/observation";
import { chatGroups, type SourceEvent } from "../records/source";
import { type Store, speakerTurns, withStore } from "../sources/lifelog";
import { CLOSENESS, latestBy, writtenPeople } from "./memory-files";
import { meContext } from "./model-context";
import { OWNER, type Truth } from "./read-truth";
import { begin, checkedEntries, chunks, inBatches } from "./run";
import { kindOf, safely, tables } from "./sources";
import { chatPerson, isLifeOutput } from "./units";
import { meant, type People, readPeople } from "./who";
import { dayNow, localDate } from "./zones";

/** Who a ref is now and his corrections, read once by the caller (`readPeople`). */
type Folds = Pick<People, "canon" | "corrections">;

// Who matters to the owner, and how (docs/architecture.md, "Relationships and closeness"). Code counts what happened
// with each person from the raw sources only: the days a 1:1 chat went both ways, the days they spoke in his
// recordings, how recent. The fast model reads those counts with who they are on his directory and judges a level,
// personal and work apart (memory/closeness.jsonl); his `closeness` correction wins. The levels decide who has a
// page. No model output is counted (a level never feeds the counts that judge it), so a level cannot raise itself.

const CLOSENESS_PROMPT = "closeness.v1";
const PER_CALL = 40;
/** How far back the counts read: a day older than this weighs under an eighth of a recent one in `lasting`. */
const YEARS = 3;

/**
 * One day with someone: messages each way in a 1:1 chat and in mail (mostly work), and whether they spoke in a
 * recording or a completed 1:1 call.
 */
interface Day {
  chat: { got: number; sent: number };
  mail: { got: number; sent: number };
  voice: boolean;
}
/** Per person ref, per local day. */
export type Days = Map<string, Map<string, Day>>;

const dayOf = (days: Days, who: string, day: string) => {
  const of = days.get(who) ?? new Map<string, Day>();
  days.set(who, of);
  const d = of.get(day) ?? {
    chat: { got: 0, sent: 0 },
    mail: { got: 0, sent: 0 },
    voice: false,
  };
  of.set(day, d);
  return d;
};

/**
 * The messages of each person's 1:1 chats and mail threads, by person ref: a chat where one other sender wrote, and not
 * a group by its id (its source's `group`: a WhatsApp `@g.us`, an iMessage `chat…`) nor a mailing list; its person who
 * the sender or the chat's name resolves to.
 */
export function directChats(
  events: SourceEvent[],
  resolve: (s: string) => string | null
) {
  const byPerson = new Map<string, SourceEvent[]>();
  const one = events.filter((e) => !e.bulk);
  for (const list of chatGroups(one).values()) {
    const who = chatPerson(list, resolve);
    if (who && who !== OWNER) {
      const theirs = byPerson.get(who) ?? [];
      byPerson.set(who, theirs);
      // One by one: a spread of a chat of 100k messages would overflow the call's arguments.
      for (const e of list) {
        theirs.push(e);
      }
    }
  }
  return byPerson;
}

/**
 * The one-to-one messages of each person named (a name or an id, read as `read_person_page` reads it: `meant`), in
 * the order given; `known` is undefined, and the messages none, for a name that is no one's.
 */
export function directOf(
  names: string[],
  events: SourceEvent[],
  people: People
) {
  const direct = directChats(events, people.resolve);
  return names.map((name) => {
    const { known } = meant(name, people);
    return { known, messages: direct.get(`person:${known}`) ?? [] };
  });
}

/** The 1:1 chats' and mail threads' days by person (`directChats`): a group is not a measure of closeness. */
export function chatDays(
  events: SourceEvent[],
  resolve: (s: string) => string | null,
  days: Days = new Map()
) {
  for (const [who, list] of directChats(events, resolve)) {
    for (const e of list) {
      if (e.phoneCall && !((e.phoneCall.seconds ?? 0) > 0)) {
        continue;
      }
      const day = dayOf(days, who, localDate(e.at));
      if (e.phoneCall) {
        day.voice = true;
        continue;
      }
      const d = day[kindOf(e.source) === "mail" ? "mail" : "chat"];
      if (e.fromMe) {
        d.sent += 1;
      } else {
        d.got += 1;
      }
    }
  }
  return days;
}

/** The days each person spoke in his recordings since `since` (`speakerTurns`: live conversations, lifelog's own speakers). */
export function voiceDays(
  store: Store,
  resolve: (s: string) => string | null,
  since: Date,
  days: Days = new Map()
) {
  for (const t of speakerTurns(store, since)) {
    const who = resolve(t.id) ?? (t.name ? resolve(t.name) : null);
    if (who && who !== OWNER) {
      dayOf(days, who, localDate(t.at)).voice = true;
    }
  }
  return days;
}

/** What code counts about someone: their days, and two scores that weigh each day by what happened and how long ago. */
export interface Tally {
  /** The first and last day anything happened with them; null when nothing did. */
  first: string | null;
  last: string | null;
  /** Halves every 365 days: who has been close over the years. */
  lasting: number;
  mail: number;
  /** Halves every 30 days: who is close now. */
  recent: number;
  /** Days a 1:1 chat went both ways; a mail thread (mostly work); his recordings. */
  twoWay: number;
  voice: number;
}

/** Messages both ways 1, one way 0.3. */
const exchanged = (c: Day["chat"]) =>
  c.sent && c.got ? 1 : 0.3 * Number(c.sent + c.got > 0);
/** A day's weight: a recording together 2, then the more of its chat and its mail. */
const weight = (d: Day) =>
  (d.voice ? 2 : 0) + Math.max(exchanged(d.chat), exchanged(d.mail));

export function closenessTally(of: Map<string, Day>, today: string): Tally {
  const sorted = [...of.keys()].sort();
  const t = {
    first: sorted[0] ?? null,
    last: sorted.at(-1) ?? null,
    lasting: 0,
    mail: 0,
    recent: 0,
    twoWay: 0,
    voice: 0,
  };
  const now = Date.parse(today);
  for (const [day, d] of of) {
    const age = (now - Date.parse(day)) / DAY;
    t.lasting += weight(d) * 0.5 ** (age / 365);
    t.recent += weight(d) * 0.5 ** (age / 30);
    t.twoWay += d.chat.sent && d.chat.got ? 1 : 0;
    t.mail += d.mail.sent && d.mail.got ? 1 : 0;
    t.voice += d.voice ? 1 : 0;
  }
  return { ...t, lasting: round(t.lasting), recent: round(t.recent) };
}

const round = (n: number) => Math.round(n * 10) / 10;

/** The counts a judgment stands on, rounded (powers of two), so it is asked again only when they really move. */
export const bucket = (t: Tally) =>
  `${Math.round(Math.log2(1 + t.recent))}/${Math.round(Math.log2(1 + t.lasting))}`;

/** Who is worth judging: everyone waiting (`waitingOf`), and anyone with this much `lasting`. */
const JUDGED_FROM = 1;

/**
 * Whom to ask about: everyone worth judging (waiting, or this much `lasting`) never judged, judged on other counts
 * (rounded: they really moved) or under another prompt.
 */
export function dueFor(
  tallies: { ref: string; t: Tally }[],
  judged: Map<string, Closeness>,
  waiting: Set<string>
) {
  return tallies.filter(
    ({ ref, t }) =>
      ref !== OWNER &&
      (waiting.has(ref) || t.lasting >= JUDGED_FROM) &&
      (judged.get(ref)?.counts !== bucket(t) ||
        judged.get(ref)?.madeBy.prompt !== CLOSENESS_PROMPT)
  );
}

const Entry = z.object({
  person: z.string(),
  personal: ClosenessLevel,
  service: z.boolean().default(false),
  why: z.string().min(1).max(300),
  work: ClosenessLevel,
});

/** The model's reply checked: one line per person asked about, once; anything else counted, never trusted. */
export function parseLevels(
  reply: unknown,
  asked: Map<string, string>,
  ctx: { at: string; madeBy: MadeBy }
) {
  const list = z.object({ people: z.array(z.unknown()) }).parse(reply).people;
  const { entries, invalid } = checkedEntries(
    list,
    Entry,
    (e) => e.person,
    (person) => asked.has(person)
  );
  const rows = entries.map((e) =>
    Closeness.parse({
      ...e,
      at: ctx.at,
      counts: asked.get(e.person),
      madeBy: ctx.madeBy,
      schemaVersion: 1,
    })
  );
  return { invalid, rows };
}

export const readCloseness = () =>
  latestBy(rowsOf(CLOSENESS, Closeness), (c) => c.person);

/** Each person's levels now: the model's latest judgment, then his own word (`closeness` corrections) over it. */
export function levelsNow(
  rows: Map<string, Closeness>,
  { canon, corrections }: Folds
) {
  const out = new Map<
    string,
    {
      personal: ClosenessLevel;
      service: boolean;
      why: string;
      work: ClosenessLevel;
    }
  >();
  // A person folded into another (`same-person`) is that one: only the kept person's own judgment counts (their counts
  // took the folded one's in).
  for (const c of rows.values()) {
    if (canon(c.person) === c.person) {
      out.set(c.person, {
        personal: c.personal,
        service: c.service,
        why: c.why,
        work: c.work,
      });
    }
  }
  for (const c of corrections) {
    if (c.kind === "closeness") {
      const ref = canon(c.person);
      const was = out.get(ref) ?? {
        personal: "acquaintance" as const,
        service: false,
        why: "",
        work: "acquaintance" as const,
      };
      out.set(ref, {
        personal: c.personal ?? was.personal,
        service: false,
        why: "your word",
        work: c.work ?? was.work,
      });
    }
  }
  return out;
}

/** The levels that keep a page: the close, and the once close (their page stays as their history). */
const PAGED = new Set<ClosenessLevel>(["inner", "regular", "faded"]);
/** The levels of someone close now. */
const NOW = new Set<ClosenessLevel>(["inner", "regular"]);

/**
 * The people every memory call's context shows (`refContext`): the owner and those close to him now, personally or at work, not a
 * service. Everyone else on the directory comes in a call's input when it involves them (`involvedOf`).
 */
export const contextPeopleBy = (levels: ReturnType<typeof levelsNow>) =>
  new Set([
    OWNER,
    ...[...levels].flatMap(([ref, l]) =>
      !l.service && (NOW.has(l.personal) || NOW.has(l.work)) ? [ref] : []
    ),
  ]);

/**
 * The people who have a page: the owner, everyone whose personal or work level keeps one (not a service), and a person
 * `waiting` for a judgment (`waitingOf`).
 */
export function pagedBy(
  levels: ReturnType<typeof levelsNow>,
  waiting: Iterable<string>
) {
  const paged = new Set([OWNER]);
  for (const [ref, l] of levels) {
    if (!l.service && (PAGED.has(l.personal) || PAGED.has(l.work))) {
      paged.add(ref);
    }
  }
  for (const ref of waiting) {
    if (!levels.has(ref)) {
      paged.add(ref);
    }
  }
  return paged;
}

/**
 * The people close to him personally, now or once (`faded`), not a service: their page has Between us, and the models
 * weigh what is between them. Once close counts, so a backfill reads an ex's days as close ones and a night's dip
 * never empties the section; its lines age out after a year.
 */
export const personallyClose = (levels: ReturnType<typeof levelsNow>) =>
  new Set(
    [...levels].flatMap(([ref, l]) =>
      !l.service && PAGED.has(l.personal) ? [ref] : []
    )
  );

/** Who has a page now (`pagedBy` over the ledger and his corrections). */
export async function pagedNow(people: Folds & Pick<People, "truth">) {
  return pagedBy(
    levelsWith(people),
    await waitingOf(people.truth, people.canon)
  );
}

/** Each person's levels now, from the ledger, his corrections and the folds, as read by the caller (`readPeople`). */
export const levelsWith = (people: Folds) => levelsNow(readCloseness(), people);

/**
 * Who keeps a page until judged, and is judged at the next night even with nothing counted: everyone on his directory (he
 * said who they are) and everyone whose page is written, so a missing or empty closeness ledger never deletes a page.
 * Each as the person they are now (one folded into another is that one).
 */
export async function waitingOf(
  truth: Pick<Truth, "people">,
  canon: People["canon"]
) {
  return new Set([
    ...truth.people.map((p) => canon(`person:${p.id}`)),
    ...(await writtenPeople()).map(canon),
  ]);
}

/** Where the last YEARS years start: what closeness and the personas read. */
const yearsAgo = () =>
  new Date(`${daysBefore(dayNow(), YEARS * 365)}T00:00:00Z`);

/**
 * His chats and mail with people since `since` (`WITH_PEOPLE`), bulk mail and Life's own output left out; `failed`,
 * the sources that could not be read. The night reads every year once (`new Date(0)`): the exchange counts take all
 * of it, closeness and the personas its last YEARS years (`lastYearsOf`).
 */
export async function readWithPeople(since = yearsAgo()) {
  const failed: string[] = [];
  const events = (
    await Promise.all(
      Object.entries(tables().WITH_PEOPLE).map(([name, read]) =>
        safely(name, () => read(since), failed)
      )
    )
  )
    .flat()
    .filter((e) => !(e.bulk || isLifeOutput(e)));
  return { events, failed, since };
}
export type WithPeople = Awaited<ReturnType<typeof readWithPeople>>;

/** The last YEARS years of a longer read, as a read from there would give them. */
export function lastYearsOf(all: WithPeople): WithPeople {
  const since = yearsAgo();
  const from = since.toISOString();
  return {
    events: all.events.filter((e) => e.at >= from),
    failed: all.failed,
    since,
  };
}

/**
 * The nightly step: counts every person's days over the last YEARS years from the chats and his recordings, then asks
 * the fast model about those whose counts moved since their last judgment (or never judged, or under an older prompt).
 */
export async function closeness({ events, failed, since }: WithPeople) {
  const step = await begin("closeness", "fast", { prompt: CLOSENESS_PROMPT });
  const people = await readPeople();
  const { outsideDirectory, names, resolve, truth } = people;
  const today = localDate(step.now.toISOString());
  // A source that could not be read would make everyone in it look distant: no one is judged this night, the levels
  // stand as they were (the night goes on; `unread` and the log say which source).
  const days = chatDays(events, resolve);
  await withStore((store) => voiceDays(store, resolve, since, days));
  const relation = new Map<string, string>([
    ...outsideDirectory.map((p) => [`person:${p.id}`, p.relation] as const),
    ...truth.people.map((p) => [`person:${p.id}`, p.relation ?? ""] as const),
  ]);
  const waiting = await waitingOf(truth, people.canon);
  const judged = readCloseness();
  // Everyone waiting is judged, even with nothing counted (a relation alone can say close family).
  for (const ref of waiting) {
    if (!days.has(ref)) {
      days.set(ref, new Map());
    }
  }
  const tallies = [...days].map(([ref, of]) => ({
    ref,
    t: closenessTally(of, today),
  }));
  const due = dueFor(tallies, judged, waiting);
  const ctx = {
    at: step.now.toISOString(),
    madeBy: stamp(step.llm, CLOSENESS_PROMPT, step.run),
  };
  let written = 0;
  let invalid = 0;
  if (failed.length === 0) {
    await inBatches(chunks(due, PER_CALL), step, (batch, dir) =>
      step.attempt(async () => {
        const json = await step.ask({
          context: meContext(truth),
          dir,
          input: {
            people: batch.map(({ ref, t }) => ({
              name: names.get(ref) ?? ref,
              person: ref,
              relation: relation.get(ref) ?? "",
              ...t,
            })),
            today,
          },
          prompt: CLOSENESS_PROMPT,
        });
        const checked = parseLevels(
          json,
          new Map(batch.map(({ ref, t }) => [ref, bucket(t)])),
          ctx
        );
        // Written as each call ends: a stopped run resumes from them.
        await appendJsonl(CLOSENESS, Closeness, checked.rows);
        written += checked.rows.length;
        invalid += checked.invalid;
      })
    );
  }
  return step.end({
    due: due.length,
    invalid,
    judged: written,
    people: tallies.length,
    unread: failed,
  });
}

/** How close someone is to him, personal and work, and why (`closeness.jsonl`, his word over it); none when not judged. */
export function closenessLine(ref: string, people: People) {
  const l = levelsWith(people).get(ref);
  return l
    ? [
        `Closeness: personal ${l.personal}, work ${l.work}${l.service ? " (a service, not a person)" : ""}: ${l.why}`,
        "",
      ]
    : [];
}
