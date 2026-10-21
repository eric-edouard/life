import { join } from "node:path";
import { log } from "../log";
import { redact } from "../redact";
import { type Person, type SourceEvent, Unit } from "../schema";
import { type Descriptor, kindOf, SOURCES, sourceOf } from "../sources";
import { type RepoMap, repoMap } from "../sources/git";
import {
  type LifelogConversation,
  readConversations,
  type Store,
  withStore,
} from "../sources/lifelog";
import { loadTruth, OWNER, ownerIn, TEST, type Truth } from "../truth";
import { LIFE_MAIL } from "./email";
import { describeFiles, showFiles } from "./files";
import { digest, readFiles, readRepoGuesses, readUnits, UNITS } from "./ledger";
import { dayStart, localDate, wall } from "./zones";

// L1 units (memory-pipeline §3.1): one lifelog chapter, one chat-day, mail thread-day, note-day or repo-day. Built by
// code, nothing judged yet. A unit's id is stable (same chapter or day -> same id); its hash changes when its content
// does, so a verdict is reused only while the content is unchanged.

/** How much of a unit's text the moments model reads (`head`). */
const TEXT_MAX = 1500;
const SHORT_CHARS = 12;
const OTP_MAX = 200;
const PAREN = /\(.*?\)/g;
const PERSON = "person:";
const MARKS = /\p{M}/gu;
const NON_ALNUM = /[^a-z0-9]+/g;
const OTP =
  /\b(otp|code|passcode|verification|vérification|รหัส)\b[^\n]*\d{4,8}|\d{4,8}[^\n]*\b(otp|code|รหัส)\b/i;
// A login-code mail says so in its subject; the code itself sits on a line of its own, below the first 200 characters.
const CODE_SUBJECT =
  /\b(?:verification|confirmation|security|login|sign-in|one-time) code\b|code de (?:vérification|confirmation|sécurité)|\bis your (?:\w+ )?code\b|\botp\b/i;
const CODE_MAIL_MAX = 1500;
// Mail from an address that is not a person: no-reply, notifications, alerts.
const AUTOMATED =
  /no[-_.]?reply|nepasrepondre|do[-_.]?not[-_.]?reply|notif(?:y|ication)|mailer-daemon|automated|alerts?|onboarding/i;
// What keeps such a mail away from the drop rule: money, a booking, a deadline, an account or a delivery to deal with,
// bad news, health or legal matters. The model judges those.
const MATTERS = new RegExp(
  [
    "[€$฿£]",
    String.raw`\b\d[\d.,]*\s?(?:eur|euros?|usd|thb|baht)\b`,
    String.raw`\b(?:invoices?|factures?|payments?|paiements?|paid|pay|virements?|transfers?|refunds?|billing|charged?|d[ée]bit\w*|pr[ée]l[èe]vement|subscriptions?|abonnements?|renew\w*|tax\w*|bank|banque|banc\w*|cr[ée]dit)\b`,
    String.raw`\b(?:legal|court|lawyer|avocat|doctor|medical|health|sant[ée]|clinic)\b`,
    String.raw`\b(?:fail\w*|declin\w*|overdue|unpaid|suspend\w*|expir\w*|paused|restricted|delist\w*|discontinu\w*|urgent|action (?:needed|required)|requise|security|unrecogni[sz]ed|breach|alert|incident|down)\b`,
    String.raw`\b(?:booking|reservation|r[ée]servation|confirmed|confirmation|flight|vol|train|d[ée]part|hotel|trip|ticket|billet|boarding|order|commande|shipment|colis|delivery|livr\w*)\b`,
    String.raw`\b(?:domain|dns|verify|validate|log in|login|password|deadline|lead|modif\w*|chang\w*)\b`,
    String.raw`\b(?:by|before|until|due|avant le|jusqu'au|d'ici)\b[^.\n]{0,25}\b(?:\d{1,2}|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|janv|f[ée]vr|avr|juin|juil|ao[uû]t|sept|d[ée]c)`,
  ].join("|"),
  "i"
);

export interface Message {
  at: string;
  bulk?: boolean;
  fromMe: boolean;
  id: string;
  sender: string;
  text: string;
}

