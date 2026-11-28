import type { Database } from "bun:sqlite";
import { clock, DAY } from "../core/clock";
import { readChangeStamp } from "../core/files";
import { isInboxCheck } from "../memory/check-urgency";
import { rateOffersOf } from "../memory/decision-after-answer";
import { deliveryOf } from "../memory/decision-delivery";
import type { Decision } from "../memory/decision-lines";
import { decisionsNow } from "../memory/decisions";
import type {
  DeletionCopy,
  ThreadEntriesHolding,
} from "../memory/delete-from-memory";
import {
  iconNow,
  MATTER_ICON_PICKS,
  readLifeIcons,
} from "../memory/matter-icons";
import type { MatterView } from "../memory/matter-read";
import {
  laterUntilOf,
  MATTER_BOOK_READS,
  readMatterBook,
} from "../memory/matters";
import { deletionsNow } from "../memory/memory-files";
import { readPeople } from "../memory/who";
import { dayNow } from "../memory/zones";
import { readOwnerName } from "../models/prompt-parts";
import { firstNameOf } from "../records/truth";
import { undoOf } from "./answer-result";
import { isQuietLineDeleted, quietLineRefOf, readDesk } from "./desk-read";
import { hasColumn } from "./desk-shape";
import { estimateOf, type HandedKind } from "./desk-turn-reads";
import { openChecksNow, unchangedOf, versionOf } from "./inbox";
import { readProjectsWithoutRoom, WAITS_FOR_ROOM } from "./spending";

// The Life thread (`read_thread`): his asks to Life and its answers (the desk's `thread_entry` rows), the agents' cards
// as they were delivered and answered (`decisions.jsonl`) and Life's own checks, merged by time, a few days a page. Never
// a second copy: each item's state is worked out when read, by `itemStateOf` alone. An entry his deletion names
// (`thread:<id>`) or whose answer cites what he deleted is hidden here, at read; the desk blanks the named ones in place
// on its tick (`desk/thread-deletions.ts`), the only writer of its store.

/** How many days of the thread a page holds. */
const PAGE_DAYS = 3;

/** A thread item's state, the only place that names one. The phone alone adds `queued` (answered while offline). */
export const ITEM_STATES = [
  "later",
  "needs_you",
  "outdated",
  "settled",
  "under_way",
  "waiting_on_someone",
] as const;
export type ItemState = (typeof ITEM_STATES)[number];

/**
 * Where a thread item stands: an open check needs him, unless his Later holds it (`later`, its until); a card he
 * answered is under way while its asker's turn runs on it (`running`; handed work too), waiting on someone when its
 * matter is (`matterStatus`), else settled; a withdrawn or lapsed card is outdated. Pure.
 */
export function itemStateOf(x: {
  decision?: Pick<Decision, "state">;
  isOpen: boolean;
  later?: string;
  matterStatus?: MatterView["status"];
  running: boolean;
}): ItemState {
  if (x.isOpen) {
    return x.later ? "later" : "needs_you";
  }
  if (x.decision?.state === "withdrawn" || x.decision?.state === "lapsed") {
    return "outdated";
  }
  if (x.running) {
    return "under_way";
  }
  return x.matterStatus === "waiting_on_someone"
    ? "waiting_on_someone"
    : "settled";
}

interface EntryRow {
  answer: string | null;
  answered_at: string | null;
  asked_at: string;
  error: string | null;
  follows: number | null;
  id: number;
  reactions: string;
  refs: string;
  words: string | null;
}

