import type { Action } from "./schema";

// Open items (Stage 4b, his request of 21 Oct): everything someone still has to do is Life's own state, derived on
// every read from the records that already hold each fact, never stored. Reminders is one interface to it
// (src/sync.ts): delete that file and this still holds.

// His reminders as the ledger holds them: what Life wrote (`act`, its intents too) and what it read back as his
// (`madeBy: "reminders"`, src/sync.ts), walked in order.

/** What `inbound` compares. `lost`: neither in his lists nor in Recently Deleted (purged, or moved to a shared list). */
export const FIELDS = [
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
export type Fields = Partial<Record<(typeof FIELDS)[number], unknown>>;
/** One value per meaning: null, false, "" and "none" all mean not set. */
export const norm = (v: unknown) =>
  v === null || v === false || v === "" || v === "none" ? undefined : v;
export const pick = (o: Record<string, unknown>): Fields =>
  Object.fromEntries(FIELDS.flatMap((f) => (f in o ? [[f, norm(o[f])]] : [])));

export type Field = (typeof FIELDS)[number];

/** A reminder Life links: the line that opened it (`key`: Life's id for it, `at`, the observation or words it came from), its id in Reminders now, what Life left on it. */
export interface Linked {
  at: string;
  fields: Fields;
  id: number;
  key: string;
  link?: string;
  ref?: string;
  /** When it was last removed (to Recently Deleted), by Life or by him. */
  removedAt?: string;
  tried: Map<string, unknown[]>;
}

/** One line's mark on a linked reminder: a try adds its values to `tried`; a write that went through, or his change seen, settles its fields. */
function apply(it: Linked, a: Action) {
  const after = pick(a.after);
  const tried = a.result === "intent" || a.result === "failed";
  for (const [f, v] of Object.entries(after)) {
    if (tried) {
      it.tried.set(f, [...(it.tried.get(f) ?? []), v]);
    } else {
      it.fields[f as Field] = v;
      it.tried.delete(f);
    }
  }
  if (!tried) {
    it.link = (a.after.link as string | undefined) ?? it.link;
    it.removedAt = after.deleted ? a.at : it.removedAt;
  }
  return tried;
}

/** Every reminder Life links, by its id now: what the ledger says Life left on it, and the values Life tried since each settled. */
export function linked(actions: Action[]) {
  const items = new Map<number, Linked>();
  for (const a of actions) {
    const n = Number(a.target.split(":")[1]);
    // A move can give a new id (`edit` in src/sync.ts): the line's `before` has the old one.
    const from = typeof a.before?.id === "number" ? a.before.id : n;
    const opens =
      (a.kind === "add" || a.kind === "import") && a.result === "ok";
    const it: Linked | undefined =
      items.get(from) ??
      (opens
        ? {
            at: a.at,
            fields: {},
            id: n,
            key: a.id,
            ref: a.instruction?.ref,
            tried: new Map(),
          }
        : undefined);
    if (
      it &&
      a.target.startsWith("reminder:") &&
      a.result !== "duplicate" &&
      !apply(it, a)
    ) {
      items.delete(from);
      items.set(n, it);
      it.id = n;
    }
  }
  return items;
}
