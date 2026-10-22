import { join } from "node:path";
import { unfrozen } from "../clock";
import { HOME } from "../platform";
import { exec } from "../proc";
import type { Change } from "./act";
import type { ActionsBackend, Item } from "./backend";

// The Reminders backend: his Apple Reminders through remctl (its signed host, `--json`). Only `backend.ts` uses it.
// Its check (`checks`) is one `lists` read, not `remctl doctor` (its Tailscale probe times out while Reminders are
// fine); a broken private helper (sections, subtasks) shows as a partial on an act, on the board only in the log.

/** remctl (github.com/viticci/remctl), where its installer puts it, for every install. */
const REMCTL = join(HOME, "bin", "remctl");
/**
 * The remctl release Life is tested against (its answers: remctl.json): what the app installs, and what it offers
 * to update to. Its own installer (signed, notarized) asks for the Mac's password once and grants its permissions.
 */
export const REMCTL_RELEASE = {
  sha256: "acff84893036ddf5e1d9a0c67bd227dcbeb4c413366623c21036a22c54029ee3",
  url: "https://github.com/viticci/remctl/releases/download/v2.3.1/RemCTL-arm64.dmg",
  version: "2.3.1",
};

/** The installed remctl's version, or null when there is none. */
export async function remctlVersion() {
  const r = await exec([REMCTL, "--version"]);
  return r.code === 0 ? r.stdout.trim() : null;
}

const parse = <T>(s: string) => {
  try {
    return JSON.parse(s) as T;
  } catch {
    return {} as T;
  }
};

/**
 * One remctl call (`args[0]` is the command), its JSON. A partial add (created, a private step failed) comes back too;
 * anything else that fails throws remctl's own words. Read-after-write lags about 2 s: never verify with a read at once.
 * Killed after a minute (exec's default), so a stuck Reminders host cannot hold the queue.
 */
export async function remctl<T = Record<string, unknown>>(args: string[]) {
  unfrozen("touch his Reminders");
  const [command, ...rest] = args;
  const r = await exec([REMCTL, command ?? "", "--json", ...rest], {
    env: { ...process.env, NO_COLOR: "1", REMCTL_SKIP_ONBOARD: "1" },
  });
  const out = parse<T & { status?: string }>(r.stdout);
  if (r.code === 0 || out.status === "partial") {
    return out;
  }
  throw new Error(`remctl ${command}: ${r.stderr.trim().slice(-300)}`);
}

export const partial = (r: Record<string, unknown>) =>
  r.status === "partial"
    ? `partial: ${r.message ?? r.error ?? "a private step failed"}`
    : undefined;

/** Whether a list is plainly nobody else's: the grant never adds to a shared one (that would be a send). Fails closed. */
export const unshared = (list: { sharees?: unknown[]; shared?: boolean }) =>
  list.shared === false && list.sharees?.length === 0;

/** A reminder as remctl gives it: its id is a number. */
export type Raw = Omit<Item, "id"> & { id: number };
export const itemOf = (r: Raw): Item => ({ ...r, id: String(r.id) });

/** How long a list's own sorter takes to place a new reminder (read-after-write lags about 2 s). */
const SORTER_MS = 3000;

/** A timed reminder alerts at its time, as one made in Reminders does: EventKit adds no alarm by itself. */
const alarmAt = (due?: string | null) => (due?.includes(":") ? due : undefined);
/** The alarm flag of a due; none when the reminder already has alarms (remctl moves one that was at the old time; his own stay). */
export const alarmArgs = (due?: string | null, hasAlarms = false) =>
  !hasAlarms && alarmAt(due) ? [`--alarm=${due}`] : [];

/**
 * The remctl flags of a change's fields: `pub` goes through EventKit, `priv` (section, urgent, subtasks, the claude.ai
 * link of a `prompt`) through the private helper, so it is empty unless needed. `--name=value` keeps a value that starts
 * with a dash from being read as a flag. The link only pre-fills a Claude chat, it runs nothing.
 */
