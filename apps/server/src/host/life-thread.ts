import type { Database } from "bun:sqlite";
import { clock, DAY } from "../core/clock";
import { readChangeStamp } from "../core/files";
import { isInboxCheck } from "../memory/check-urgency";
import { rateOffersOf } from "../memory/decision-after-answer";
import { deliveryOf } from "../memory/decision-delivery";
import type { Decision } from "../memory/decision-lines";
import { actOutcomeOf, decisionsNow } from "../memory/decisions";
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
import { readDesk } from "./desk-read";
import { estimateOf, type HandedKind } from "./desk-turn-reads";
import { openChecksNow, unchangedOf, versionOf } from "./inbox";

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

/** The entries asked in [`from`, `to`) with their handed work (its kind, since when, whether it runs and its estimate), and whether any is older. */
function entriesOf(db: Database, from: string, to: string) {
  const rows = db
    .query<EntryRow, [string, string]>(
      "select id, asked_at, words, answer, error, refs, reactions, answered_at, follows from thread_entry where asked_at >= ? and asked_at < ? and deleted_at is null order by asked_at"
    )
    .all(from, to);
  const handed = db.query<
    { handed_at: string; kind: HandedKind; running: number },
    [number]
  >(
    `select h.kind, h.handed_at, not exists (select 1 from turn t where t.assignment_id = h.assignment_id and t.started_at >= h.handed_at and t.ended_at is not null) as running
      from handed_work h where h.entry_id = ? order by h.handed_at`
  );
  const isOlder = Boolean(
    db.query("select 1 from thread_entry where asked_at < ? limit 1").get(from)
  );
  return {
    entries: rows.map((e) => ({
      ...e,
      handed: handed.all(e.id).map((h) => ({
        estimateMs: estimateOf(db, h.kind),
        kind: h.kind,
        since: h.handed_at,
        state: itemStateOf({ isOpen: false, running: Boolean(h.running) }),
      })),
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
/** When his answer's send ended with every draft sent (the last one's line); null when it sent nothing, or not all. */
const sentAtOf = (d: Decision) => {
  const last = actOutcomeOf(d, "send");
  return last && d.sends.every((s) => s.kind === "sent")
    ? { at: last.at }
    : null;
};

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
  sent: sentAtOf(d),
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
      .filter(
        (e) =>
          !(
            gone.has(threadEntryRefOf(e.id)) ||
            (JSON.parse(e.refs) as string[]).some((r) => gone.has(r))
          )
      )
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

/**
 * The thread entries not yet blanked whose words, answer or refs hold what a deletion removes (`holds`): its preview's.
 * Every entry is read: a deletion is rare and the thread small (ponytail: a scan; by day if it ever grows large).
 */
export const threadEntriesHolding: ThreadEntriesHolding = (holds) => {
  const read = readDesk(
    (db) =>
      db
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
    []
  );
  return (read.state === "ok" ? read.value : []).flatMap((e): DeletionCopy[] =>
    holds([e.words, e.answer], JSON.parse(e.refs) as string[])
      ? [{ id: threadEntryRefOf(e.id), kind: "thread entry" }]
      : []
  );
};
