import { newestDays, within } from "../core/lists";
import { redact } from "../core/redact";
import type { CommunicationStyleLine } from "../records/communication-style";
import { ClosenessLevel } from "../records/observation";
import type { SituationLine } from "../records/situation";
import type { Unit } from "../records/unit";
import { contactKeyOf } from "../sources/contacts";
import { closerOf } from "./closeness";
import { type DetailLine, nextBirthday } from "./details";
import { exchangesOf } from "./exchanges";
import { readUnitsFor } from "./memory-files";
import type { Party } from "./party";
import { isWithOnly, readPersonUnits } from "./person-units";
import type { Reach } from "./reach";
import type { MatterRow } from "./read-matters";
import { PART_CHARS, type ReadPartRef, readPartRefOf } from "./read-part";
import { OWNER } from "./read-truth";
import { kindOf, sourceOf } from "./sources";
import type { People } from "./who";
import { unitLines } from "./words";
import { localDate } from "./zones";

// A person's or an organization's read as data (`read_people_and_organizations`, the People tab): the list, ordered by
// closeness, and one of them `now`, bounded like every part. `person()` (`read-person-page.ts`) gathers; this shapes.

/** A matter row as the readers give it now (`matterRowsNowOf`, host): with its open checks that block him and `needsYou`. */
export type MatterRowNow = MatterRow & {
  agent?: string;
  blockingChecks: number;
  needsYou: boolean;
};

/** Someone on the list: the party, how close (none until judged), their last exchange with him, and whether anything with them needs him. */
export type PersonRow = Party & {
  lastExchangeAt?: string;
  level?: ClosenessLevel;
  needsYou: boolean;
};

/** Whether a matter row has `ref` among its people, in any role. */
export const isIn = (row: Pick<MatterRow, "people">, ref: string) =>
  Object.values(row.people ?? {}).some((list) =>
    list.some((p) => p.ref === ref)
  );

/** What the list and `now` know of one ref: its level and its last exchange, read once by the caller. */
export interface Standing {
  lastExchangeAt: (ref: string) => string | undefined;
  levelOf: (
    ref: string
  ) => { personal: ClosenessLevel; work: ClosenessLevel } | undefined;
}

/** A party as a list row: its closer level, its last exchange, and whether any of its running matters needs him. Pure. */
export const rowOf = (
  party: Party,
  standing: Standing,
  matters: readonly MatterRowNow[]
): PersonRow => {
  const l = standing.levelOf(party.ref);
  const last = standing.lastExchangeAt(party.ref);
  return {
    ...party,
    ...(last ? { lastExchangeAt: last } : {}),
    ...(l ? { level: closerOf(l) } : {}),
    needsYou: matters.some((m) => m.needsYou && isIn(m, party.ref)),
  };
};

/** The rank of a row: its level by `ClosenessLevel.options`, someone not judged yet after all four. */
const rankOf = (r: PersonRow) =>
  r.level
    ? ClosenessLevel.options.indexOf(r.level)
    : ClosenessLevel.options.length;

/** The list: by level (inner, regular, acquaintance, faded, then not judged), inside a level the newest exchange first, then by name. Pure. */
export const peopleListOf = (rows: PersonRow[]) =>
  rows.toSorted(
    (a, b) =>
      rankOf(a) - rankOf(b) ||
      (b.lastExchangeAt ?? "").localeCompare(a.lastExchangeAt ?? "") ||
      a.name.localeCompare(b.name)
  );

/** A detail as `now` gives it: a birthday with its next date, the days left and the age then. */
export type DetailNow = DetailLine & {
  next?: ReturnType<typeof nextBirthday>;
};

/** A part that holds something, as `now` offers it: the ref `fetch` opens and its first sentence. */
export interface KnownPart {
  first: string;
  part: string;
  ref: string;
}

/** Someone at an organization, his word in its entry: their party, role, and the year or day they left. */
export interface Member {
  party: Party;
  role: string;
  until?: number | string;
}

/** What `personNowOf` is made from, read by `person()`. */
export interface NowInputs {
  communicationStyle: CommunicationStyleLine[];
  details: DetailLine[];
  /** His directory holds only him: the setup interview is due. */
  directoryIsNew?: true;
  episodes: { month: string; titles: string[] }[];
  knows: KnownPart[];
  /** The running matters with them, ranked (`read_matters`' order). */
  matters: MatterRowNow[];
  organization?: { domains: string[]; people: Member[] };
  reach: Reach[];
  row: PersonRow;
  situation: SituationLine[];
  today: string;
}

/**
 * Someone's `now`, as data: their row, reach, details (a birthday dated; a phone or mail reach already opens is left
 * out), how each writes to the other, what their time together was about, their situation, the parts Life holds
 * (`knows`), an organization's domains and people, and their open matters, which take the room the rest leaves of
 * `PART_CHARS`, ranked first; `moreMatters` counts the rest (`read_matters` with them reads all). Pure.
 */