export function reminderArgs(c: Partial<Change>) {
  const priv = [
    ...(c.section ? [`--section=${c.section}`] : []),
    ...(c.urgent ? ["--urgent"] : []),
    ...(c.prompt
      ? [`--url=https://claude.ai/new?q=${encodeURIComponent(c.prompt)}`]
      : []),
    ...(c.subtasks ?? []).map(
      (s) => `--subtask=${JSON.stringify({ ...s, alarm: alarmAt(s.due) })}`
    ),
  ];
  return {
    priv: priv.length > 0 ? ["--private", ...priv] : [],
    pub: [
      ...(c.notes === undefined ? [] : [`--notes=${c.notes ?? ""}`]),
      ...(c.due === undefined ? [] : [`--due=${c.due ?? "clear"}`]),
      ...(c.priority ? [`--priority=${c.priority}`] : []),
      ...(c.recurrence ? [`--recurrence=${c.recurrence}`] : []),
    ],
  };
}

const KEEP =
  "id title list section dueDate alarms notes priority urgent completed".split(
    " "
  );

const DIGITS = /^\d+$/;
/** A Reminders id as remctl takes it: digits only, so a string target never reaches its argv as a flag. */
const num = (id: string) => {
  if (!DIGITS.test(id)) {
    throw new Error(`${id} is not a Reminders id`);
  }
  return id;
};

export const reminders: ActionsBackend = {
  async add(c) {
    const { priv, pub } = reminderArgs(c);
    const r = await remctl([
      "add",
      ...(c.list ? [`--list=${c.list}`] : []),
      ...pub,
      ...alarmArgs(c.due),
      ...priv,
      "--",
      c.title,
    ]);
    if (typeof r.numericId !== "number") {
      throw new Error("remctl add: no reminder id in its answer");
    }
    const id = String(r.numericId);
    let error = partial(r);
    if (c.section) {
      // A list that auto-categorizes (remctl cannot turn that off) re-sorts a new reminder a moment after it exists,
      // over the section asked for: put it back once the sorter is done.
      await Bun.sleep(SORTER_MS);
      try {
        await remctl(["edit", id, "--private", `--section=${c.section}`]);
      } catch (e) {
        error ??= `partial: section: ${(e as Error).message}`;
      }
    }
    // `link`, the deepLink's UUID, finds it again after a move gives it a new id.
    return { error, id, link: String(r.id) };
  },
  can: new Set([
    "alarms",
    "links",
    "moves",
    "priority",
    "recurrence",
    "sections",
    "sharing",
    "subtasks",
    "urgent",
  ]),
  deleted: async () =>
    (await remctl<{ items: Raw[] }>(["deleted"])).items.map(itemOf),
  done: (id) => remctl(["done", num(id)]),
  async edit(id, f, before = {}) {
    let to = id;
    // A move can clone and delete, which gives the reminder a new id.
    if (f.list) {
      const moved = await remctl(["edit", num(id), `--list=${f.list}`]);
      to = String(moved.id ?? id);
    }
    const { priv, pub } = reminderArgs(f);
    const flags = [
      ...(f.title ? [`--title=${f.title}`] : []),
      ...pub,
      ...alarmArgs(f.due, Boolean(before.alarms)),
      ...priv,
    ];
    // Once a move gave it a new id, a failure is a partial: the record must keep the new id, or the moved reminder reads as his.
    const r =
      flags.length > 0
        ? await remctl(["edit", num(to), ...flags]).catch((e: Error) => {
            if (to === id) {
              throw e;
            }
            return { message: e.message, status: "partial" };
          })
        : {};
    return { error: partial(r), id: to };
  },
  async info(id) {
    const r = await remctl(["info", "--", num(id)]);
    return Object.fromEntries(KEEP.flatMap((k) => (k in r ? [[k, r[k]]] : [])));
  },
  items: async (l, completed) =>
    (
      await remctl<Raw[]>([
        "show",
        `--list-id=${l.id}`,
        ...(completed ? ["--completed"] : []),
      ])
    ).map(itemOf),
  label: "Reminders",
  lists: async () =>
    (await remctl<{ id: number; isGroup: boolean; title: string }[]>(["lists"]))
      .filter((l) => !l.isGroup)
      .map((l) => ({ id: String(l.id), title: l.title })),
  prefix: "reminder",
  remove: (id) => remctl(["delete", num(id), "--force"]),
  // Back in `list`, under its id and deepLink (checked 21 Oct).
  restore: (id, list) =>
    remctl(["restore", "--private", `--list=${list}`, "--", num(id)]),
  sections: () => remctl<Record<string, string[]>>(["sections"]),
  shared: async (name) =>
    !unshared(
      await remctl<{ sharees?: unknown[]; shared?: boolean }>([
        "list-info",
        "--",
        name,
      ])
    ),
  undone: (id) => remctl(["undone", num(id)]),
};