/** Who a name, handle or address is (`resolver`, who.ts: the one resolver), or null. */
export type Resolve = (surface: string) => string | null;

export interface Built {
  messages: Message[];
  /** The whole text (the model reads its `head`). Never stored in memory/: it may hold message text. */
  text: string;
  unit: Unit;
}

export const unitId = (...parts: string[]) =>
  `u_${digest("sha1", parts.join("|"), 12)}`;
/** The id of the chat-day (thread-day, note-day, repo-day) an event is in. */
export const dayUnitId = (e: SourceEvent) =>
  unitId(e.source, e.chat, localDate(e.at));
const contentHash = (s: string) => digest("sha256", s, 16);

const DAY = /^\d{4}-\d{2}-\d{2}$/;
/**
 * `from`..`to` as ISO instants. A date is a local day: `from` starts it, `to` is inclusive (it ends after that day).
 * Either may be missing.
 */
export function dayRange(from?: string, to?: string) {
  const edge = (d: string | undefined, plus: number) => {
    if (!d) {
      return;
    }
    return DAY.test(d)
      ? dayStart(daysBefore(d, -plus)).toISOString()
      : new Date(d).toISOString();
  };
  return { from: edge(from, 0), to: edge(to, 1) };
}

/** Lower case, no accents, letters and digits only: how names, quotes and titles are compared. */
export const normalize = (s: string) =>
  s
    .normalize("NFD")
    .replace(MARKS, "")
    .toLowerCase()
    .replace(NON_ALNUM, " ")
    .trim();

const SUMMARY_MAX = 300;

/** `s` cut at a word within `max` characters, with an ellipsis. */
export const clip = (s: string, max = SUMMARY_MAX) =>
  s.length <= max
    ? s
    : `${s.slice(0, s.lastIndexOf(" ", max - 1) > 0 ? s.lastIndexOf(" ", max - 1) : max - 1)}…`;

/** The first items of `list` whose sizes add up to `budget` at most. */
export function within<T>(list: T[], budget: number, size: (x: T) => number) {
  let used = 0;
  return list.filter((x) => {
    used += size(x);
    return used <= budget;
  });
}

/**
 * A page of a list ordered newest first, by whole keys (a day, an instant): the newest items before `before` up to
 * `limit`, then the rest of the last key taken, so a key is never cut between two pages. `next`: the key to page back
 * from, when something older is left.
 */
export function newestDays<T>(
  items: T[],
  keyOf: (x: T) => string,
  limit: number,
  before?: string
) {
  const left = before ? items.filter((x) => keyOf(x) < before) : items;
  const edge = left[limit - 1];
  const taken = edge
    ? left.filter((x) => keyOf(x) >= keyOf(edge))
    : left.slice();
  const last = taken.at(-1);
  return {
    next: last && taken.length < left.length ? keyOf(last) : undefined,
    taken,
  };
}

const SPACES = / +/g;
/** A name as a slug, how page files are named: "Money & admin" -> "money-admin". */
export const slugOf = (name: string) => normalize(name).replace(SPACES, "-");

const TOPICS_MAX = 3;
const SINGULAR_KEEPS = /(?:ss|us|is|ics|news)$/;
const SINGULAR_ES = /(?:xes|ches|shes)$/;

/** "Constructions" -> "construction": a tag's last word singular where that is trivial. */
function singular(w: string) {
  if (w.length < 4 || SINGULAR_KEEPS.test(w)) {
    return w;
  }
  if (SINGULAR_ES.test(w)) {
    return w.slice(0, -2);
  }
  if (w.endsWith("ies")) {
    return `${w.slice(0, -3)}y`;
  }
  return w.endsWith("s") ? w.slice(0, -1) : w;
}

/** The model's topic tags as stored: at most three, lower case, dashed, singular, no repeats. */
export function normalizeTopics(raw: string[] | null | undefined) {
  const tags = (raw ?? []).flatMap((t) => {
    const words = normalize(t).split(" ").filter(Boolean);
    const last = words.pop();
    return last ? [[...words, singular(last)].join("-")] : [];
  });
  return [...new Set(tags)].slice(0, TOPICS_MAX);
}

