import { join } from "node:path";
import { log } from "../log";
import { redact } from "../redact";
import { type Person, type SourceEvent, Unit } from "../schema";
import { readBeeper } from "../sources/beeper";
import { type RepoMap, readGit, repoMap } from "../sources/git";
import { readImessage } from "../sources/imessage";
import {
  type LifelogConversation,
  readConversations,
  type Store,
  withStore,
} from "../sources/lifelog";
import { readMail } from "../sources/mail";
import { readNotes } from "../sources/notes";
import { readWhatsapp } from "../sources/whatsapp";
import {
  handleIndex,
  loadTruth,
  ownerIn,
  resolveSender,
  TEST,
  type Truth,
} from "../truth";
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
  /** `me`, the person id on the map, or null. */
  who: string | null;
}

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
  const chat = b.unit.source in CHATS;
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
export const messageUnits = (
  events: SourceEvent[],
  handles: Map<string, string>
) => byDay(events).map((list) => chatDay(list, handles));

/** The unit of one chat's (or thread's) messages. */
function chatDay(list: SourceEvent[], handles: Map<string, string>): Built {
  const sorted = list.sort((a, b) => a.at.localeCompare(b.at));
  const first = sorted[0] as SourceEvent;
  const last = sorted.at(-1) as SourceEvent;
  const who = sorted.map((e) => resolveSender(e, handles));
  const lines = sorted.map(
    (e, i) => `${time(e.at)} ${who[i] ?? e.sender}: ${redact(e.text)}`
  );
  const title =
    first.chatName ?? (first.source === "mail" ? "(no subject)" : first.chat);
  const ids = sorted.map((e) => e.id);
  return {
    messages: sorted.map((e, i) => ({
      at: e.at,
      bulk: e.bulk,
      fromMe: e.fromMe,
      id: e.id,
      sender: e.sender,
      text: e.text,
      who: who[i] ?? null,
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
      people: [
        ...new Set(who.flatMap((p) => (p ? [`person:${p}`] : []))),
      ].sort(),
      refs:
        first.source === "mail"
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
  const { messages, text, unit } = chatDay(list, new Map());
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
  b.unit.source === "mail" &&
  b.unit.stats.fromMe === 0 &&
  !b.messages.some((m) => AGENT_REPORTS.includes(m.sender));
/** Life's nightly report and alerts: reading them back would turn its own output into facts. */
const lifeMail = (b: Built) =>
  b.unit.source === "mail" &&
  b.unit.title.startsWith(LIFE_MAIL.subject) &&
  b.messages.every((m) => m.sender === LIFE_MAIL.from);

/** Cheap code rules for obvious noise (§3.3), in order. The first rule that matches drops the unit. */
const RULES: [string, (b: Built, seen: Set<string>) => boolean][] = [
  ["no-summary", (b) => b.unit.source === "lifelog" && !b.unit.summary],
  // Life's own chat (see LIFE_CHAT) and mail.
  ["life-output", (b) => b.unit.key === LIFE_CHAT || lifeMail(b)],
  // The same content already seen. ponytail: a note-day whose change repeats one inside the window (a tick undone and
  // redone) keeps only the first; exempt notes from this rule if such repeats matter.
  ["duplicate", (b, seen) => seen.has(b.unit.hash)],
  [
    "too-short",
    (b) => b.unit.source !== "lifelog" && b.unit.stats.chars < SHORT_CHARS,
  ],
  // Only short messages (a long mail with a promo code in it is not a login code), or a mail whose subject says it is one.
  [
    "one-time-code",
    (b) =>
      b.messages.length > 0 &&
      b.messages.every(
        (m) =>
          (m.text.length <= OTP_MAX && OTP.test(m.text)) ||
          (b.unit.source === "mail" &&
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

/** Local midnight `days - 1` days ago, so every date in the window is a whole day. */
export const windowStart = (now: Date, days: number) =>
  dayStart(daysBefore(localDate(now.toISOString()), days - 1));

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

/** The chats and mail as read: their events carry their files, not shown yet (`gather` describes them first). */
const READERS = {
  beeper: readBeeper,
  imessage: readImessage,
  mail: readMail,
  notes: readNotes,
  whatsapp: readWhatsapp,
};
/** A source whose events show their files as lines, as the ledger has them now. */
const withFiles =
  (read: (since: Date) => SourceEvent[]) =>
  (since: Date): SourceEvent[] =>
    showFiles(read(since), readFiles());

/** The order units are cut in: of two with the same content, the first stays and the second is dropped as a duplicate. */
const ORDER = ["imessage", "whatsapp", "beeper", "mail", "notes"] as const;
/** Every source but lifelog and git, its events showing their files. */
const SOURCES = Object.fromEntries(
  ORDER.map((name) => [name, withFiles(READERS[name])])
) as Record<(typeof ORDER)[number], (since: Date) => SourceEvent[]>;
/** The chat apps, where people speak for themselves (not mail, nor his notes): WhatsApp, Beeper, iMessage. */
export const CHATS = {
  beeper: SOURCES.beeper,
  imessage: SOURCES.imessage,
  whatsapp: SOURCES.whatsapp,
};
/** What `search` reads messages from: the chats, and his notes (not chats: `chats` is about people). */
export const SEARCHED = { ...CHATS, notes: SOURCES.notes };

/**
 * The chat-day, mail thread-day, note-day or repo-day behind a unit, read from its source again: its chat's messages from its
 * `start` to its `end`, whatever zone it was cut in. Nothing for a lifelog unit, or when they are all gone.
 */
export function builtFor(
  unit: Unit,
  handles: Map<string, string>,
  repos: RepoMap,
  me: Person
) {
  if (unit.source === "lifelog") {
    return;
  }
  const since = new Date(unit.start);
  const events = (
    unit.source === "git"
      ? readGit(since, repos, me)
      : SOURCES[unit.source](since)
  ).filter((e) => e.chat === unit.key && e.at <= unit.end);
  if (events.length > 0) {
    return unit.source === "git" ? repoDay(events) : chatDay(events, handles);
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
 * chats, mail, notes, his commits), cut into units with the code rules applied, in time order across channels; also
 * what the later stages need around them. The one reader of the sources for the memory steps: a sweep gathers once
 * and hands it to each step, which reads the days of its units. The recent messages' new files are read first
 * (`describeFiles`), so a unit's hash moves once when its file is described; an older window (a backfill) keeps its
 * files as tags. Git units are never extracted nor read for people (extract skips them; the moments step caps their
 * salience at 1).
 */
export async function gather(window: Window) {
  // ponytail: the readers read from `since` to now and the window is cut after, so a backfill week of 2025 reads every
  // source up to today; give the readers an end if the pilot measures that slow next to the model calls.
  const since = dayStart(window.from);
  if (!LIFE_CHAT) {
    // Unset, Life's own chat would read as facts.
    throw new Error("LIFE_CHAT is not set in .env");
  }
  const truth = await loadTruth();
  const failed: string[] = [];
  const repos = repoMap(truth, await readRepoGuesses());
  const [commits, lifelog, ...read] = await Promise.all([
    safely("git", () => readGit(since, repos, ownerIn(truth.people)), failed),
    safely(
      "lifelog",
      () =>
        withStore((store) =>
          readConversations(store, since, lifelogNames(truth))
        ),
      failed
    ),
    ...ORDER.map((name) => safely(name, () => READERS[name](since), failed)),
  ]);
  const recent = windowStart(new Date(), DAYS).toISOString();
  const files = await describeFiles(read.flat().filter((e) => e.at >= recent));
  const known = readFiles();
  const chats = read.map((events) => showFiles(events, known));
  const handles = handleIndex(truth.people);
  const built = applyRules([
    ...lifelogUnits(lifelog, nameIndex(truth.people)),
    ...chats.flatMap((events) => messageUnits(events, handles)),
    ...repoUnits(commits),
  ])
    .filter((b) => b.unit.date >= window.from && b.unit.date <= window.to)
    .toSorted((a, b) => a.unit.start.localeCompare(b.unit.start));
  return {
    built,
    conversations: lifelog,
    failed,
    files,
    read: {
      git: commits.length,
      lifelog: lifelog.length,
      ...Object.fromEntries(chats.map((e, i) => [ORDER[i], e.length])),
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
