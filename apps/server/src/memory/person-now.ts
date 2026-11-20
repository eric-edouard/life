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
import type { Party } from "./party";
import { isWithThemAlone, readPersonUnitFiles } from "./person-units";
import type { Reach } from "./reach";
import type { MatterRow } from "./read-matters";
import {
  NEXT_READS,
  PART_CHARS,
  type ReadPartRef,
  readPartRefOf,
} from "./read-part";
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

/** A detail as `now` gives it: a birthday with its next date, the days left and the age then; an account reach had no room for (`reach`). */
export type DetailNow = Omit<DetailLine, "from"> & {
  from: DetailLine["from"] | "reach";
  next?: ReturnType<typeof nextBirthday>;
};

/** Reach's room in `now`: what does not fit goes to `details`. */
const REACH_CHARS = PART_CHARS / 3;

/** Reach within `REACH_CHARS`, app by app, each app's accounts newest first; `left`, the accounts that did not fit. Pure. */
function reachWithin(all: Reach[]) {
  let used = 0;
  const left: { handle: string; label: string }[] = [];
  const reach = all.flatMap((r) => {
    const accounts = r.accounts.filter((a) => {
      used += JSON.stringify(a).length + 1;
      if (used > REACH_CHARS) {
        left.push({ handle: a.handle, label: r.label });
      }
      return used <= REACH_CHARS;
    });
    return accounts.length > 0 ? [{ ...r, accounts }] : [];
  });
  return { left, reach };
}

/**
 * The `reach` part's page, built and measured as it is sent (`{ reach, next }`): every account from the `skip`th on
 * (apps in order, each app's accounts newest first), as many as keep it within `PART_CHARS`, at least one; `next`, the
 * ref of the following page, absent on the last. A first account too big alone loses the end of its title (the optional
 * display text), never its handle or link. Pure. ponytail: each size is measured afresh, quadratic in a page's accounts.
 */
export function reachPageOf(all: Reach[], skip: number, subject: string) {
  const flat = all.flatMap((r, app) =>
    r.accounts.map((account) => ({ account, app }))
  );
  const pageOf = (count: number, cut = 0) => {
    const taken = flat.slice(skip, skip + count).map((x, i) => ({
      ...x,
      account:
        i === 0 && cut > 0
          ? {
              ...x.account,
              title:
                [...(x.account.title ?? "")].slice(0, -cut).join("") ||
                undefined,
            }
          : x.account,
    }));
    const reach = [...Map.groupBy(taken, (x) => x.app)].map(([app, list]) => ({
      ...(all[app] as Reach),
      accounts: list.map((x) => x.account),
    }));
    return skip + count < flat.length
      ? {
          next: readPartRefOf({
            part: "reach",
            span: String(skip + count),
            subject,
          }),
          reach,
        }
      : { reach };
  };
  const size = (x: unknown) => JSON.stringify(x).length;
  let n = 1;
  while (skip + n < flat.length && size(pageOf(n + 1)) <= PART_CHARS) {
    n += 1;
  }
  // Cut the title by what the page is over (whole characters, never half a pair), measured again after each cut: an
  // escaped character can weigh more than one. A page over with no title left is as small as it gets.
  let trim = 0;
  let page = pageOf(n);
  while (size(page) > PART_CHARS && page.reach[0]?.accounts[0]?.title) {
    trim += size(page) - PART_CHARS;
    page = pageOf(n, trim);
  }
  return page;
}

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
 * `now`'s lists in the order they keep their room: what doesn't fit is cut from each one's end (episodes the oldest
 * months, matters the least pressing), and `more` counts what each lost (`open`: `read_matters` with them;
 * `episodes`: the `evidence` part). Reach is not among them: it keeps to its own room (`reachWithin`), the accounts it
 * has no room for given in `details`.
 */
const KEPT_FIRST = [
  "details",
  "knows",
  "situation",
  "open",
  "communicationStyle",
  "people",
  "domains",
  "episodes",
] as const;

/**
 * Someone's `now`, as data: their row, reach, details (a birthday dated; a phone or mail reach already opens is left
 * out), how each writes to the other, what their time together was about, their situation, the parts Life holds
 * (`knows`), an organization's domains and people, and their open matters, ranked. The whole answer serialized stays
 * within `chars` (`PART_CHARS`, less what wraps it): its lists are cut by `KEPT_FIRST`. Pure.
 */
