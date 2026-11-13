import { clock } from "../core/clock";
import { appendJsonl } from "../core/files";
import { log } from "../core/log";
import { ContactPerson, contactIdOf } from "../records/observation";
import {
  type Contact,
  contactKeyOf,
  ownersOf,
  readContactRecords,
} from "../sources/contacts";
import {
  CONTACT_PEOPLE,
  readContactLines,
  readIndex,
  readInferred,
} from "./memory-files";
import { nameKey, UNKNOWN } from "./units";

// The contact people (docs/glossary.md): who a handle is, as his Contacts name it, for the handles his messages hold.
// Contacts answer once and Life keeps the answer (memory/people-contacts.jsonl, appended each night): no read opens
// Contacts, a card he deletes keeps its person, and a ref stored for good never loses its name. Who a contact person
// is among everyone (someone in truth/, an earlier guess) is `who.ts`'s to say.

/** A contact person as it stands: its id (from its card's), its latest name, every surface a line gave it. */
export interface ContactNow {
  card: string;
  handles: string[];
  id: string;
  name: string;
}

/** The contact people as they stand, one per card: its latest line's name, its handles from every line. */
export function contactsNow(lines: ContactPerson[]): ContactNow[] {
  const now = new Map<string, ContactNow>();
  for (const l of lines) {
    now.set(l.card, {
      card: l.card,
      handles: [
        ...new Set([...(now.get(l.card)?.handles ?? []), ...l.handles]),
      ],
      id: contactIdOf(l.card),
      name: l.name,
    });
  }
  return [...now.values()];
}

/**
 * The lines to append for his Contacts as they are now. A card becomes a person when one of its handles is `seen` (a
 * sender Life cannot name, or a surface of someone it guessed), or it is one already; his whole address book is never
 * copied. A handle belongs to the person who has it (a stored one first, else `ownersOf`): a second card under the
 * same name (the same person in another account) joins it, one under another name does not get that handle. A line
 * is appended only when a person is new, renamed, or has a new handle; a card gone from Contacts appends nothing.
 */
export function contactPeopleOf(
  cards: Contact[],
  stored: ContactPerson[],
  seen: ReadonlySet<string>,
  at: string
): ContactPerson[] {
  const before = new Map(contactsNow(stored).map((p) => [p.card, p]));
  // Whose each handle is: a stored person's first, then the card that owns it in Contacts.
  const holder = new Map<string, { card: string; name: string }>();
  const hold = (nameOrHandle: string, card: string, name: string) => {
    const key = contactKeyOf(nameOrHandle);
    if (key && !holder.has(key)) {
      holder.set(key, { card, name });
    }
  };
  for (const p of before.values()) {
    for (const s of p.handles) {
      hold(s, p.card, p.name);
    }
  }
  for (const [key, c] of ownersOf(cards)) {
    hold(key, c.id, c.name);
  }
  const named = cards
    .flatMap((c) => (c.name ? [{ ...c, name: c.name }] : []))
    .toSorted((a, b) => a.id.localeCompare(b.id));
  const now = new Map<string, { name: string; handles: string[] }>();
  for (const c of named) {
    const holderOf = (h: string) => holder.get(contactKeyOf(h) ?? "");
    // A person already kept is its card, whatever the card is called now; a new card is whoever holds one of its
    // handles under its name, else itself.
    const isKept = before.has(c.id);
    const kept = c.handles.filter((h) => {
      const who = holderOf(h);
      return (
        who &&
        (isKept
          ? who.card === c.id
          : nameKey(c.name) !== "" && nameKey(who.name) === nameKey(c.name))
      );
    });
    const card = isKept
      ? c.id
      : (kept
          .map((h) => holderOf(h)?.card)
          .find((id) => id && before.has(id)) ?? holderOf(kept[0] ?? "")?.card);
    if (!card) {
      continue;
    }
    const person = now.get(card) ?? {
      handles: [...(before.get(card)?.handles ?? [])],
      // A card's own name, when it is among the cards; a joined card has the same name.
      name: c.name,
    };
    person.handles = [...new Set([...person.handles, ...kept])];
    if (c.id === card) {
      person.name = c.name;
    }
    now.set(card, person);
  }
  return [...now].flatMap(([card, p]): ContactPerson[] => {
    const was = before.get(card);
    const isSeen = p.handles.some((s) => seen.has(contactKeyOf(s) ?? ""));
    const changed =
      !was || was.name !== p.name || was.handles.length !== p.handles.length;
    return (was || isSeen) && changed
      ? [{ at, card, handles: p.handles, name: p.name, schemaVersion: 1 }]
      : [];
  });
}

/** The handles his messages hold that Life cannot name or only guessed, by their Contacts key: what makes a card a person. */
function seenHandles() {
  const unknown =
    readIndex((db) =>
      db
        .query<{ person: string }, []>(
          `select distinct person from unit_people where person like '${UNKNOWN}%'`
        )
        .all()
        .map((r) => r.person.slice(UNKNOWN.length))
    ) ?? [];
  return new Set(
    [...unknown, ...readInferred().flatMap((p) => p.namesAndHandles)].flatMap(
      (s) => {
        const key = contactKeyOf(s);
        return key ? [key] : [];
      }
    )
  );
}

/**
 * The night's step: reads his Contacts and appends what changed (`contactPeopleOf`). Contacts unread (no Mac, no
 * access) gives no card, so nothing is appended and the people kept still read; a failure is logged and never stops
 * the night.
 */
export function writeContactPeople() {
  try {
    const lines = contactPeopleOf(
      readContactRecords(),
      readContactLines(),
      seenHandles(),
      clock().toISOString()
    );
    appendJsonl(CONTACT_PEOPLE, ContactPerson, lines);
    return { added: lines.length, failed: 0 };
  } catch (e) {
    log("run.error", {
      error: (e as Error).message,
      step: "memory.contact-people",
    });
    return { added: 0, failed: 1 };
  }
}