/** The entries asked in [`from`, `to`) with their handed work (its kind, since when, whether it runs, its quiet line and its estimate), and whether any is older. */
function entriesOf(db: Database, from: string, to: string) {
  const rows = db
    .query<EntryRow, [string, string]>(
      "select id, asked_at, words, answer, error, refs, reactions, answered_at, follows from thread_entry where asked_at >= ? and asked_at < ? and deleted_at is null order by asked_at"
    )
    .all(from, to);
  const handed = db.query<
    {
      assignment_id: string;
      doing: string | null;
      eta: string | null;
      handed_at: string;
      kind: HandedKind;
      project: string | null;
      rev: string | null;
      running: number;
    },
    [number]
  >(
    // A project runs until its assignment closes; other work, until the first turn after its hand-over ends.
    `select h.kind, h.handed_at, h.assignment_id, q.doing, q.eta, q.rev, a.project, case when h.kind = 'project' then s.closed_at is null else not exists (select 1 from turn t where t.assignment_id = h.assignment_id and t.started_at >= h.handed_at and t.ended_at is not null) end as running
      from handed_work h join assignment s on s.id = h.assignment_id join agent a on a.id = s.agent_id left join quiet_line q on q.assignment_id = h.assignment_id and q.at >= h.handed_at where h.entry_id = ? order by h.handed_at`
  );
  const noRoom = readProjectsWithoutRoom(db);
  const isOlder = Boolean(
    db.query("select 1 from thread_entry where asked_at < ? limit 1").get(from)
  );
  return {
    entries: rows.map((e) => ({
      ...e,
      handed: handed.all(e.id).map((h) => {
        // Its agent's quiet line (what it does now, its eta as the time from the hand-over, else the kind's estimate),
        // or, for a project waiting for room in the month, that it waits.
        // A quiet line a deletion named is hidden until the desk deletes it.
        const isWaitingForRoom =
          Boolean(h.running) && h.project !== null && noRoom.has(h.project);
        const line =
          h.rev && !isQuietLineDeleted({ ...h, rev: h.rev }) ? h : null;
        const eta = isWaitingForRoom ? null : (line?.eta ?? null);
        return {
          doing: isWaitingForRoom ? WAITS_FOR_ROOM : (line?.doing ?? null),
          estimateMs: eta
            ? Date.parse(eta) - Date.parse(h.handed_at)
            : estimateOf(db, h.kind),
          kind: h.kind,
          since: h.handed_at,
          state: itemStateOf({ isOpen: false, running: Boolean(h.running) }),
        };
      }),
    })),
    isOlder,
  };
}

/** The cards whose `decision.answered` an asker's turn has not ended on yet. */
const runningOf = (db: Database, ids: readonly string[]) =>
  new Set(
    ids.filter((id) =>
      db
        .query(
          "select 1 from event where event_id = ? and consumed_at is null and dropped_at is null"
        )
        .get(`${id}.answered`)
    )
  );

interface MatterLook {
  /** Its icon's key (`iconNow`: his pick, else Life's), the ask row's face when no one is behind the card. */
  icon?: string;
  status: MatterView["status"];
}

/** Each matter's status and its icon's key (`iconNow`). */
async function readMatterLooks() {
  const b = await readMatterBook(await readPeople(), dayNow());
  const picks = readLifeIcons();
  return new Map<string, MatterLook>(
    b.map((m) => [m.id, { icon: iconNow(m, picks)?.key, status: m.status }])
  );
}

/** Each matter's status and icon, read again only when what the book reads changed, his day did or an icon pick landed. */
let book: { key: string; looks: Promise<Map<string, MatterLook>> } | undefined;
function matterLooks() {
  const key = JSON.stringify([
    readChangeStamp([...MATTER_BOOK_READS, MATTER_ICON_PICKS]),
    dayNow(),
  ]);
  if (book?.key !== key) {
    const looks = readMatterLooks();
    book = { key, looks };
    looks.catch(() => {
      book = undefined;
    });
  }
  return book.looks;
}

/** An open check with its matters' icons (`MatterLook`), for the row's face. Pure. */
export const withMatterIcons = <
  C extends {
    matter: { id: string } | null;
    onMatters: readonly { id: string }[];
  },
>(
  c: C,
  looks: ReadonlyMap<string, MatterLook>
) => {
  const iconOf = <M extends { id: string }>(m: M) => {
    const icon = looks.get(m.id)?.icon;
    return icon ? { ...m, icon } : m;
  };
  return {
    ...c,
    matter: c.matter && iconOf(c.matter),
    onMatters: c.onMatters.map(iconOf),
  };
};

/** A card he no longer needs to answer, as the thread shows it: what was asked, his answer and what came of it, and his Undo while there is one. */
const closedCardOf = (
  d: Decision,
  offers: ReturnType<typeof rateOffersOf>
) => ({
  answer: d.answer
    ? {
        at: d.answer.at,
        note: d.answer.note ?? null,
        options: d.answer.options,
      }
    : null,
  ask: d.ask ?? null,
  options: d.options.map(({ id, label }) => ({ id, label })),
  question: d.question,
  /** "How am I doing?" on it (`rateOffersOf`): his mark so far, null when none; null when not asked. */
  rate: offers.has(d.id) ? { mark: offers.get(d.id)?.mark ?? null } : null,
  sent: d.send?.kind === "sent" ? { at: d.send.at } : null,
  title: d.title,
  undo: undoOf(d),
  withdrawn: d.withdrawn
    ? { replacedBy: d.withdrawn.replacedBy ?? null, why: d.withdrawn.why }
    : null,
});

