import { DAY } from "../core/clock";
import type { Person } from "../records/truth";
import {
  type Contact,
  contactKeyOf,
  readContactRecords,
} from "../sources/contacts";
import { pagedNow } from "./closeness";
import { handlesOf, phonesAndEmailsOf } from "./read-truth";
import { PERSON } from "./units";
import type { People } from "./who";
import { when } from "./zones";

// A person's details: what his directory and his Contacts already hold about someone as fields (docs/glossary.md, "detail").
// Everything else known about them is a line of their page. This module is the one place that merges the two, and
// decides a person's birthday.

/** The kinds of detail, with their labels on a page. */
const LABELS = {
  birthday: "Birthday",
  family: "Family",
  handles: "Handles",
  home: "Lives in",
  work: "Work",
};

type Detail = keyof typeof LABELS;

/** Contacts' own label for a work address. */
const WORK_ADDRESS = "(Work)";

/** One line of a person's details: what kind, what it says (a birthday: `YYYY-MM-DD` or `--MM-DD`), from where, and whom it names (`detailRefOf`). */
export interface DetailLine {
  from: "contacts" | "truth";
  kind: Detail;
  /** The party a work or family line names, whose page it opens; absent when it names no one Life has. */
  ref?: string;
  text: string;
}

/**
 * Someone's details, in page order (birthday, home, work, family, handles), each kind from his directory first, then his
 * Contacts. One birthday: his directory's, else the first in Contacts. A Contacts address labelled Work is not a home. A line
 * two Contacts cards repeat shows once; each handle is a line of its own, once however it is written.
 */
export function detailsOf({
  contacts,
  person,
}: {
  contacts: Contact[];
  person?: Person;
}): DetailLine[] {
  // A phone or an email once however written (its contact key, kept apart from exact ids), any other handle as written.
  const phoneOrEmailKeyOf = (h: string) => {
    const key = contactKeyOf(h);
    return key ? `\0${key}` : h;
  };
  const mapped = person ? handlesOf(person) : [];
  const phonesAndEmails = new Set(person ? phonesAndEmailsOf(person) : []);
  const seen = new Set(
    mapped.map((h) => (phonesAndEmails.has(h) ? phoneOrEmailKeyOf(h) : h))
  );
  const isNew = (key: string) => !seen.has(key) && Boolean(seen.add(key));
  const line = (
    from: DetailLine["from"],
    kind: Detail,
    texts: (string | null | undefined)[]
  ) => texts.flatMap((text) => (text ? [{ from, kind, text }] : []));
  const lines: DetailLine[] = [
    ...line("truth", "birthday", [person?.birthday]),
    ...line(
      "contacts",
      "birthday",
      contacts.map((c) => c.birthday)
    ),
    ...line(
      "contacts",
      "home",
      contacts
        .flatMap((c) => c.addresses)
        .filter((a) => !a.endsWith(WORK_ADDRESS))
    ),
    ...line(
      "contacts",
      "work",
      contacts.map((c) => c.work)
    ),
    ...line(
      "contacts",
      "family",
      contacts.flatMap((c) => c.related)
    ),
    ...line("truth", "handles", mapped),
    ...line(
      "contacts",
      "handles",
      contacts.flatMap((c) => [
        ...c.handles.filter((h) => isNew(phoneOrEmailKeyOf(h))),
        ...c.profiles.filter(isNew),
      ])
    ),
  ];
  const born = lines.find((l) => l.kind === "birthday");
  return lines.filter(
    (l, i) =>
      (l.kind !== "birthday" || l === born) &&
      lines.findIndex((m) => m.kind === l.kind && m.text === l.text) === i
  );
}

/**
 * Whom a detail names: a work line, the organization of his directory one of its parts names whole (the company is its
 * last); a family line ("Mother: Anne"), the person its name resolves to (`resolve`, never a part of a name); null for
 * every other line, or a name no one goes by.
 */
