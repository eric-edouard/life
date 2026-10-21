import { type Action, stands } from "./schema";

// His reminders as the ledger holds them (Stage 4b, 21 Oct): what Life wrote (`act`, its intents too) and what it read
// back as his (`madeBy: "reminders"`, src/reminders/inbound.ts), walked in order, never stored.

/** What `inbound` compares. `lost`: neither in his lists nor in Recently Deleted. */
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
/** One value per meaning: undefined, null, false, "" and "none" all mean not set, kept as null (JSON keeps a null key). */
export const norm = (v: unknown) =>
  v === undefined || v === null || v === false || v === "" || v === "none"
    ? null
    : v;
export const pick = (o: Record<string, unknown>): Fields =>
  Object.fromEntries(FIELDS.flatMap((f) => (f in o ? [[f, norm(o[f])]] : [])));

export type Field = (typeof FIELDS)[number];

/** A reminder Life links: `key`, Life's id for it (the line that opened it); its id in Reminders now; what Life left on it; when it was last removed and when Life last wrote to it. */
export interface Linked {
  fields: Fields;
  id: number;
  key: string;
  link?: string;
  removedAt?: string;
  tried: Map<string, unknown[]>;
  wrote?: string;
}

/** One line's mark on a linked reminder: a try or a partial adds its values to `tried`; anything else settles them. */
function apply(it: Linked, a: Action) {
  const after = pick(a.after);
  const tried = !stands(a);
  const unsure = tried || Boolean(a.error?.startsWith("partial"));
  it.wrote = a.madeBy === "reminders" ? it.wrote : a.at;
  for (const [f, v] of Object.entries(after)) {
    if (unsure) {
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
    // A move can give a new id: the line's `before` has the old one.
    const from = typeof a.before?.id === "number" ? a.before.id : n;
    const opens =
      (a.kind === "add" || a.kind === "import") && a.result === "ok";
    const it: Linked | undefined =
      items.get(from) ??
      (opens ? { fields: {}, id: n, key: a.id, tried: new Map() } : undefined);
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
