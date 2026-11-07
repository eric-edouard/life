import { DAY } from "../core/clock";
import { readAppended } from "../core/files";
import {
  DETAILS,
  type Detail,
  DetailTag,
  type Observation,
} from "../records/observation";
import type { Person } from "../records/truth";
import { type Contact, contactKeyOf } from "../sources/contacts";
import { DETAIL_TAGS } from "./ledger";
import { handlesOf } from "./read-truth";
import { when } from "./zones";

// A person's details: the practical facts about someone as named fields (docs/glossary.md, "detail"). A detail is never
// a place a fact lives: it is a facet of what Life already holds, in this order of trust: truth/ (his word), his
// Contacts, then the observations the details step tagged (each still cited, and retired only as any fact is). This
// module is the one place that decides that order, and a person's birthday.

/** The latest tag per observation (`detail-tags.jsonl`). */
export const readDetailTags = () =>
  readAppended(
    DETAIL_TAGS,
    DetailTag,
    (last?: Map<string, DetailTag>) => new Map(last),
    (tags, t) => {
      tags.set(t.observation, t);
    }
  );

/** The detail an observation states, as the index files it: its latest tag; none for a conditional claim. */
export const detailOf = (
  o: Pick<Observation, "id" | "modality">,
  tags: ReadonlyMap<string, DetailTag>
) => (o.modality === "conditional" ? null : (tags.get(o.id)?.detail ?? null));

/** The kinds someone has one of at a time. */
const ONE_EACH = new Set<DetailLine["kind"]>(["birthday", "home", "work"]);
/** Contacts' own label for a work address. */
const WORK_ADDRESS = "(Work)";

/** A tagged fact on someone's page, as the index holds it. */
export interface DetailFact {
  date: string;
  detail: Detail;
  id: string;
  text: string;
  when: string | null;
}

/** One line of a person's details: what kind, what it says, and where it comes from. */
export interface DetailLine {
  /** For a birthday: `YYYY-MM-DD`, or `--MM-DD` when the year is unknown; absent when a fact gives no date. */
  born?: string;
  /** `truth`, `contacts`, or the observation's id. */
  from: string;
  kind: Detail | "handles";
  text: string;
}

/**
 * Someone's details, in page order (`DETAILS`, then handles), each kind from truth/, then his Contacts, then the facts
 * (newest first). Someone has one birthday, home and work (`ONE_EACH`): the birthday is the first line by that order
 * that gives a date, a home or work the newest current fact (it outdates any address book), else the first line;
 * every other kind lists all it has. A Contacts address labelled Work is not a home. A handle shows once, however it is
 * written.
 */
export function detailsOf({
  contacts,
  facts,
  person,
}: {
  contacts: Contact[];
  facts: DetailFact[];
  person?: Person;
}): DetailLine[] {
  const truth = (
    kind: Detail | "handles",
    text: string | undefined,
    born?: string
  ) => (text ? [{ born, from: "truth", kind, text }] : []);
  const keyOf = (h: string) => contactKeyOf(h) ?? h;
  const mapped = person ? handlesOf(person) : [];
  const seen = new Set(mapped.map(keyOf));
  const listed = (kind: Detail | "handles", texts: (string | null)[]) =>
    texts.flatMap((text) => (text ? [{ from: "contacts", kind, text }] : []));
  const lines: DetailLine[] = [
    ...truth("birthday", person?.birthday, person?.birthday),
    ...contacts.flatMap((c) =>
      c.birthday
        ? [
            {
              born: c.birthday,
              from: "contacts",
              kind: "birthday" as const,
              text: c.birthday,
            },
          ]
        : []
    ),
    ...listed(
      "home",
      contacts
        .flatMap((c) => c.addresses)
        .filter((a) => !a.endsWith(WORK_ADDRESS))
    ),
    ...listed(
      "work",
      contacts.map((c) => c.work)
    ),
    ...listed(
      "family",
      contacts.flatMap((c) => c.related)
    ),
    ...facts
      .toSorted((a, b) => b.date.localeCompare(a.date))
      .map((f) => ({
        born:
          f.detail === "birthday" && f.when
            ? `--${f.when.slice(5)}`
            : undefined,
        from: f.id,
        kind: f.detail,
        text: f.text,
      })),
    ...truth("handles", mapped.join(", ")),
    ...listed("handles", [
      contacts
        .flatMap((c) => [...c.handles, ...c.profiles])
        .filter((h) => !seen.has(keyOf(h)) && Boolean(seen.add(keyOf(h))))
        .join(", "),
    ]),
  ];
  const order = [...DETAILS.map(([kind]) => kind), "handles"];
  const best = (l: DetailLine) =>
    l.kind === "birthday" ? !!l.born : isFact(l);
  const chosen = (kind: DetailLine["kind"]) =>
    lines.find((l) => l.kind === kind && best(l)) ??
    lines.find((l) => l.kind === kind);
  return lines
    .filter((l) => !ONE_EACH.has(l.kind) || l === chosen(l.kind))
    .toSorted((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
}

/** Someone's birthday by their details: the first line that gives a date. */
export const birthdayIn = (lines: DetailLine[]) =>
  lines.find((l) => l.born)?.born ?? null;

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

/** Where a line that is not a fact comes from, as the page names it. */
const SOURCE_NAMES: Record<string, string> = {
  contacts: "Contacts",
  truth: "his map",
};
const isFact = (l: DetailLine) => !(l.from in SOURCE_NAMES);

const LABELS = new Map<string, string>([...DETAILS, ["handles", "Handles"]]);

/** Someone's details as their page shows them, one line each, with where each comes from; `today` dates a birthday. */
export function detailsBlock(lines: DetailLine[], today: string) {
  if (lines.length === 0) {
    return [];
  }
  return [
    "Details:",
    ...lines.map((l) => {
      const next = l.born && birthdayText(nextBirthday(l.born, today));
      // His map's and Contacts' birthday is the date itself; a fact keeps its words.
      const text = isFact(l)
        ? [l.text, next && `Next: ${next}`].filter(Boolean).join(" ")
        : next || l.text;
      return `- ${LABELS.get(l.kind)}: ${text} (${SOURCE_NAMES[l.from] ?? l.from})`;
    }),
    "",
  ];
}
