import { openOf, type Snapshot } from "../actions/backend";
import type { Item } from "../actions/contract";
import {
  FIELDS,
  type Field,
  type Fields,
  type Linked,
  linked,
  norm,
  pick,
} from "../actions/items";
import { digest } from "../memory/ledger";
import { normalize } from "../memory/units";
import { type Action, stands } from "../records/ledger";

// His changes in the actions backend (Reminders, Google Tasks) come back as state, never authority (decision 15, 21 Oct): each linked reminder is compared
// with what the ledger says Life left there, and a field Life tried to write and could not confirm is learned, never his (#69).
// They may close, reopen, reschedule, re-rank, rename, drop or add an item, never ask, send or grant. Section, order and
// a repeating reminder's due are Apple's own, never compared; a shared list is never read.

/** A live reminder's fields, as a change writes them (`pick` keeps the compared ones). */
const fieldsNow = (r: Item) =>
  pick({ ...r, deleted: false, due: openOf(r).due, lost: false });
const linkOf = (r: Item) => r.deepLink?.split("/").at(-1);

/** One line of his, read from Reminders: never his words (no `instruction`), so nothing can take it for a request. */
const his = (
  prefix: string,
  kind: Action["kind"],
  id: string,
  at: string,
  after: Fields & { created?: string; link?: string },
  before?: Record<string, unknown>
): Action => ({
  after,
  at,
  before,
  id: `act_${digest("sha1", `reminders:${id}|${kind}|${at}`, 12)}`,
  kind,
  madeBy: "reminders",
  result: "ok",
  schemaVersion: 1,
  target: `${prefix}:${id}`,
  why: kind === "import" ? "linked, no change" : "his change in Reminders",
});

/** A linked item's id in its backend. */
const itemId = (it: Linked) => it.target.slice(it.target.indexOf(":") + 1);

const of = (o: Fields, fs: readonly Field[]) =>
  Object.fromEntries(fs.map((f) => [f, o[f]]));

/** The kinds of a line of his, by the field that names it (else an edit): set, cleared. */
const NAMED = [
  ["deleted", "remove", "restore"],
  ["completed", "done", "undone"],
] as const;

/** How long after Life's write to a reminder it is left alone: reads lag writes about 2 s, and a pass reads for seconds. */
const LAG_MS = 30_000;

/**
 * A linked reminder's lines this pass. An `import` (no change of his) records what Life does not know yet: every field
 * on the first pass (a baseline), a field it never wrote, a new id (a move whose answer was lost). Then his changes.
 */
function linesOf(
  prefix: string,
  it: Linked,
  r: Item | undefined,
  gone: boolean,
  first: boolean,
  at: string
) {
  const now = r ? fieldsNow(r) : pick({ deleted: gone, lost: !gone });
  // A field Life tried and could not confirm is learned as it is now (an import), never his change.
  const known = (f: Field) =>
    !(first || it.tried.has(f)) &&
    (f in it.fields || f === "deleted" || f === "lost");
  const changed = FIELDS.filter(
    (f) =>
      f in now &&
      known(f) &&
      now[f] !== norm(it.fields[f]) &&
      !(f === "due" && r?.recurrence)
  );
  const unknown = FIELDS.filter((f) => f in now && !known(f));
  const id = r?.id ?? itemId(it);
  const rekey = id === itemId(it) ? undefined : { id: itemId(it) };
  // One line of his per pass, named by what matters most in it: a removal or restore, a tick, else an edit.
  const named = NAMED.find(([f]) => changed.includes(f));
  const kind = named ? named[now[named[0]] ? 1 : 2] : "edit";
  return [
    // First, so a line after it finds the reminder by its new id.
    ...(unknown.length > 0 || rekey
      ? [
          his(
            prefix,
            "import",
            id,
            at,
            { ...of(now, unknown), link: r && linkOf(r) },
            rekey
          ),
        ]
      : []),
    ...(changed.length > 0
      ? [his(prefix, kind, id, at, of(now, changed), of(it.fields, changed))]
      : []),
  ];
}

/** The lines this pass adds: his changes and his new reminders (`add`), and imports, which change nothing. */
export function inbound(s: Snapshot, ledger: Action[], at: string) {
  // Only this backend's lines: another backend's items (before a switch) are never read here, never marked lost.
  const actions = ledger.filter((a) => a.target.startsWith(`${s.prefix}:`));
  const first = !actions.some((a) => a.kind === "import");
  const byId = new Map(s.live.map((r) => [r.id, r]));
  const byLink = new Map(s.live.map((r) => [linkOf(r), r]));
  const lines: Action[] = [];
  for (const it of linked(actions).values()) {
    const r =
      byId.get(itemId(it)) ?? (it.link ? byLink.get(it.link) : undefined);
    if (r) {
      byId.delete(r.id);
    }
    const gone = s.deleted.some(
      (d) =>
        d.id === itemId(it) || (it.link !== undefined && linkOf(d) === it.link)
    );
    // Left alone: one Life wrote to moments ago (reads lag writes, and a write may land during the read), one on a
    // shared list (never read), one removed and then purged.
    const alone =
      Date.parse(at) - Date.parse(it.wrote ?? "") < LAG_MS ||
      s.shared.includes(`${it.fields.list}`) ||
      !(r || gone || !it.fields.deleted);
    lines.push(...(alone ? [] : linesOf(s.prefix, it, r, gone, first, at)));
  }
  // Left, linked to nothing: his new reminder, or Life's add whose answer was lost (or is still coming: it waits).
  const lost = lostAdds(actions);
  for (const r of byId.values()) {
    const tried = lost.get(normalize(r.title));
    if (
      !(r.completed || (tried && Date.parse(at) - Date.parse(tried) < LAG_MS))
    ) {
      const after = {
        ...fieldsNow(r),
        created: r.createdDate,
        link: linkOf(r),
      };
      lines.push(
        his(s.prefix, first || tried ? "import" : "add", r.id, at, after)
      );
    }
  }
  return lines;
}

/** The titles of Life's adds with no answer yet (an intent or a failure, no ok), each with when it was tried: such a reminder is Life's. */
function lostAdds(actions: Action[]) {
  const ok = new Set(actions.filter(stands).map((a) => a.id));
  const title = (a: Action) => normalize(`${a.after.title}`);
  // Once imported, the title is free again: a later reminder of his by that name is his.
  const imported = new Set(
    actions.filter((a) => a.kind === "import").map(title)
  );
  const lost = actions.filter(
    (a) => a.kind === "add" && !(ok.has(a.id) || imported.has(title(a)))
  );
  return new Map(lost.map((a) => [title(a), a.at]));
}
