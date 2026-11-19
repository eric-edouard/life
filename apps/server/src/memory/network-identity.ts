import type { SourceName } from "../core/names";
import type { SourceEvent } from "../records/source";
import { firstNameOf } from "../records/truth";
import type { Unit } from "../records/unit";
import { readIndex, readUnitsFor } from "./memory-files";
import { OWNER } from "./read-truth";
import { isDirect, kindOf, safely, sourceOf, tables } from "./sources";
import { textOf, UNKNOWN } from "./units";
import type { People } from "./who";

// The network identity (docs/glossary.md): who a person check is about as their messaging network shows them, read from
// their newest one-to-one chat Life holds. A person check asks "Is this <first name>?" under it, and its context says in
// one sentence why Life thinks so (the card's "Why X?"). Read when the inbox is read, never stored.

/** Who someone is on their network: their newest 1:1 chat's network, handle, the name it shows, the chat, its newest message and the network's own link to it. */
export interface NetworkIdentity {
  /** The chat as `read_chats` takes it (its key). */
  chat: string;
  /** Their number or id on that network; null when the chat holds none. */
  handle: string | null;
  /** The network, as he calls it (its source's `label`): WhatsApp, iMessage, LINE… */
  network: string;
  /** The chat's newest message Life holds: who wrote it, when, its text on one line. */
  newest: { at: string; by: string; text: string } | null;
  /** The network's own link that opens the chat (`chatLinkOf`: `https://wa.me/<digits>` for WhatsApp); null when it has none. */
  openUrl: string | null;
  /** The name the network shows for the chat (its contact or chat name); null when it shows none. */
  shownName: string | null;
}

/** A check's `networkIdentity`: who a person check is about as their network shows them (`withNetworkIdentities`); null when none was found, and for other kinds. */
export interface NetworkIdentified {
  networkIdentity?: NetworkIdentity | null;
}

/** The parts of a check this reads: only a person check (`kind` `person`) has a network identity. */
interface PersonCheck {
  about: string[];
  confirm: PersonCheck[];
  kind: string;
  ref: string;
}

/** A unit as the index lists it: what picks the newest 1:1 chat before any unit file is read. */
interface IndexedUnit {
  date: string;
  id: string;
  people: string[];
  source: SourceName;
}

/** The units of a chat-day Life holds, by the index: newest first. */
type ChatUnit = Pick<
  Unit,
  "date" | "end" | "id" | "key" | "source" | "start" | "title"
>;

/** How many of a person's newest chat-days are read to find one that is 1:1 (the index can't tell a group). */
const TRIED = 3;
/** A newest message's text, cut to one line. */
const LINE_CHARS = 120;

/** A name that starts with a capital letter; a description ("the plumber fixing the sink") does not. */
const CAPITAL = /^\p{Lu}/u;
const SPACES = /\s+/g;

/** What a name is called by in a question: its first name, or the whole of it when it is a description, not a name. */
const calledOf = (name: string) =>
  CAPITAL.test(name.trim()) ? firstNameOf(name) : name.trim();

/** The question of a person check: "Is this Kit?", or of a card two people fit, "Is this Gran or Robin?". */
export const personQuestionOf = (names: string[]) =>
  `Is this ${names.map(calledOf).join(" or ")}?`;

/** A guessed person's identity ask: "Is this Kit?", and its context, why Life thinks so in one sentence. */
export const guessAskOf = (p: {
  confidence: number;
  name: string;
  relation: string;
}) => ({
  context: `Life read their messages as ${p.name}, ${p.relation} (${Math.round(p.confidence * 100)}% sure).`,
  question: personQuestionOf([p.name]),
});

/** A Contacts card's identity ask: "Is this Gran or Robin?", and its context: which card. */
export const cardAskOf = (card: string, people: { name: string }[]) => ({
  context: `It is the Contacts card ${card}.`,
  question: personQuestionOf(people.map((p) => p.name)),
});

/** A message's text on one line, cut to `LINE_CHARS`. */
const oneLine = (text: string) => {
  const flat = text.replace(SPACES, " ").trim();
  return flat.length > LINE_CHARS
    ? `${flat.slice(0, LINE_CHARS - 1).trimEnd()}…`
    : flat;
};

/**
 * A network identity from someone's 1:1 chat-day and the messages of its span (any chats: only the unit's own are
 * read). `ownerName` names his own newest message. Pure.
 */
export function networkIdentityOf(
  unit: ChatUnit,
  events: readonly SourceEvent[],
  ownerName: string
): NetworkIdentity {
  const source = sourceOf(unit.source);
  const messages = events
    .filter((e) => e.source === unit.source && e.chat === unit.key)
    .toSorted((a, b) => a.at.localeCompare(b.at));
  const handle =
    source.handleOf?.(unit.key) ??
    messages.findLast((e) => !e.fromMe)?.sender ??
    null;
  // A chat-day's title is its chat's name, else its key: a key is no name.
  const shownName =
    messages.findLast((e) => e.chatName)?.chatName ??
    (unit.title === unit.key ? null : unit.title);
  const last = messages.at(-1);
  return {
    chat: unit.key,
    handle,
    network: source.label,
    newest: last
      ? {
          at: last.at,
          by: last.fromMe ? ownerName : (shownName ?? handle ?? unit.key),
          text: oneLine(textOf(last)),
        }
      : null,
    openUrl: (handle && source.chatLinkOf?.(handle)) || null,
    shownName,
  };
}