/**
 * `read_thread`: the thread's page of `PAGE_DAYS` days ending at `before` (none: now), oldest first: his entries (but
 * one whose answer cites what he deleted) and the cards delivered in it, each with its state (`itemStateOf`); the
 * first page also holds Life's own open checks that were never asked at an instant. `earlier`: pass it as `before` for
 * the page before, null when there is none. The first page also says what his phone's opening screen shows (his yes of
 * 26 Nov 2026): `owner`, what he is called (its greeting), and `openingAsks`, the refs of the open asks that block him,
 * fixes aside, in his inbox's order (`inboxOrderOf`, `urgencyOf`). With `ifNot` its version, only `unchangedOf` it.
 */
export async function readThread(o: { before?: string; ifNot?: string } = {}) {
  const now = clock();
  const to = o.before ?? now.toISOString();
  const from = new Date(Date.parse(to) - PAGE_DAYS * DAY).toISOString();
  const gone = deletionsNow().refs;
  const desk = readDesk((db) => entriesOf(db, from, to), {
    entries: [],
    isOlder: false,
  });
  const { entries, isOlder } =
    desk.state === "ok" ? desk.value : { entries: [], isOlder: false };
  const all = decisionsNow(now);
  const offers = rateOffersOf(all);
  // An ending check shows on its matter's page, never in the thread or its count (`isInboxCheck`).
  const open = new Map(
    (await openChecksNow()).filter(isInboxCheck).map((c) => [c.ref, c])
  );
  // The first page also holds every card still open, however old: what waits on him is never a page away.
  const cards = all.filter(
    (d) =>
      (d.at >= from || (!o.before && open.has(d.id))) &&
      d.at < to &&
      deliveryOf(d, now).state === "delivered" &&
      !gone.has(d.id)
  );
  const running = readDesk(
    (db) =>
      runningOf(
        db,
        cards.map((d) => d.id)
      ),
    new Set<string>()
  );
  const looks = await matterLooks();
  const items = [
    ...entries
      .filter((e) => !isGoneOf(gone, e))
      .map((e) => ({
        answer: e.answer,
        answeredAt: e.answered_at,
        at: e.asked_at,
        error: e.error,
        // A late reply of an agent: the entry of his ask it follows (no words of his).
        follows: e.follows,
        handed: e.handed,
        id: e.id,
        kind: "entry" as const,
        reactions: JSON.parse(e.reactions) as unknown[],
        refs: JSON.parse(e.refs) as string[],
        words: e.words,
      })),
    ...cards.map((d) => {
      const check = open.get(d.id);
      const later = laterUntilOf(d.id, now);
      return {
        at: d.at,
        card: check ? withMatterIcons(check, looks) : closedCardOf(d, offers),
        kind: "ask" as const,
        later: later ?? null,
        ref: d.id,
        state: itemStateOf({
          decision: d,
          isOpen: Boolean(check),
          later,
          matterStatus: d.matter ? looks.get(d.matter)?.status : undefined,
          running: running.state === "ok" && running.value.has(d.id),
        }),
      };
    }),
    // Life's own checks, never asked at an instant: on the first page, as now.
    ...(o.before
      ? []
      : [...open.values()]
          .filter((c) => c.group !== "decision")
          .map((c) => {
            const later = laterUntilOf(c.ref, now);
            return {
              at: c.at ?? to,
              card: withMatterIcons(c, looks),
              kind: "ask" as const,
              later: later ?? null,
              ref: c.ref,
              state: itemStateOf({ isOpen: true, later, running: false }),
            };
          })),
  ].toSorted(
    // What is broken and needs him comes before anything else (docs/product.md): open fix checks lead the page.
    (a, b) => Number(isFix(b)) - Number(isFix(a)) || a.at.localeCompare(b.at)
  );
  const openingScreen = o.before
    ? undefined
    : {
        openingAsks: [...open.values()]
          .filter((c) => c.urgency === "blocks" && c.group !== "fix")
          .map((c) => c.ref),
        owner: ownerNameOf(),
      };
  const version = versionOf(JSON.stringify({ items, openingScreen }));
  if (o.ifNot === version) {
    return unchangedOf(version);
  }
  const isOlderCard = all.some((d) => d.at < from);
  return {
    earlier: isOlder || isOlderCard ? from : null,
    items,
    ...openingScreen,
    version,
  };
}