/** Every area id and name, normalized, to its id: the model may answer with either. */
export const areaLookup = (areas: { id: string; name: string }[]) =>
  new Map(
    areas.flatMap((a) => [a.id, a.name].map((k) => [normalize(k), a.id]))
  );

/** The area id for what the model said (id or name, any case), or null when it names none. */
export const areaOf = (said: string | null, lookup: Map<string, string>) =>
  (said && lookup.get(normalize(said))) || null;

/** Where his agents mail him their reports from (the older routines still use Make a Dent's). */
const AGENT_REPORTS = [LIFE_MAIL.from, "alerts@send.make-a-dent.com"];

/** Names and aliases on the map, normalized, to the person; a name two people share maps to nobody. */
export function nameIndex(people: Person[]) {
  const index = new Map<string, string | null>();
  for (const p of people) {
    for (const n of [p.name, ...p.aliases]) {
      const k = normalize(n);
      index.set(k, index.has(k) && index.get(k) !== p.id ? null : p.id);
    }
  }
  return index;
}

/** `person:<slug>` for a name lifelog gives ("Jean (Me)" -> person:me), else `unknown:<name>`. */
export function personRef(name: string, index: Map<string, string | null>) {
  const id = index.get(normalize(name.replace(PAREN, "")));
  return id ? `person:${id}` : `unknown:${name}`;
}

/** A unit's text as the moments model reads it: its start and its end, `TEXT_MAX` at most. */
export const head = (text: string) =>
  text.length <= TEXT_MAX
    ? text
    : `${text.slice(0, TEXT_MAX / 2)}\n…\n${text.slice(-TEXT_MAX / 2)}`;

export function lifelogUnits(
  conversations: LifelogConversation[],
  names: Map<string, string | null>
): Built[] {
  return conversations.flatMap((c): Built[] => {
    if (c.chapters.length === 0) {
      // Not summarized (yet): kept in units/ so the gap is counted, dropped by rule `no-summary`.
      return [
        {
          messages: [],
          text: "",
          unit: {
            date: localDate(c.startedAt),
            end: c.endedAt,
            hash: contentHash(`${c.id}|${c.state}`),
            id: unitId("lifelog", c.id, "none"),
            key: c.id,
            people: [],
            refs: [c.id],
            schemaVersion: 1,
            source: "lifelog",
            start: c.startedAt,
            stats: { chars: 0, fromMe: 0, items: 0 },
            title: c.title || "(not summarized yet)",
          },
        },
      ];
    }
    return c.chapters.map((ch) => {
      const text = `${c.title}\n${ch.title}\n${ch.summary}`;
      return {
        messages: [],
        text,
        unit: {
          date: localDate(ch.start),
          end: ch.end,
          hash: contentHash(text),
          id: unitId("lifelog", ch.id),
          key: c.id,
          people: [...new Set(ch.people.map((n) => personRef(n, names)))],
          refs: [`${c.id}#${ch.id}`, ...(ch.ref ? [ch.ref] : [])],
          schemaVersion: 1,
          source: "lifelog",
          start: ch.start,
          stats: { chars: ch.summary.length, fromMe: 0, items: ch.items },
          summary: ch.summary,
          title: ch.title,
        },
      };
    });
  });
}

/** A chat's title when only one other person writes in it that day (a 1:1 chat names its other member). */
export function oneToOne(b: Built) {
  const others = new Set(
    b.messages.filter((m) => !m.fromMe).map((m) => m.sender)
  );
  const chat = kindOf(b.unit.source) === "chat";
  return chat && others.size === 1 && b.unit.title !== b.unit.key
    ? b.unit.title
    : undefined;
}

/** The day `days` before `today` (both `YYYY-MM-DD`). */
export const daysBefore = (today: string, days: number) => {
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
};

/** A line's local day and time, `YYYY-MM-DD HH:MM`, as the moments and extract prompts show it. */
export const localTime = (iso: string) => `${localDate(iso)} ${time(iso)}`;

export const time = (iso: string) => wall(iso).hms.slice(0, 5);

/** Events cut into one list per unit: source, chat (or thread, note, repo) and local day. */
const byDay = (events: SourceEvent[]) => [
  ...Map.groupBy(events, dayUnitId).values(),
];

