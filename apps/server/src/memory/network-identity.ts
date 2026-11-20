import type { SourceName } from "../core/names";
import { redact } from "../core/redact";
import type { Unit } from "../records/unit";
import { readUnitsFor } from "./memory-files";
import type { Party } from "./party";
import { chatUnitsFor, readPersonUnits } from "./person-units";
import { OWNER } from "./read-truth";
import { isDirect, SOURCES, sourceOf } from "./sources";
import { type Message, oneLineOf, UNKNOWN } from "./units";
import type { People } from "./who";
import { unitLines } from "./words";

// The network identity (docs/glossary.md): who a person check is about as their messaging network shows them, read from
// their newest one-to-one chat Life holds. A person check asks "Is this <whole name>?" under it, and its context says in
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
  /** Who Life holds the account to be (`partyOf`): a person check's person, or whoever a draft's chat handle resolves to; absent when no one. */
  party?: Party;
  /** The name the network shows for the chat (its contact or chat name); null when it shows none. */
  shownName: string | null;
}

/** A check's `networkIdentity`: who a person check is about as their network shows them (`withNetworkIdentities`); null when none was found, and for other kinds. */
export interface NetworkIdentified {
  networkIdentity?: NetworkIdentity | null;
}

/** The parts of a check this reads: a person check (`kind` `person`) has a network identity, and so does a decision whose draft names a chat. */
interface PersonCheck {
  about: string[];
  confirm: PersonCheck[];
  kind: string;
  ref: string;
}

/** A draft as Life stamped it: its resolved chat, the source it sends through and the chat's name (`to`). */
interface DraftChat {
  channel?: string;
  chat?: string;
  to: string;
}

/** How many of one person's newest chat units the index lists: enough to hold a few 1:1 chat-days among groups' days. */
const READ = 30;
/** A newest message's text, cut to one line. */
const LINE_CHARS = 120;

/**
 * A network identity from someone's 1:1 chat-day and its messages (`builtFor`: only that chat's). `ownerName` names
 * his own newest message. Pure.
 */
export function networkIdentityOf(
  unit: Pick<Unit, "key" | "source" | "title">,
  messages: readonly Pick<Message, "at" | "fromMe" | "sender" | "text">[],
  ownerName: string
): NetworkIdentity {
  const source = sourceOf(unit.source);
  const handle =
    source.handleOf?.(unit.key) ??
    messages.findLast((m) => !m.fromMe)?.sender ??
    null;
  // A chat-day's title is its chat's name, else its key: a key is no name.
  const shownName = unit.title === unit.key ? null : unit.title;
  const last = messages.at(-1);
  return {
    chat: unit.key,
    handle,
    network: source.label,
    newest: last
      ? {
          at: last.at,
          by: last.fromMe ? ownerName : (shownName ?? handle ?? unit.key),
          text: oneLineOf(redact(last.text), LINE_CHARS),
        }
      : null,
    openUrl: (handle && source.chatLinkOf?.(handle)) || null,
    shownName,
  };
}

/** What the index files a check's person as: their ref now, and each of their handles while no one is known by it. */
const refsOf = (c: PersonCheck, refOf: People["refOf"]) =>
  new Set([refOf(c.ref), ...c.about.map((h) => `${UNKNOWN}${h}`)]);

/**
 * Each person check's network identity, by its ref (a decision's `confirm` guesses too). Reads one bounded query of
 * the index for each check's chat-days, the unit files of at most three of them each (`chatUnitsFor`), and the chosen chat-day
 * again from its source (`unitLines`) once: never a whole source. A check with no 1:1 chat Life holds has none.
 */
export async function readNetworkIdentities(
  checks: readonly PersonCheck[],
  people: People
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
  const wanted = asked.map((c) => ({
    check: c,
    refs: refsOf(c, people.refOf),
  }));
  const tried = wanted.map((w) => ({
    ...w,
    ids: chatUnitsFor(
      readPersonUnits([...w.refs], { count: READ, kinds: ["chat"] }),
      w.refs
    ).map((u) => u.id),
  }));
  const units = new Map(
    readUnitsFor([...new Set(tried.flatMap((t) => t.ids))]).map((u) => [
      u.id,
      u,
    ])
  );
  const owner = people.nameOf(OWNER);
  const found = await Promise.all(
    tried.map(async (t) => {
      const unit = t.ids
        .map((id) => units.get(id))
        .find((u) => u && isDirect(u.source, u.key, 1));
      const read = unit && (await unitLines(unit, people));
      return read
        ? ([
            t.check.ref,
            {
              ...networkIdentityOf(read.built.unit, read.built.messages, owner),
              party: people.partyOf(t.check.ref),
            },
          ] as const)
        : null;
    })
  );
  return new Map(found.flatMap((f) => (f ? [f] : [])));
}

/** Who the identities name, as `withNetworkIdentity` reads them. */
type IdentityPeople = Pick<People, "nameOf" | "partyOf" | "resolve">;

/** A check with its network identity, and each guess it confirms with theirs; null where none was found. A draft's card also gets its head. */
export function withNetworkIdentity<
  C extends {
    confirm: C[];
    draft?: DraftChat | null;
    head?: ReturnType<typeof draftHeadOf>;
    networkIdentity?: NetworkIdentity | null;
    ref: string;
  },
>(
  c: C,
  identities: ReadonlyMap<string, NetworkIdentity>,
  people: IdentityPeople
): C {
  return {
    ...c,
    confirm: c.confirm.map((x) => withNetworkIdentity(x, identities, people)),
    ...(c.draft ? { head: draftHeadOf(c.draft) } : {}),
    networkIdentity: identities.get(c.ref) ?? draftChatOf(c.draft, people),
  };
}

/**
 * A draft's chat as its network shows it, from what the draft stored (`networkIdentityOf` over no messages: reads
 * nothing), with the party its handle resolves to; null for mail and a draft with no chat.
 */
function draftChatOf(d: DraftChat | null | undefined, people: IdentityPeople) {
  if (!(d?.chat && d.channel && SOURCES.some((s) => s.name === d.channel))) {
    return null;
  }
  const source = d.channel as SourceName;
  const shown = networkIdentityOf(
    { key: d.chat, source, title: d.to },
    [],
    people.nameOf(OWNER)
  );
  const ref = shown.handle && people.resolve(shown.handle, source);
  return ref ? { ...shown, party: people.partyOf(ref) } : shown;
}

/**
 * A draft card's head, the chat as his card names it, from the stored draft: its network (the source's label) and
 * the chat's name; null for a draft that resolved no source. ponytail: no `members` yet: no source reads a group's
 * member count (a count of who wrote would miss the silent ones); add it with a reader that does.
 */
export function draftHeadOf(d: DraftChat) {
  const source = SOURCES.find((s) => s.name === d.channel);
  return source ? { name: d.to, network: source.label } : null;
}

/** The checks as the inbox shows them: each with its network identity (`readNetworkIdentities`), null where none. */
export async function withNetworkIdentities<
  C extends PersonCheck & {
    confirm: C[];
    draft?: DraftChat | null;
    head?: ReturnType<typeof draftHeadOf>;
    networkIdentity?: NetworkIdentity | null;
  },
>(checks: C[], people: People) {
  const identities = await readNetworkIdentities(checks, people);
  return checks.map((c) => withNetworkIdentity(c, identities, people));
}