/** What he is called, for the greeting: the first word only, while prompts keep his whole `called`; null when his directory can't be read (a new install), and the phone says "Hi". */
const ownerNameOf = () => {
  try {
    return firstNameOf(readOwnerName());
  } catch {
    return null;
  }
};

/** An open fix check no one is on yet (the inbox puts one the caretaker is at work on last, `before`). */
const isFix = (x: object) => {
  const c =
    "card" in x ? (x.card as { beingFixed?: unknown; group?: string }) : {};
  return (
    "group" in c && c.group === "fix" && !("beingFixed" in c && c.beingFixed)
  );
};

/** A thread entry's ref, as a deletion names it. */
export const threadEntryRefOf = (id: number) => `thread:${id}`;

/** Whether a thread entry is hidden: a deletion (`gone`, its refs) names it, or its answer cites what one removed. */
const isGoneOf = (
  gone: ReadonlySet<string>,
  e: Pick<EntryRow, "id" | "refs">
) =>
  gone.has(threadEntryRefOf(e.id)) ||
  (JSON.parse(e.refs) as string[]).some((r) => gone.has(r));

/** His thread entry `entry` as he still sees it (its words and when), none when it was deleted (`isGoneOf`): what may leave the thread for an agent or his directory. */
export function shownEntryOf(db: Database, entry: number) {
  const e = db
    .query<Pick<EntryRow, "asked_at" | "id" | "refs" | "words">, [number]>(
      "select id, asked_at, words, refs from thread_entry where id = ? and deleted_at is null"
    )
    .get(entry);
  return e && !isGoneOf(deletionsNow().refs, e) ? e : undefined;
}

/** How many of his entries before the one handed an agent reads with it, within `DAY`. */
const AROUND = 10;

/**
 * The talk around his thread entry `entry`, as an agent given work from it reads it (`read_handed_conversation`): that
 * entry and up to `AROUND` before it within a day, his words and Life's answers, oldest first; none he deleted (blanked,
 * named by a deletion, or citing what one removed), as `readThread` hides them.
 */
export function conversationAroundOf(db: Database, entry: number) {
  const at = shownEntryOf(db, entry)?.asked_at;
  if (!at) {
    return [];
  }
  const gone = deletionsNow().refs;
  return db
    .query<
      Pick<EntryRow, "answer" | "asked_at" | "id" | "refs" | "words">,
      [string, string, number, number]
    >(
      "select id, asked_at, words, answer, refs from thread_entry where deleted_at is null and asked_at >= ? and (asked_at < ? or id = ?) order by asked_at desc limit ?"
    )
    .all(new Date(Date.parse(at) - DAY).toISOString(), at, entry, AROUND + 1)
    .filter((e) => !isGoneOf(gone, e))
    .reverse()
    .map((e) => ({
      answer: e.answer,
      at: e.asked_at,
      id: e.id,
      words: e.words,
    }));
}

/**
 * The thread entries not yet blanked whose words, answer or refs hold what a deletion removes (`holds`), and the quiet
 * lines whose words hold it (an agent's `doing` may quote it): its preview's.
 * Every entry is read: a deletion is rare and the thread small (ponytail: a scan; by day if it ever grows large).
 */
export const threadEntriesHolding: ThreadEntriesHolding = (holds) => {
  const read = readDesk(
    (db) => ({
      entries: db
        .query<
          {
            answer: string | null;
            id: number;
            refs: string;
            words: string | null;
          },
          []
        >(
          "select id, words, answer, refs from thread_entry where deleted_at is null order by id"
        )
        .all(),
      // A store the desk has not opened since quiet lines came has none.
      quiet: hasColumn(db, "quiet_line", "rev")
        ? db
            .query<{ assignment_id: string; doing: string; rev: string }, []>(
              "select assignment_id, doing, rev from quiet_line order by assignment_id"
            )
            .all()
        : [],
    }),
    { entries: [], quiet: [] },
    // A deletion finds its copies while the desk is off too.
    true
  );
  const { entries, quiet } =
    read.state === "ok" ? read.value : { entries: [], quiet: [] };
  return [
    ...entries.flatMap((e): DeletionCopy[] =>
      holds([e.words, e.answer], JSON.parse(e.refs) as string[])
        ? [{ id: threadEntryRefOf(e.id), kind: "thread entry" }]
        : []
    ),
    ...quiet.flatMap((q): DeletionCopy[] =>
      holds([q.doing], [])
        ? [{ id: quietLineRefOf(q), kind: "quiet line" }]
        : []
    ),
  ];
};
