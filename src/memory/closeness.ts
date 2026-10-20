import { z } from "zod";
import { stamp } from "../llm";
import {
  Closeness,
  type Correction,
  Level,
  type MadeBy,
  type SourceEvent,
} from "../schema";
import { type Store, speakerTurns, withStore } from "../sources/lifelog";
import { OWNER, type Truth } from "../truth";
import {
  appendJsonl,
  CLOSENESS,
  latestBy,
  readCorrections,
  rowsOf,
} from "./ledger";
import { begin, chunks, inBatches, meContext } from "./run";
import { daysBefore, safely, WITH_PEOPLE } from "./units";
import { merged, readPeople } from "./who";
import { localDate } from "./zones";

// Who matters to the owner, and how (docs/relationships.md, step 3). Code counts what happened with each person from
// the raw sources only: the days a 1:1 chat went both ways, the days they spoke in his recordings, how recent. The
// fast model reads those counts with who they are on his map and judges a level, personal and work apart
// (memory/closeness.jsonl); his `closeness` correction wins. The levels decide who has a page. No model output is
// counted (a level never feeds the counts that judge it), so a level cannot raise itself.

const CLOSENESS_PROMPT = "closeness.v1";
const PER_CALL = 40;
/** How far back the counts read: a day older than this weighs under an eighth of a recent one in `lasting`. */
const YEARS = 3;

/** One day with someone: messages each way in a 1:1 chat and in mail (mostly work), and whether they spoke in a recording. */
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
 * Who one chat's messages are with: the person among its other senders, else (a chat only he wrote in) its id's, else
 * its name's (a mail thread's is its subject: never). A WhatsApp or iMessage chat says by its id whether it is a group
 * (`chatDays` leaves those out), so the rest are 1:1 whatever handles one person wrote from; elsewhere (Beeper, mail)
 * more than one other sender is a group: none.
 */
function chatPerson(
  list: SourceEvent[],
  resolve: (s: string) => string | null
) {
  const others = new Set(
    list.filter((e) => !e.fromMe).map((e) => resolve(e.sender) ?? e.sender)
  );
  const [first] = list;
  const byId = first?.source === "whatsapp" || first?.source === "imessage";
  if (!first || (others.size > 1 && !byId)) {
    return null;
  }
  const named =
    first.chatName && first.source !== "mail" ? resolve(first.chatName) : null;
  const person = [...others].find((o) => o.startsWith("person:"));
  return person ?? (others.size === 0 ? resolve(first.chat) : null) ?? named;
}

/**
 * The 1:1 chats' and mail threads' days by person: one where one other sender wrote, and not a group by its id (a
 * WhatsApp `@g.us`, an iMessage `chat…`) nor a mailing list (a group is not a measure of closeness); its person who the
 * sender or the chat's name resolves to.
 */
export function chatDays(
  events: SourceEvent[],
  resolve: (s: string) => string | null,
  days: Days = new Map()
) {
  const one = events.filter(
    (e) =>
      !(
        e.bulk ||
        e.chat.endsWith("@g.us") ||
        (e.source === "imessage" && e.chat.startsWith("chat"))
      )
  );
  for (const list of Map.groupBy(
    one,
    (e) => `${e.source}|${e.chat}`
  ).values()) {
    const who = chatPerson(list, resolve);
    if (!who || who === OWNER) {
      continue;
    }
    for (const e of list) {
      const d = dayOf(days, who, localDate(e.at))[
        e.source === "mail" ? "mail" : "chat"
      ];
      if (e.fromMe) {
        d.sent += 1;
      } else {
        d.got += 1;
      }
    }
  }
  return days;
}

