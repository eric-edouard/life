import { type LedgerEntry, stands } from "../records/ledger-entry";

// His items (reminders, Google tasks) as the ledger holds them: what Life wrote (`act`, its intents too) and what it read
// back as his (`via: "reminders"`, apps/server/src/host/inbound.ts), walked in order. An item's target is `<prefix>:<id>`.

/** What `inbound` compares with the backend. `lost`: neither in his lists nor in Recently Deleted. */
export const COMPARED = [
  "completed",
  "deleted",
  "due",
  "flagged",
  "list",
  "lost",
  "notes",
  "priority",
  "title",
  "urgent",
] as const;
/**
 * What the fold keeps of an item (life#242: Life's record is the one source): the compared fields, and what only Life
 * writes, never compared (Life owns recurrence; Apple re-sorts sections; subtasks are write-only): step 2's reflector
 * writes them all from here.
 */
export const KEPT = [...COMPARED, "recurrence", "section", "subtasks"] as const;
export type Fields = Partial<Record<(typeof KEPT)[number], unknown>>;
/** One value per meaning: undefined, null, false, "" and "none" all mean not set, kept as null (JSON keeps a null key). */
export const norm = (v: unknown) =>
  v === undefined || v === null || v === false || v === "" || v === "none"
    ? null
    : v;
/** These of a line's fields, normalised ("clear" on a recurrence stops it: none). */
const pickFrom = (
  fields: readonly (typeof KEPT)[number][],
  o: Record<string, unknown>
): Fields =>
  Object.fromEntries(
    fields.flatMap((f) =>
      f in o
        ? [[f, f === "recurrence" && o[f] === "clear" ? null : norm(o[f])]]
        : []
    )
  );
/** A backend item's fields as `inbound` compares them. */
export const pickCompared = (o: Record<string, unknown>) =>
  pickFrom(COMPARED, o);

export type Field = (typeof COMPARED)[number];

/** An item Life links: `key`, Life's id for it (the line that opened it); its target now (`<prefix>:<id>`, one backend's); what Life left on it; when it was last removed and when Life last wrote to it. */
export interface Linked {
  /** When it was made, and the observation or words it came from (open items' age and merge). */
  at: string;
  fields: Fields;
  key: string;
  link?: string;
  ref?: string;
  removedAt?: string;
  target: string;
  tried: Set<string>;
  wrote?: string;
}

/** One line's mark on a linked reminder: a try or a partial leaves its fields unsettled (`tried`: the next pass imports what Reminders shows); anything else settles them. */
function apply(it: Linked, a: LedgerEntry) {
  const after = pickFrom(KEPT, a.after);
  const tried = !stands(a);
  const unsure = tried || Boolean(a.error?.startsWith("partial"));
  it.wrote = a.via === "reminders" ? it.wrote : a.at;
  for (const [f, v] of Object.entries(after)) {
    if (unsure) {
      it.tried.add(f);
    } else {
      // remctl adds steps (`--subtask`), never replaces them: the fold keeps every step written.
      it.fields[f as keyof Fields] =
        f === "subtasks" && Array.isArray(v)
          ? [...((it.fields.subtasks as unknown[] | undefined) ?? []), ...v]
          : v;
      it.tried.delete(f);
    }
  }
  if (!tried) {
    it.link = (a.after.link as string | undefined) ?? it.link;
    it.removedAt = after.deleted ? a.at : it.removedAt;
  }
  return tried;
}

/** Every item Life links, by its target now: what the ledger says Life left on it, and the fields it tried to write that are not settled. */
export function linked(actions: readonly LedgerEntry[]) {
  const items = new Map<string, Linked>();
  for (const a of actions) {
    const n = a.target;
    // A move can give a new id: the line's `before` has the old one (in the same backend).
    const from =
      a.before?.id === undefined
        ? n
        : `${n.slice(0, n.indexOf(":"))}:${a.before.id}`;
    const opens =
      (a.kind === "add" || a.kind === "import") && a.result === "ok";
    const it: Linked | undefined =
      items.get(from) ??
      (opens
        ? {
            at: a.at,
            fields: {},
            key: a.id,
            ref: a.instruction?.ref,
            target: n,
            tried: new Set(),
          }
        : undefined);
    if (
      it &&
      a.target.includes(":") &&
      a.result !== "duplicate" &&
      !apply(it, a)
    ) {
      items.delete(from);
      items.set(n, it);
      it.target = n;
    }
  }
  return items;
}

/** His items still open, as the ledger holds them: not ticked, not removed, not lost; of one backend (`prefix`) or all. */
export const openLinked = (actions: readonly LedgerEntry[], prefix?: string) =>
  [...linked(actions).values()].filter(
    ({ fields: f, target }) =>
      !(f.completed || f.deleted || f.lost) &&
      (prefix === undefined || target.startsWith(`${prefix}:`))
  );