/** Chat-days, mail thread-days and note-days: every message of one chat, thread or note on one local day. */
export const messageUnits = (events: SourceEvent[], resolve: Resolve) =>
  byDay(events).map((list) => chatDay(list, resolve));

/**
 * The unit of one chat's (or thread's) messages. A chat keeps a sender nobody resolves as `unknown:<sender>`, so a
 * reader maps them once they are known (`refOf`); a mail's or a note's are organisations and lists, left out.
 */
function chatDay(list: SourceEvent[], resolve: Resolve): Built {
  const sorted = list.sort((a, b) => a.at.localeCompare(b.at));
  const first = sorted[0] as SourceEvent;
  const last = sorted.at(-1) as SourceEvent;
  const chat = kindOf(first.source) === "chat";
  const who = sorted.map((e) =>
    e.fromMe
      ? OWNER
      : (resolve(e.sender) ?? (chat ? `unknown:${e.sender}` : null))
  );
  const lines = sorted.map(
    (e, i) =>
      `${time(e.at)} ${who[i]?.startsWith(PERSON) ? who[i].slice(PERSON.length) : e.sender}: ${redact(e.text)}`
  );
  const title =
    first.chatName ??
    (kindOf(first.source) === "mail" ? "(no subject)" : first.chat);
  const ids = sorted.map((e) => e.id);
  return {
    messages: sorted.map((e) => ({
      at: e.at,
      bulk: e.bulk,
      fromMe: e.fromMe,
      id: e.id,
      sender: e.sender,
      text: e.text,
    })),
    text: `${title}\n${lines.join("\n")}`,
    unit: {
      date: localDate(first.at),
      end: last.at,
      // Content only, not ids or times: the same chat seen through two sources hashes the same.
      hash: contentHash(
        sorted.map((e) => `${e.fromMe ? 1 : 0}|${e.text}`).join("\n")
      ),
      id: dayUnitId(first),
      key: first.chat,
      people: [...new Set(who.flatMap((p) => (p ? [p] : [])))].sort(),
      refs:
        kindOf(first.source) === "mail"
          ? ids
          : [...new Set([ids[0], ids.at(-1)])].filter(
              (id): id is string => !!id
            ),
      schemaVersion: 1,
      source: first.source,
      start: first.at,
      stats: {
        chars: sorted.reduce((n, e) => n + e.text.length, 0),
        fromMe: sorted.filter((e) => e.fromMe).length,
        items: sorted.length,
      },
      title,
    },
  };
}

/** "1 commit", "2 commits". */
export const count = (n: number, noun: string) =>
  `${n} ${noun}${n === 1 ? "" : "s"}`;

/** "+4,673 −199": the lines of some repo-days. */
export function lineCounts(stats: Unit["stats"][]) {
  const n = (k: "added" | "removed") =>
    stats.reduce((t, s) => t + (s[k] ?? 0), 0).toLocaleString("en");
  return `+${n("added")} −${n("removed")}`;
}

/**
 * Repo-days: one unit per repo and local day, made like a chat-day. The summary is the day's commit subjects, which
 * makes them searchable; the title counts commits and lines.
 */
export const repoUnits = (events: SourceEvent[]) => byDay(events).map(repoDay);

/** The unit of one repo's commits. */
function repoDay(list: SourceEvent[]): Built {
  const byId = new Map(list.map((e) => [e.id, e]));
  const { messages, text, unit } = chatDay(list, () => null);
  const sum = (k: "added" | "removed") =>
    messages.reduce((n, m) => n + (byId.get(m.id)?.[k] ?? 0), 0);
  const others: Record<string, number> = {};
  for (const m of messages.filter((x) => !x.fromMe)) {
    others[m.sender] = (others[m.sender] ?? 0) + 1;
  }
  const by = unit.stats.items - unit.stats.fromMe;
  const stats = {
    ...unit.stats,
    added: sum("added"),
    ...(by > 0 ? { others } : {}),
    removed: sum("removed"),
  };
  return {
    messages,
    text,
    unit: {
      ...unit,
      stats,
      summary: clip(messages.map((m) => redact(m.text)).join("; ")),
      title: `${unit.key}: ${count(unit.stats.items, "commit")}${by > 0 ? ` (${by} by others)` : ""}, ${lineCounts([stats])}`,
    },
  };
}