export function personNowOf(i: NowInputs, chars = PART_CHARS) {
  const keyOf = (h: string) => contactKeyOf(h) ?? h;
  const { left, reach } = reachWithin(i.reach);
  const reached = new Set(
    reach.flatMap((r) => r.accounts.map((a) => keyOf(a.handle)))
  );
  const held = new Set(i.details.map((d) => keyOf(d.text)));
  const details: DetailNow[] = [
    ...i.details.filter(
      (d) => d.kind !== "handles" || !reached.has(keyOf(d.text))
    ),
    // An account reach had no room for: a handle here.
    ...left
      .filter((a) => !held.has(keyOf(a.handle)))
      .map((a) => ({
        from: "reach" as const,
        kind: "handles" as const,
        text: `${a.label}: ${a.handle}`,
      })),
  ].map((d) =>
    d.kind === "birthday" ? { ...d, next: nextBirthday(d.text, i.today) } : d
  );
  const full = {
    ...i.row,
    communicationStyle: i.communicationStyle,
    details,
    ...(i.directoryIsNew ? { directoryIsNew: true as const } : {}),
    episodes: i.episodes,
    knows: i.knows,
    open: i.matters,
    ...(i.organization ?? {}),
    // Accounts reach had no room for are in `details`, cut there too: all of them, paged, are the `reach` part.
    ...(left.length > 0
      ? { moreReach: readPartRefOf({ part: "reach", subject: i.row.ref }) }
      : {}),
    reach,
    situation: i.situation,
  };
  const lists = KEPT_FIRST.filter((k) => k in full);
  const sizeOf = (x: unknown) => JSON.stringify(x).length + 1;
  const bare = Object.fromEntries(lists.map((k) => [k, []]));
  // The room left once everything but the lists, and `more` at its largest, is counted.
  let room =
    chars -
    sizeOf({
      ...full,
      ...bare,
      more: Object.fromEntries(lists.map((k) => [k, 99_999])),
    });
  const kept: Record<string, unknown[]> = {};
  const more: Record<string, number> = {};
  for (const k of lists) {
    const list = full[k as keyof typeof full] as unknown[];
    const fit = within(list, room, sizeOf);
    room -= fit.reduce((n: number, x) => n + sizeOf(x), 0);
    kept[k] = fit;
    if (fit.length < list.length) {
      more[k] = list.length - fit.length;
    }
  }
  return {
    ...full,
    ...(kept as Partial<typeof full>),
    ...(Object.keys(more).length > 0 ? { more } : {}),
  };
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

/** `knows` from the reads `now` offers: each part that holds something, its ref and the first sentence of its content (its next reads left out). */
export const knowsOf = (
  reads: { ref: ReadPartRef }[],
  linesOf: (part: string) => string[]
): KnownPart[] =>
  reads.flatMap(({ ref }) => {
    const lines = linesOf(ref.part);
    const navigation = lines.indexOf(NEXT_READS);
    const first = firstSentenceOf(
      navigation < 0 ? lines : lines.slice(0, navigation)
    );
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

/**
 * A unit of theirs as `latest` items: a conversation in person as one, a 1:1 chat-day or mail thread as its exchanges;
 * none for a group's, or for a thread another wrote in (the index leaves out a mail's senders no one knows): every
 * other writer must read as `ref`.
 */
async function latestOf(
  u: Unit,
  direct: boolean,
  ref: string,
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
  if (!direct) {
    return [];
  }
  const messages = (await unitLines(u, people))?.built.messages ?? [];
  const source = sourceOf(u.source);
  const senders = messages.filter((m) => !m.fromMe).map((m) => m.sender);
  const held = {
    chat: u.key,
    chatName: u.title === u.key ? null : u.title,
    senders,
    source: u.source,
  };
  if (!isWithThemAlone(held, ref, people)) {
    return [];
  }
  const handle = source.handleOf?.(u.key) ?? senders[0];
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
 * conversation in person as one item. Read through their units (`readPersonUnitFiles`), a round of days at a time,
 * never a source whole.
 */
export async function readLatest(
  ref: string,
  before: string | undefined,
  people: People
) {
  const items: (LatestExchange | LatestHeard)[] = [];
  let day = before;
  let more = true;
  while (more && items.length <= LATEST) {
    const { listed, units } = readPersonUnitFiles([ref], {
      before: day,
      count: LATEST_ROUND,
      kinds: ["chat", "mail", "voice"],
    });
    more = listed.length > 0;
    day = listed.at(-1)?.date;
    // biome-ignore lint/performance/noAwaitInLoops: a round reads the next days only while the page is not full
    const round = await Promise.all(
      units.map(({ direct, unit }) => latestOf(unit, direct, ref, people))
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