/** The days each person spoke in his recordings (`speakerTurns`: live conversations, lifelog's own speakers). */
export function voiceDays(
  store: Store,
  resolve: (s: string) => string | null,
  days: Days = new Map()
) {
  for (const t of speakerTurns(store)) {
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

export function tally(of: Map<string, Day>, today: string): Tally {
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
    const age = (now - Date.parse(day)) / 86_400_000;
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

/** Who is worth judging: everyone on his map, and anyone with this much `lasting`. */
const JUDGED_FROM = 1;

/**
 * Whom to ask about: everyone worth judging (on his map, or this much `lasting`) never judged, judged on other counts
 * (rounded: they really moved) or under another prompt.
 */
export function dueFor(
  tallies: { ref: string; t: Tally }[],
  judged: Map<string, Closeness>,
  onMap: Set<string>
) {
  return tallies.filter(
    ({ ref, t }) =>
      ref !== OWNER &&
      (onMap.has(ref) || t.lasting >= JUDGED_FROM) &&
      (judged.get(ref)?.counts !== bucket(t) ||
        judged.get(ref)?.madeBy.prompt !== CLOSENESS_PROMPT)
  );
}

const Entry = z.object({
  person: z.string(),
  personal: Level,
  service: z.boolean().default(false),
  why: z.string().min(1).max(300),
  work: Level,
});

/** The model's reply checked: one line per person asked about, once; anything else counted, never trusted. */
export function parseLevels(
  reply: unknown,
  asked: Map<string, string>,
  ctx: { at: string; madeBy: MadeBy }
) {
  const list = z.object({ people: z.array(z.unknown()) }).parse(reply).people;
  const rows = new Map<string, Closeness>();
  let invalid = 0;
  for (const raw of list) {
    const r = Entry.safeParse(raw);
    const counts = r.success ? asked.get(r.data.person) : undefined;
    if (!(r.success && counts !== undefined) || rows.has(r.data.person)) {
      invalid += 1;
      continue;
    }
    rows.set(
      r.data.person,
      Closeness.parse({
        ...r.data,
        at: ctx.at,
        counts,
        madeBy: ctx.madeBy,
        schemaVersion: 1,
      })
    );
  }
  return { invalid, rows: [...rows.values()] };
}

export const readCloseness = () =>
  latestBy(rowsOf(CLOSENESS, Closeness), (c) => c.person);

/** Each person's levels now: the model's latest judgment, then his own word (`closeness` corrections) over it. */
export function levelsNow(
  rows: Map<string, Closeness>,
  corrections: Correction[]
) {
  const out = new Map<
    string,
    { personal: Level; service: boolean; why: string; work: Level }
  >();
  // A person folded into another (`same-person`) is that one: only the kept person's own judgment counts (their counts
  // took the folded one's in).
  const canon = merged(corrections);
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
const CLOSE = new Set<Level>(["inner", "regular"]);
const PAGED = new Set<Level>([...CLOSE, "faded"]);

/**
 * The people who have a page: the owner, everyone whose personal or work level keeps one (not a service), and a person
 * on his map not judged yet (he said who they are; the next night judges them).
 */
export function pagedBy(
  levels: ReturnType<typeof levelsNow>,
  onMap: Iterable<string>
) {
  const paged = new Set([OWNER]);
  for (const [ref, l] of levels) {
    if (!l.service && (PAGED.has(l.personal) || PAGED.has(l.work))) {
      paged.add(ref);
    }
  }
  for (const ref of onMap) {
    if (!levels.has(ref)) {
      paged.add(ref);
    }
  }
  return paged;
}

/** Who has a page now (`pagedBy` over the ledger and his corrections). */
export async function pagedNow(truth: Pick<Truth, "people">) {
  const corrections = await readCorrections();
  return pagedBy(levelsWith(corrections), onMapOf(truth, corrections));
}

/** Each person's levels now, from the ledger and `corrections` (his, as read by the caller). */
export const levelsWith = (corrections: Correction[]) =>
  levelsNow(readCloseness(), corrections);

/** Everyone on his map, as the person each is now (one folded into another is that one). */
const onMapOf = (truth: Pick<Truth, "people">, corrections: Correction[]) => {
  const canon = merged(corrections);
  return new Set(truth.people.map((p) => canon(`person:${p.id}`)));
};

/**
 * The nightly step: counts every person's days over the last YEARS years from the chats and his recordings, then asks
 * the fast model about those whose counts moved since their last judgment (or never judged, or under an older prompt).
 */
export async function closeness() {
  const step = await begin("closeness", "fast", { prompt: CLOSENESS_PROMPT });
  const people = await readPeople();
  const { inferred, names, resolve, truth } = people;
  const today = localDate(step.now.toISOString());
  const since = new Date(`${daysBefore(today, YEARS * 365)}T00:00:00Z`);
  const failed: string[] = [];
  const events = (
    await Promise.all(
      Object.entries(WITH_PEOPLE).map(([name, read]) =>
        safely(name, () => read(since), failed)
      )
    )
  ).flat();
  // A source that could not be read would make everyone in it look distant: no one is judged this night, the levels
  // stand as they were (the night goes on; `unread` and the log say which source).
  const days = chatDays(events, resolve);
  await withStore((store) => voiceDays(store, resolve, days));
  const relation = new Map<string, string>([
    ...inferred.map((p) => [`person:${p.id}`, p.relation] as const),
    ...truth.people.map((p) => [`person:${p.id}`, p.relation ?? ""] as const),
  ]);
  const onMap = onMapOf(truth, people.corrections);
  const judged = readCloseness();
  // Everyone on his map is judged, even with nothing counted (a relation alone can say close family).
  for (const ref of onMap) {
    if (!days.has(ref)) {
      days.set(ref, new Map());
    }
  }
  const tallies = [...days].map(([ref, of]) => ({ ref, t: tally(of, today) }));
  const due = dueFor(tallies, judged, onMap);
  const ctx = {
    at: step.now.toISOString(),
    madeBy: stamp(step.llm, CLOSENESS_PROMPT, step.run),
  };
  let written = 0;
  let invalid = 0;
  if (failed.length === 0) {
    await inBatches(chunks(due, PER_CALL), step.dir, (batch, dir) =>
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