/**
 * The chat with Life's retired Telegram bot (its Beeper chat id in `.env`): its briefs
 * and answers were Life's output, so neither memory nor the raw chat reads open it.
 */
export const LIFE_CHAT = TEST
  ? "!life:beeper.local"
  : (process.env.LIFE_CHAT ?? "");

/** Mail the owner never wrote in, other than his agents' reports (the model judges those: he asked for their to-dos). */
const isMail = (b: Built) =>
  kindOf(b.unit.source) === "mail" &&
  b.unit.stats.fromMe === 0 &&
  !b.messages.some((m) => AGENT_REPORTS.includes(m.sender));
/** Life's nightly report and alerts: reading them back would turn its own output into facts. */
const lifeMail = (b: Built) =>
  kindOf(b.unit.source) === "mail" &&
  b.unit.title.startsWith(LIFE_MAIL.subject) &&
  b.messages.every((m) => m.sender === LIFE_MAIL.from);

/** Cheap code rules for obvious noise (§3.3), in order. The first rule that matches drops the unit. */
const RULES: [string, (b: Built, seen: Set<string>) => boolean][] = [
  ["no-summary", (b) => kindOf(b.unit.source) === "voice" && !b.unit.summary],
  // Life's own chat (see LIFE_CHAT) and mail.
  ["life-output", (b) => b.unit.key === LIFE_CHAT || lifeMail(b)],
  // The same content already seen. ponytail: a note-day whose change repeats one inside the window (a tick undone and
  // redone) keeps only the first; exempt notes from this rule if such repeats matter.
  ["duplicate", (b, seen) => seen.has(b.unit.hash)],
  [
    "too-short",
    (b) =>
      kindOf(b.unit.source) !== "voice" && b.unit.stats.chars < SHORT_CHARS,
  ],
  // Only short messages (a long mail with a promo code in it is not a login code), or a mail whose subject says it is one.
  [
    "one-time-code",
    (b) =>
      b.messages.length > 0 &&
      b.messages.every(
        (m) =>
          (m.text.length <= OTP_MAX && OTP.test(m.text)) ||
          (kindOf(b.unit.source) === "mail" &&
            CODE_SUBJECT.test(b.unit.title) &&
            m.text.length <= CODE_MAIL_MAX)
      ),
  ],
  // A newsletter or marketing send (Mail saw a list id or an unsubscribe link) the owner never answered.
  ["newsletter", (b) => isMail(b) && b.messages.every((m) => m.bulk)],
  // Vendor and notification mail from a no-reply or alerts address the owner never answered, with nothing in it that matters.
  [
    "automated",
    (b) =>
      isMail(b) &&
      !MATTERS.test(b.text) &&
      b.messages.every((m) => AUTOMATED.test(m.sender.split("@")[0] ?? "")),
  ],
];

/** Marks each unit a rule drops (`unit.drop` names the rule). */
export function applyRules(built: Built[]) {
  const seen = new Set<string>();
  for (const b of built) {
    const rule = RULES.find(([, test]) => test(b, seen))?.[0];
    seen.add(b.unit.hash);
    if (rule) {
      b.unit.drop = rule;
    }
  }
  return built;
}

/**
 * Reads one source. A broken one is logged and named in `failed`, and gives no rows: the caller must not
 * mistake that for a quiet day (a unit file rebuilt without that source's units would lose them).
 */
export async function safely<T>(
  source: string,
  read: () => T[] | Promise<T[]>,
  failed: string[]
): Promise<T[]> {
  const started = performance.now();
  const ms = () => Math.round(performance.now() - started);
  try {
    // ponytail: no timeout, every reader is synchronous (a timer could not fire); a hung source holds the run.
    const rows = await read();
    log("source.read", { count: rows.length, ms: ms(), ok: true, source });
    return rows;
  } catch (e) {
    log("source.read", {
      error: (e as Error).message,
      ms: ms(),
      ok: false,
      source,
    });
    failed.push(source);
    return [];
  }
}

/** A source whose events show their files as lines, as the ledger has them now. */
const withFiles =
  (read: (since: Date) => SourceEvent[]) =>
  (since: Date): SourceEvent[] =>
    showFiles(read(since), readFiles());

