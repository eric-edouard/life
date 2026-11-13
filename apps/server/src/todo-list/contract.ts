import { z } from "zod";
import { TODO_CHANGE_KINDS } from "../records/ledger-entry";

// The to-do list contract: what a backend is (`TodoListBackend`, with what it `can`) and what a change asks of it
// (`Change`). The backends implement it; `backend.ts` picks this install's one.

/** What a backend can do besides an item's title, notes, day and state (done, undone, removed). */
export type Can =
  | "alarms"
  | "links"
  | "listMoves"
  | "priority"
  | "recurrence"
  | "sections"
  | "sharing"
  | "subtasks"
  | "urgent";

/** One of his lists (never a group). */
export interface List {
  id: string;
  title: string;
}

/** An item as every backend gives it (remctl's `show`; a Google task, normalised). Ids are strings. */
export interface TodoItem {
  allDay?: boolean;
  completed: boolean;
  createdDate?: string;
  deepLink?: string;
  dueDate?: string;
  flagged?: boolean;
  id: string;
  list?: string | null;
  notes?: string;
  priority?: string;
  recurrence?: unknown;
  section?: string;
  title: string;
  urgent?: boolean;
}

/** What a write left: the item's id now (a move can change it), its link (finds it again after a move), a partial's words. */
export interface Written {
  deepLink?: string;
  error?: string;
  id: string;
}

export interface TodoListBackend {
  /** Adds an item (the default list without `list`); its `subtasks` too when it `can`. */
  add: (c: Partial<Change> & { title: string }) => Promise<Written>;
  can: ReadonlySet<Can>;
  /** His deleted items (Recently Deleted; Google's deleted tasks). */
  deleted: () => Promise<TodoItem[]>;
  done: (id: string) => Promise<unknown>;
  /** Writes these fields (a `list` moves it); `before`, the item as `info` read it. */
  edit: (
    id: string,
    f: Partial<Change>,
    before?: Record<string, unknown>
  ) => Promise<Written>;
  /** One item as it is now, for `before`; throws when there is none. */
  info: (id: string) => Promise<Record<string, unknown>>;
  /** A list's top-level items: open ones, or ticked ones too. */
  items: (list: List, completed: boolean) => Promise<TodoItem[]>;
  /** What he calls it. */
  label: string;
  lists: () => Promise<List[]>;
  /** The ledger's targets are `<prefix>:<id>`. */
  prefix: string;
  remove: (id: string) => Promise<unknown>;
  /** Back from the deleted ones into `list`; a backend without it cannot restore. */
  restore?: (id: string, list?: string) => Promise<unknown>;
  /** Each list's sections by its title. */
  sections: () => Promise<Record<string, string[]>>;
  /** Whether a list is shared, read now (fails closed). */
  shared: (list: string) => Promise<boolean>;
  undone: (id: string) => Promise<unknown>;
}

const Due = z.string().regex(/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2})?$/);

/** What to do, as the connector and the CLI both say it. */
export const Change = z.object({
  // With a time it alerts then; null clears it (edit only).
  due: Due.nullish(),
  kind: z.enum(TODO_CHANGE_KINDS),
  list: z.string().optional(),
  notes: z.string().max(2000).nullish(),
  priority: z.enum(["high", "medium", "low"]).optional(),
  prompt: z.string().max(1500).optional(),
  // remctl's syntax: "daily", "weekly mon,wed", "monthly 6", "monthly last-fri", "daily x2"; "clear" stops it; its JSON
  // form ends: {"frequency":"daily","interval":1,"end":"2026-10-23T23:59"}. Needs a due date.
  recurrence: z.string().max(200).optional(),
  section: z.string().optional(),
  // A step may have its own `due`: a check-in on a promised answer, say.
  subtasks: z
    .array(z.object({ due: Due.optional(), title: z.string().min(1).max(200) }))
    .max(10)
    .optional(),
  // An item's id: Google Tasks' are strings, Reminders' numbers (a number is how the connector first took them).
  target: z.union([z.string().min(1), z.int().positive()]).optional(),
  title: z.string().min(1).max(200),
  urgent: z.boolean().optional(),
});

export type Change = z.infer<typeof Change>;
