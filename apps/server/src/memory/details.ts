import { DAY } from "../core/clock";
import type { Person } from "../records/truth";
import {
  type Contact,
  contactKeyOf,
  readContactRecords,
} from "../sources/contacts";
import { pagedNow } from "./closeness";
import { handlesOf } from "./read-truth";
import { PERSON } from "./units";
import type { People } from "./who";
import { when } from "./zones";

// A person's details: what his map and his Contacts already hold about someone as fields (docs/glossary.md, "detail").
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

/** One line of a person's details: what kind, what it says (a birthday: `YYYY-MM-DD` or `--MM-DD`), and from where. */
export interface DetailLine {
  from: "contacts" | "truth";
  kind: Detail;
  text: string;
}

/**
 * Someone's details, in page order (birthday, home, work, family, handles), each kind from his map first, then his
 * Contacts. One birthday: his map's, else the first in Contacts. A Contacts address labelled Work is not a home. A line
 * two Contacts cards repeat shows once; a handle shows once, however it is written.
 */
export function detailsOf({
  contacts,
  person,
}: {
  contacts: Contact[];
  person?: Person;
}): DetailLine[] {
  const keyOf = (h: string) => contactKeyOf(h) ?? h;
  const mapped = person ? handlesOf(person) : [];
  const seen = new Set(mapped.map(keyOf));
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
    ...line("truth", "handles", [mapped.join(", ")]),
    ...line("contacts", "handles", [
      contacts
        .flatMap((c) => [...c.handles, ...c.profiles])
        .filter((h) => !seen.has(keyOf(h)) && Boolean(seen.add(keyOf(h))))
        .join(", "),
    ]),
  ];
  const born = lines.find((l) => l.kind === "birthday");
  return lines.filter(
    (l, i) =>
      (l.kind !== "birthday" || l === born) &&
      lines.findIndex((m) => m.kind === l.kind && m.text === l.text) === i
  );
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

const SOURCE_NAMES = { contacts: "Contacts", truth: "his map" };

/** Someone's details as their page shows them, one line each, with where each comes from; `today` dates a birthday. */
export function detailsBlock(lines: DetailLine[], today: string) {
  if (lines.length === 0) {
    return [];
  }
  return [
    "Details:",
    ...lines.map((l) => {
      const text =
        l.kind === "birthday"
          ? birthdayText(nextBirthday(l.text, today))
          : l.text;
      return `- ${LABELS[l.kind]}: ${text} (${SOURCE_NAMES[l.from]})`;
    }),
    "",
  ];
}

/** Every person's details now (`detailsOf`): truth/ and his Contacts (whose by `resolve`). */
export function readDetailsOf(
  people: Pick<People, "resolve" | "truth">,
  records: Contact[] = readContactRecords()
) {
  const contacts = new Map<string, Contact[]>();
  for (const c of records) {
    const ref = c.handles.map(people.resolve).find(Boolean);
    if (ref) {
      contacts.set(ref, [...(contacts.get(ref) ?? []), c]);
    }
  }
  const mapped = new Map(people.truth.people.map((p) => [`person:${p.id}`, p]));
  return (ref: string) =>
    detailsOf({
      contacts: contacts.get(ref) ?? [],
      person: mapped.get(ref),
    });
}

/** The birthdays of the coming week (`birthdaysNear`) of everyone on his map or with a page. */
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