/**
 * The tables of sources the steps outside `gather` read, derived from a registry (`SOURCES`; another in a test): each
 * a source's name to its reader (its events showing their files), in cut order.
 */
export function tablesOf(sources: Descriptor[]) {
  const messages = sources.flatMap((s) =>
    s.kind === "repo" || s.kind === "voice" ? [] : [s]
  );
  const readers = (
    keep: (s: (typeof messages)[number]) => boolean,
    show = withFiles
  ) =>
    Object.fromEntries(
      messages.filter(keep).map((s) => [s.name, show(s.read)])
    );
  return {
    /** The chat apps, where people speak for themselves (not mail, nor his notes). */
    CHATS: readers((s) => s.kind === "chat"),
    /** What `search` reads messages from: the sources it has a window for. */
    SEARCHED: readers((s) => s.searchDays !== undefined),
    /**
     * Where he writes with people, as the sources give it (no file lines): the chat apps and mail. The closeness counts
     * read it over years (closeness.ts), the one memory step reading sources outside `gather`: it counts days, never units.
     */
    WITH_PEOPLE: readers(
      (s) => s.kind === "chat" || s.kind === "mail",
      (read) => read
    ),
  };
}
export const { CHATS, SEARCHED, WITH_PEOPLE } = tablesOf(SOURCES);

/**
 * The chat-day, mail thread-day, note-day or repo-day behind a unit, read from its source again: its chat's messages from its
 * `start` to its `end`, whatever zone it was cut in. Nothing for a voice unit, or when they are all gone.
 */
export function builtFor(
  unit: Unit,
  resolve: Resolve,
  repos: RepoMap,
  me: Person
) {
  const source = sourceOf(unit.source);
  if (source.kind === "voice") {
    return;
  }
  const since = new Date(unit.start);
  const read = (
    source.kind === "repo"
      ? source.read(since, { me, repos })
      : source.read(since)
  ).filter((e) => e.chat === unit.key && e.at <= unit.end);
  // A repo's commits carry no files.
  const events = source.kind === "repo" ? read : showFiles(read, readFiles());
  if (events.length > 0) {
    return source.kind === "repo" ? repoDay(events) : chatDay(events, resolve);
  }
}

/** Lifelog person id -> the name on the map, for the people `truth/people.yaml` holds a `lifelog` handle for. */
export const lifelogNames = (truth: Truth) =>
  new Map(
    truth.people.flatMap((p) =>
      p.handles.lifelog ? [[p.handles.lifelog, p.name]] : []
    )
  );

/**
 * The default look-back of every step: yesterday, plus what a sleeping Mac or a late summary left behind, and the
 * lifelog units lifelog re-summarizes a few days later (their new hash needs a new verdict). Files are described
 * (`describeFiles`) only on messages of these days: an older one stays a tag.
 */
export const DAYS = 7;

/** Local days, both included: what a sweep reads. */
export interface Window {
  from: string;
  to: string;
}

/** The last `days` local days, today included. */
export function lastDays(now: Date, days: number): Window {
  const to = localDate(now.toISOString());
  return { from: daysBefore(to, days - 1), to };
}

/**
 * The evidence of a window of local days: every source (lifelog,
 * chats, mail, notes, his commits), cut into units with the code rules applied, senders resolved by `resolve`, in time order across channels; also
 * what the later stages need around them. The one reader of the sources for the memory steps: a sweep gathers once
 * and hands it to each step, which reads the days of its units. The recent messages' new files are read first
 * (`describeFiles`), so a unit's hash moves once when its file is described; an older window (a backfill) keeps its
 * files as tags. A repo's units are never extracted nor read for people (extract skips them; the moments step caps
 * their salience at 1).
 */