export function personNowOf(i: NowInputs) {
  const reached = new Set(
    i.reach.flatMap((r) =>
      r.accounts.map((a) => contactKeyOf(a.handle) ?? a.handle)
    )
  );
  const details: DetailNow[] = i.details
    .filter(
      (d) =>
        d.kind !== "handles" || !reached.has(contactKeyOf(d.text) ?? d.text)
    )
    .map((d) =>
      d.kind === "birthday" ? { ...d, next: nextBirthday(d.text, i.today) } : d
    );
  const rest = {
    ...i.row,
    communicationStyle: i.communicationStyle,
    details,
    ...(i.directoryIsNew ? { directoryIsNew: true as const } : {}),
    episodes: i.episodes,
    knows: i.knows,
    ...(i.organization ?? {}),
    reach: i.reach,
    situation: i.situation,
  };
  const room = PART_CHARS - JSON.stringify(rest).length;
  const open = within(i.matters, room, (m) => JSON.stringify(m).length + 1);
  const more = i.matters.length - open.length;
  return { ...rest, open, ...(more > 0 ? { moreMatters: more } : {}) };
}

const SENTENCE = /^(.+?[.!?])(?:\s|$)/;
const LEAD = /^(?:[-*]\s+|#+\s*)/;

/** A part's first sentence: its first line of prose (no heading, no note in brackets, no label ending in a colon), up to its first stop. None when it holds none. */
export function firstSentenceOf(lines: string[]) {
  const line = lines
    .flatMap((l) => l.split("\n"))
    .map((l) => l.trim())
    .find(
      (l) =>
        l !== "" &&
        !l.startsWith("#") &&
        !l.startsWith("(") &&
        !l.startsWith("---") &&
        !l.endsWith(":")
    );
  const text = line?.replace(LEAD, "");
  return text ? (SENTENCE.exec(text)?.[1] ?? text).slice(0, 300) : undefined;
}

/** `knows` from the reads `now` offers: each part that holds something, its ref and its first sentence. */
export const knowsOf = (
  reads: { ref: ReadPartRef }[],
  linesOf: (part: string) => string[]
): KnownPart[] =>
  reads.flatMap(({ ref }) => {
    const first = firstSentenceOf(linesOf(ref.part));
    return first ? [{ first, part: ref.part, ref: readPartRefOf(ref) }] : [];
  });

/** One exchange of `latest`: where, when it started, the link that opens its chat, and its lines, his and theirs. */
export interface LatestExchange {
  at: string;
  channel: string;
  lines: { by: "him" | "them"; text: string }[];
  open?: { lands: "chat"; url: string };
}

/** A conversation in person, as `latest` lists it: when, what it was about, and the unit `fetch` opens. */
export interface LatestHeard {
  at: string;
  channel: "voice";
  summary: string;
  unit: string;
}

/** How many exchanges a page of `latest` holds (whole days: the last day may add some). */
const LATEST = 5;
/** How many of their units one round reads from the index. */
const LATEST_ROUND = 20;
/** A line of `latest` is cut here: the whole message is in `read_chats`. */
const LATEST_LINE = 500;

/** A unit of theirs as `latest` items: a conversation in person as one, a 1:1 chat-day or mail thread as its exchanges, a group's none. */
async function latestOf(
  u: Unit,
  isDirect: boolean,
  people: People
): Promise<(LatestExchange | LatestHeard)[]> {
  if (kindOf(u.source) === "voice") {
    return [
      {
        at: u.start,
        channel: "voice",
        summary: u.summary ?? u.title,
        unit: u.id,
      },
    ];
  }
  const source = sourceOf(u.source);
  if (!isDirect || source.group?.(u.key)) {
    return [];
  }
  const messages = (await unitLines(u, people))?.built.messages ?? [];
  const handle =
    source.handleOf?.(u.key) ?? messages.findLast((m) => !m.fromMe)?.sender;
  const url = handle && source.chatLinkOf?.(handle);
  return exchangesOf(messages).map((exchange) => ({
    at: (exchange[0] as { at: string }).at,
    channel: u.source,
    lines: exchange.map((m) => ({
      by: m.fromMe ? ("him" as const) : ("them" as const),
      text: redact(m.text).slice(0, LATEST_LINE),
    })),
    ...(url ? { open: { lands: "chat" as const, url } } : {}),
  }));
}

/**
 * `latest`: their newest exchanges with him, newest first, five a page by whole days (`before` a day pages back):
 * each one-to-one chat-day and mail thread read from its source and cut where talk paused (`exchangesOf`); a
 * conversation in person as one item. Read through their units (`readPersonUnits`), a round of days at a time, never a
 * source whole.
 */
export async function readLatest(
  ref: string,
  before: string | undefined,
  people: People
) {
  const refs = new Set([ref]);
  const items: (LatestExchange | LatestHeard)[] = [];
  let day = before;
  let more = true;
  while (more && items.length <= LATEST) {
    const listed = readPersonUnits([ref], {
      before: day,
      count: LATEST_ROUND,
      kinds: ["chat", "mail", "voice"],
    });
    more = listed.length > 0;
    day = listed.at(-1)?.date;
    const direct = new Set(
      listed.filter((u) => isWithOnly(u, refs)).map((u) => u.id)
    );
    // biome-ignore lint/performance/noAwaitInLoops: a round reads the next days only while the page is not full
    const round = await Promise.all(
      readUnitsFor(listed.map((x) => x.id)).map((u) =>
        latestOf(u, direct.has(u.id), people)
      )
    );
    items.push(...round.flat());
  }
  const { next, taken } = newestDays(
    items.toSorted((a, b) => b.at.localeCompare(a.at)),
    (x) => localDate(x.at),
    LATEST
  );
  const oldest = taken.at(-1);
  const nextBefore =
    next ?? (more && oldest ? localDate(oldest.at) : undefined);
  return { latest: taken, ...(nextBefore ? { nextBefore } : {}) };
}

/** The owner is never on his own list of people. */
export const isOnTheList = (ref: string) => ref !== OWNER;