/**
 * The chat-days to try for one check, newest first: chat units whose one other person is the check's person (as the
 * index files them: their ref, or `unknown:<handle>` while no one is known by it), or the units its guess rests on.
 */
export function chatUnitsFor(
  units: readonly IndexedUnit[],
  refs: ReadonlySet<string>,
  evidence: ReadonlySet<string>
) {
  return units
    .filter((u) => {
      const others = u.people.filter((p) => p !== OWNER);
      return (
        kindOf(u.source) === "chat" &&
        others.length === 1 &&
        (refs.has(others[0] as string) || evidence.has(u.id))
      );
    })
    .toSorted((a, b) => b.date.localeCompare(a.date))
    .slice(0, TRIED);
}

/** What the index files a check's person as: their ref now, and each of their handles while no one is known by it. */
const refsOf = (c: PersonCheck, refOf: People["refOf"]) =>
  new Set([refOf(c.ref), ...c.about.map((h) => `${UNKNOWN}${h}`)]);

/** The indexed chat units of these people refs or ids: one read of the index. */
const readIndexedUnits = (refs: string[], ids: string[]) =>
  readIndex((db) =>
    db
      .query<
        { date: string; id: string; people: string; source: SourceName },
        [string, string]
      >(
        `select u.id, u.date, u.source, (select json_group_array(q.person) from unit_people q where q.unit = u.id) as people
           from units u
          where u.id in (select unit from unit_people where person in (select value from json_each(?1)))
             or u.id in (select value from json_each(?2))`
      )
      .all(JSON.stringify(refs), JSON.stringify(ids))
      .map((r) => ({ ...r, people: JSON.parse(r.people) as string[] }))
  ) ?? [];

/**
 * Each person check's network identity, by its ref (a decision's `confirm` guesses too). Reads one query of the index
 * for every check's chat-days, the unit files of at most `TRIED` of them each, and each chosen chat-day's span of its
 * source once (a day at most): never a whole source. A check with no 1:1 chat Life holds has none.
 */
export async function readNetworkIdentities(
  checks: readonly PersonCheck[],
  people: Pick<People, "inferred" | "nameOf" | "refOf">
): Promise<Map<string, NetworkIdentity>> {
  const asked = [
    ...new Map(
      checks
        .flatMap((c) => [c, ...c.confirm])
        .filter((c) => c.kind === "person")
        .map((c) => [c.ref, c])
    ).values(),
  ];
  if (asked.length === 0) {
    return new Map();
  }
  const evidenceOf = new Map(
    people.inferred.map((p) => [
      `person:${p.id}`,
      new Set(p.evidence.map((e) => e.unit)),
    ])
  );
  const wanted = asked.map((c) => ({
    check: c,
    evidence: evidenceOf.get(c.ref) ?? new Set<string>(),
    refs: refsOf(c, people.refOf),
  }));
  const indexed = readIndexedUnits(
    [...new Set(wanted.flatMap((w) => [...w.refs]))],
    [...new Set(wanted.flatMap((w) => [...w.evidence]))]
  );
  const tried = wanted.map((w) => ({
    ...w,
    ids: chatUnitsFor(indexed, w.refs, w.evidence).map((u) => u.id),
  }));
  const units = new Map(
    readUnitsFor([...new Set(tried.flatMap((t) => t.ids))]).map((u) => [
      u.id,
      u,
    ])
  );
  const chosen = tried.flatMap((t) => {
    const unit = t.ids
      .map((id) => units.get(id))
      .find((u) => u && isDirect(u.source, u.key, 1));
    return unit ? [{ ref: t.check.ref, unit }] : [];
  });
  const readers = tables().WITH_PEOPLE;
  const failed: string[] = [];
  const spans = Map.groupBy(chosen, (c) => `${c.unit.source}|${c.unit.date}`);
  const events = (
    await Promise.all(
      [...spans.values()].map((group) => {
        const read = readers[group[0]?.unit.source ?? ""];
        const start = group.reduce(
          (m, c) => (c.unit.start < m ? c.unit.start : m),
          group[0]?.unit.start ?? ""
        );
        const end = group.reduce(
          (m, c) => (c.unit.end > m ? c.unit.end : m),
          ""
        );
        return read
          ? safely(
              group[0]?.unit.source ?? "",
              () => read(new Date(start), new Date(Date.parse(end) + 1)),
              failed,
              false
            )
          : [];
      })
    )
  ).flat();
  const owner = people.nameOf(OWNER);
  return new Map(
    chosen.map((c) => [c.ref, networkIdentityOf(c.unit, events, owner)])
  );
}

/** A check with its network identity, and each guess it confirms with theirs; null where none was found. */
export function withNetworkIdentity<
  C extends {
    confirm: C[];
    networkIdentity?: NetworkIdentity | null;
    ref: string;
  },
>(c: C, identities: ReadonlyMap<string, NetworkIdentity>): C {
  return {
    ...c,
    confirm: c.confirm.map((x) => withNetworkIdentity(x, identities)),
    networkIdentity: identities.get(c.ref) ?? null,
  };
}

/** The checks as the inbox shows them: each with its network identity (`readNetworkIdentities`), null where none. */
export async function withNetworkIdentities<
  C extends PersonCheck & {
    confirm: C[];
    networkIdentity?: NetworkIdentity | null;
  },
>(checks: C[], people: Pick<People, "inferred" | "nameOf" | "refOf">) {
  const identities = await readNetworkIdentities(checks, people);
  return checks.map((c) => withNetworkIdentity(c, identities));
}