export async function gather(
  window: Window,
  { resolve, truth }: { resolve: Resolve; truth: Truth }
) {
  // ponytail: the readers read from `since` to now and the window is cut after, so a backfill week of 2025 reads every
  // source up to today; give the readers an end if the pilot measures that slow next to the model calls.
  const since = dayStart(window.from);
  if (!LIFE_CHAT) {
    // Unset, Life's own chat would read as facts.
    throw new Error("LIFE_CHAT is not set in .env");
  }
  const failed: string[] = [];
  const repos = repoMap(truth, await readRepoGuesses());
  const ctx = { me: ownerIn(truth.people), repos };
  // Lifelog's units come from the watcher's store, cut first as the registry lists it; every other source's from its
  // events, in the registry's order.
  const lifelog = await safely(
    "lifelog",
    () =>
      withStore((store) =>
        readConversations(store, since, lifelogNames(truth))
      ),
    failed
  );
  const read = await Promise.all(
    SOURCES.flatMap((s) => (s.kind === "voice" ? [] : [s])).map(async (s) => ({
      events: await safely(
        s.name,
        () => (s.kind === "repo" ? s.read(since, ctx) : s.read(since)),
        failed
      ),
      s,
    }))
  );
  // A repo's commits carry no files; the others' recent messages have theirs described, then shown.
  const recent = dayStart(lastDays(new Date(), DAYS).from).toISOString();
  const files = await describeFiles(
    read
      .flatMap(({ events, s }) => (s.kind === "repo" ? [] : events))
      .filter((e) => e.at >= recent)
  );
  const known = readFiles();
  const shown = read.map(({ events, s }) => ({
    events: s.kind === "repo" ? events : showFiles(events, known),
    s,
  }));
  const built = applyRules([
    ...lifelogUnits(lifelog, nameIndex(truth.people)),
    ...shown.flatMap(({ events, s }) =>
      s.kind === "repo" ? repoUnits(events) : messageUnits(events, resolve)
    ),
  ])
    .filter((b) => b.unit.date >= window.from && b.unit.date <= window.to)
    .toSorted((a, b) => a.unit.start.localeCompare(b.unit.start));
  return {
    built,
    conversations: lifelog,
    failed,
    files,
    read: {
      lifelog: lifelog.length,
      ...Object.fromEntries(
        shown.map(({ events, s }) => [s.name, events.length])
      ),
    },
    repos,
    truth,
    window,
  };
}
export type Evidence = Awaited<ReturnType<typeof gather>>;

/** Writes memory/units/<date>.jsonl for each of `dates`: that day's units, sorted by start. */
export async function writeUnits(dates: string[], units: Unit[]) {
  await Promise.all(
    dates.map(async (date) => {
      const lines = units
        .filter((u) => u.date === date)
        .sort(
          (a, b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id)
        )
        .map((u) => JSON.stringify(Unit.parse(u)));
      await Bun.write(join(UNITS, `${date}.jsonl`), `${lines.join("\n")}\n`);
    })
  );
}

/**
 * Makes the lifelog units in memory/units/ the ones the store gives (what the watcher does after a page). A day's file
 * is rewritten only when its lifelog units differ; other sources' units in it stay. Returns how many units were built,
 * changed and removed.
 * ponytail: `gather` (moments) applies the `duplicate` rule to the window's units of every source, this to all lifelog
 * units, so a lifelog unit repeating one from before the window may flip between the two writers; one writer settles it.
 */
export async function syncLifelogUnits(store: Store) {
  const truth = await loadTruth();
  const want = applyRules(
    lifelogUnits(
      readConversations(store, new Date(0), lifelogNames(truth)),
      nameIndex(truth.people)
    )
  ).map((b) => Unit.parse(b.unit));
  const all = await readUnits();
  const have = all.filter((u) => u.source === "lifelog");
  const json = (units: Unit[]) =>
    new Map(units.map((u) => [u.id, JSON.stringify(u)]));
  const [had, wants] = [json(have), json(want)];
  const added = want.filter((u) => !had.has(u.id));
  const changed = want.filter(
    (u) => had.has(u.id) && had.get(u.id) !== wants.get(u.id)
  );
  const removed = have.filter((u) => !wants.has(u.id));
  // A unit that changed its day leaves the old day's file too.
  const dates = new Set(
    [...want, ...have]
      .filter((u) => had.get(u.id) !== wants.get(u.id))
      .map((u) => u.date)
  );
  await writeUnits(
    [...dates],
    [...all.filter((u) => u.source !== "lifelog" && dates.has(u.date)), ...want]
  );
  return {
    added: added.length,
    changed: changed.length,
    checked: want.length,
    removed: removed.length,
  };
}