export function detailRefOf(
  l: DetailLine,
  people: Pick<People, "isOrganization" | "resolve" | "truth">
) {
  if (l.kind === "work") {
    const ours = new Set(
      people.truth.organizations.map((o) => `person:${o.id}`)
    );
    return (
      l.text
        .split(", ")
        .toReversed()
        .map((part) => people.resolve(part))
        .find((r) => r !== null && ours.has(r)) ?? null
    );
  }
  if (l.kind === "family") {
    // Contacts writes "<label>: <name>", or the name alone.
    const r = people.resolve(l.text.split(": ").at(-1) ?? l.text);
    return r && !people.isOrganization(r) ? r : null;
  }
  return null;
}

/** Someone's birthday by their details. */
export const birthdayIn = (lines: DetailLine[]) =>
  lines.find((l) => l.kind === "birthday")?.text ?? null;

/**
 * A birthday (`--MM-DD`, or `YYYY-MM-DD`) seen from `today`: its next date, the days left, and the age then when the
 * year is known.
 */
export function nextBirthday(birthday: string, today: string) {
  const [year = 0, month = 1, dom = 1] = birthday
    .replace("--", "0-")
    .split("-")
    .map(Number);
  const from = Date.parse(`${today}T00:00:00Z`);
  const on = (y: number) => Date.UTC(y, month - 1, dom);
  // ponytail: a 29 Feb birthday falls on 1 Mar in other years (Date.UTC rolls over).
  let at = on(Number(today.slice(0, 4)));
  if (at < from) {
    at = on(Number(today.slice(0, 4)) + 1);
  }
  const next = new Date(at).toISOString().slice(0, 10);
  return {
    age: year ? Number(next.slice(0, 4)) - year : null,
    day: next,
    left: Math.round((at - from) / DAY),
  };
}

/** A `nextBirthday` as "12 Nov (in 3 days, turns 33)". */
export const birthdayText = (b: ReturnType<typeof nextBirthday>) =>
  `${when(b.day).date} (${b.left === 0 ? "today" : `in ${b.left} day${b.left === 1 ? "" : "s"}`}${b.age ? `, turns ${b.age}` : ""})`;

/** How far ahead birthdays are listed (`read_day`, the nightly): a week, so one is seen a week ahead and on the day. */
export const BIRTHDAY_DAYS = 7;

/** The birthdays from `date` to `BIRTHDAY_DAYS` later among `people`, soonest first. */
export const birthdaysNear = (
  people: { birthday: string | null; id: string; name: string }[],
  date: string
) =>
  people
    .flatMap((p) =>
      p.birthday ? [{ b: nextBirthday(p.birthday, date), p }] : []
    )
    .filter(({ b }) => b.left <= BIRTHDAY_DAYS)
    .toSorted((x, y) => x.b.left - y.b.left)
    .map(({ b, p }) => ({ id: p.id, name: p.name, text: birthdayText(b) }));

/** Each person's Contacts cards, read now (whose by `ownerOfCard`, the one rule). */
export function readCardsOf(
  people: Pick<People, "ownerOfCard">,
  records: Contact[] = readContactRecords()
) {
  const contacts = new Map<string, Contact[]>();
  for (const c of records) {
    const ref = people.ownerOfCard(c);
    if (ref) {
      contacts.set(ref, [...(contacts.get(ref) ?? []), c]);
    }
  }
  return (ref: string) => contacts.get(ref) ?? [];
}

/** Every person's details now (`detailsOf`): truth/ and his Contacts (`readCardsOf`). */
export function readDetailsOf(
  people: Pick<People, "ownerOfCard" | "truth">,
  records: Contact[] = readContactRecords()
) {
  const cardsOf = readCardsOf(people, records);
  const mapped = new Map(people.truth.people.map((p) => [`person:${p.id}`, p]));
  return (ref: string) =>
    detailsOf({ contacts: cardsOf(ref), person: mapped.get(ref) });
}

/** The birthdays of the coming week (`birthdaysNear`) of everyone in his directory or with a page. */
export async function readBirthdaysNear(people: People, date: string) {
  const detailsFor = readDetailsOf(people);
  const refs = new Set([
    ...people.truth.people.map((p) => `person:${p.id}`),
    ...(await pagedNow(people)),
  ]);
  return birthdaysNear(
    [...refs].map((ref) => ({
      birthday: birthdayIn(detailsFor(ref)),
      id: ref.replace(PERSON, ""),
      name: people.nameOf(ref),
    })),
    date
  );
}
