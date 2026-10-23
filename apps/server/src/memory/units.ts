import { join } from "node:path";
import { clock } from "../core/clock";
import { digest } from "../core/hash";
import { log } from "../core/log";
import { redact } from "../core/redact";
import { settings } from "../core/settings";
import type { SourceEvent } from "../records/source";
import type { Person } from "../records/truth";
import { Unit } from "../records/unit";
import type { Descriptor, RepoMap } from "../sources/contract";
import { repoMap } from "../sources/git";
import {
  readConversations,
  type Store,
  turnRef,
  type VoiceConversation,
  withStore,
} from "../sources/voice";
import { LIFE_MAIL } from "./email";
import {
  keptConversations,
  readFiles,
  readInferredRepos,
  readMigrations,
  readUnits,
  readUnitsOf,
  UNITS,
} from "./ledger";
import { describeFiles, showFiles } from "./message-files";
import { loadTruth, OWNER, ownerIn, type Truth } from "./read-truth";
import { enabledSources, kindOf, readySources, sourceOf } from "./sources";
import { dayStart, localDate, wall } from "./zones";

// Units (docs/architecture.md, "The pipeline"): one conversation-day, chat-day, mail thread-day, note-day or repo-day
// (and, before an install's voice cutover, lifelog's chapters as stored). Built by code, nothing judged yet. A unit's id is stable
// (same conversation or chat and day -> same id); its hash changes when its content does, so a verdict is reused only
// while the content is unchanged.

/** How much of a unit's text the moments model reads (`head`). */
const TEXT_MAX = 1500;
const SHORT_CHARS = 12;
const OTP_MAX = 200;
export const PERSON = /^person:/;
export const UNKNOWN = "unknown:";
const AGENT = "agent:";
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
  `unit_${digest("sha1", parts.join("|"), 12)}`;
/** The id of the chat-day (thread-day, note-day, repo-day) an event is in. */
export const dayUnitId = (e: SourceEvent) =>
  unitId(e.source, e.chat, localDate(e.at));
const contentHash = (s: string) => digest("sha256", s, 16);

const DAY = /^\d{4}-\d{2}-\d{2}$/;
/**
 * `from`..`to` as ISO instants. A date is a local day: `from` starts it, `to` is inclusive (it ends after that day).
 * `from` may be missing; `to` never passes now, so a frozen clock (`LIFE_NOW`) bounds every live source read through it.
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
  const now = clock().toISOString();
  const end = edge(to, 1);
  return { from: edge(from, 0), to: end && end < now ? end : now };
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

/** Where his agents mail him their reports from: Life's own sender and the `reports` setting. */
const AGENT_REPORTS = [
  ...(LIFE_MAIL.from ? [LIFE_MAIL.from] : []),
  ...settings().reports,
];

/** A unit's text as the moments model reads it: its start and its end, `TEXT_MAX` at most. */
export const head = (text: string) =>
  text.length <= TEXT_MAX
    ? text
    : `${text.slice(0, TEXT_MAX / 2)}\n…\n${text.slice(-TEXT_MAX / 2)}`;

/** What a unit he marked with "hey Life" adds to its text (`voiceText`, words.ts). */
export const MARKED =
  '[He said "hey Life" here: he asked Life to remember what he says after it.]';

/** The voice rename's name in memory/migrations.jsonl (host/migrate.ts). */
export const VOICE_STEP = "voice-names";

/**
 * The local day from which voice units are conversation-days: the day this install's voice rename ran on memory that
 * held lifelog's chapters (its line's `cutover`). Earlier voice units are those chapters, kept as stored, never built
 * again (`isFrozen`), so the voice history is not read through the models again. "" (every day) on an install that never
 * had chapters.
 */
export const voiceCutover = () =>
  readMigrations().find((m) => m.name === VOICE_STEP)?.cutover ?? "";

/** A voice unit from before the cutover: one of lifelog's chapters, as stored. */
export const isFrozen = (u: Pick<Unit, "date" | "source">, cutover: string) =>
  kindOf(u.source) === "voice" && u.date < cutover;

/** A stored chapter unit as the steps take it: its text the chapter's title and summary (and `MARKED`), its hash as stored. */
const frozen = (unit: Unit): Built => ({
  messages: [],
  text: [unit.title, unit.summary ?? "", ...(unit.marked ? [MARKED] : [])].join(
    "\n"
  ),
  unit,
});

/**
 * Conversation-days: the turns of one conversation on one local day, from `from` on, cut by code alone (no model). Its
 * people are the names the voice server gave them, unresolved (`unknown:`, read by `refOf`), and him when he spoke.
 * Life holds no words: its text is filled when it is read (`voiceText`, words.ts), and its hash is its turns and
 * marks, so a turn added, moved or marked has it read again.
 * ponytail: words transcribed again under the same turn refs keep the hash; hash the words if re-transcription matters.
 */
export function voiceUnits(
  conversations: VoiceConversation[],
  from: string
): Built[] {
  return conversations.flatMap((c) =>
    [...Map.groupBy(c.turns, (t) => localDate(t.at))]
      .filter(([date]) => date >= from)
      .map(([date, turns]): Built => {
        const first = turns[0] as (typeof turns)[number];
        const next = dayStart(daysBefore(date, -1)).toISOString();
        const marked = turns.flatMap((t) => t.marks);
        const refs = turns.map((t) => turnRef(t.jobId, t.turnIndex, t.at));
        return {
          messages: [],
          text: "",
          unit: {
            date,
            end: c.endedAt < next ? c.endedAt : next,
            hash: contentHash([...refs, ...marked].join("\n")),
            id: unitId("voice", c.id, date),
            key: c.id,
            ...(marked.length > 0 ? { marked } : {}),
            people: [
              ...new Set(
                turns.flatMap((t) => {
                  if (t.owner) {
                    return [OWNER];
                  }
                  return t.name ? [`${UNKNOWN}${t.name}`] : [];
                })
              ),
            ].sort(),
            refs: [...new Set([refs[0], refs.at(-1)])].filter(
              (r): r is string => !!r
            ),
            schemaVersion: 1,
            source: "voice",
            start: first.at,
            stats: {
              chars: 0,
              fromMe: turns.filter((t) => t.owner).length,
              items: turns.length,
            },
            title: c.title || "Recorded conversation",
          },
        };
      })
  );
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

/** One chat's, thread's, note's or repo's events of a day, cut into its unit by its source's kind. */
const cut = (list: SourceEvent[], resolve: Resolve) =>
  kindOf((list[0] as SourceEvent).source) === "repo"
    ? repoDay(list)
    : chatDay(list, resolve);

/** Chat-days, mail thread-days, note-days and repo-days: every event of one chat, thread, note or repo on one local day. */
export const messageUnits = (events: SourceEvent[], resolve: Resolve) =>
  byDay(events).map((list) => cut(list, resolve));

/** A chat-day's or thread-day's title: its chat's name, else for mail "(no subject)", else the chat id. */
export const unitTitle = (first: SourceEvent) =>
  first.chatName ??
  (kindOf(first.source) === "mail" ? "(no subject)" : first.chat);

/**
 * Who wrote a message, as the memory steps read it: him, an agent (its own line, never a person), else whom `resolve`
 * names now, else `unknown:<sender>`.
 */
export function speakerOf(
  kind: Descriptor["kind"],
  m: { fromMe: boolean; sender: string },
  resolve: Resolve
) {
  if (m.fromMe) {
    return OWNER;
  }
  if (kind === "agent") {
    return `${AGENT}${m.sender}`;
  }
  return resolve(m.sender) ?? `${UNKNOWN}${m.sender}`;
}

/**
 * The unit of one chat's (or thread's) messages. Where people write (a chat, a mail) it keeps each sender as
 * `unknown:<sender>`, never resolved here: a reader maps them as of its day (`unitNow`). Its text, read once by the
 * moments step, names them as `speakerOf` does now.
 */
function chatDay(list: SourceEvent[], resolve: Resolve): Built {
  const sorted = list.sort((a, b) => a.at.localeCompare(b.at));
  const first = sorted[0] as SourceEvent;
  const last = sorted.at(-1) as SourceEvent;
  const kind = kindOf(first.source);
  const written = kind === "chat" || kind === "mail";
  const lines = sorted.map((e) => {
    const who = speakerOf(kind, e, resolve);
    return `${time(e.at)} ${who.startsWith(UNKNOWN) ? e.sender : who.replace(PERSON, "")}: ${redact(e.text)}`;
  });
  const title = unitTitle(first);
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
      people: [
        ...new Set(
          sorted.flatMap((e) => {
            if (e.fromMe) {
              return [OWNER];
            }
            return written ? [`${UNKNOWN}${e.sender}`] : [];
          })
        ),
      ].sort(),
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
 * The unit of one repo's commits on a local day (a repo-day), made like a chat-day. The summary is the day's commit
 * subjects, which makes them searchable; the title counts commits and lines.
 */
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
 * The chat with Life's retired Telegram bot (its Beeper chat id, the `lifeChat` setting): its briefs and answers were
 * Life's output, so neither memory nor the raw chat reads open it. Unset, no chat is Life's.
 */
export const LIFE_CHAT = settings().lifeChat;

/** A mail thread-day as the mail rules read it (a `Built` is one): its subject and its messages. */
interface Thread {
  messages: Pick<Message, "bulk" | "fromMe" | "sender">[];
  unit: Pick<Unit, "source" | "title">;
}
/** Mail the owner never wrote in, other than his agents' reports (the model judges those: he asked for their to-dos). */
const isMail = (t: Thread) =>
  kindOf(t.unit.source) === "mail" &&
  !t.messages.some((m) => m.fromMe || AGENT_REPORTS.includes(m.sender));
/** Life's nightly report and alerts: reading them back would turn its own output into facts. */
const lifeMail = (t: Thread) =>
  kindOf(t.unit.source) === "mail" &&
  t.unit.title.startsWith(LIFE_MAIL.subject) &&
  t.messages.every((m) => m.sender === LIFE_MAIL.from);
/** A newsletter or marketing send (Mail saw a list id or an unsubscribe link) the owner never answered. */
const newsletter = (t: Thread) => isMail(t) && t.messages.every((m) => m.bulk);
/** The mail thread-days (each its messages) `search` shows: by the rules' own terms, neither Life's own mail nor a newsletter. */
export const searchableMail = (events: SourceEvent[]) =>
  byDay(events).filter((list) => {
    const first = list[0] as SourceEvent;
    const t = {
      messages: list,
      unit: { source: first.source, title: unitTitle(first) },
    };
    return !(lifeMail(t) || newsletter(t));
  });

/** Cheap code rules for obvious noise (§3.3), in order. The first rule that matches drops the unit. */
const RULES: [
  string,
  (b: Built, seen: Set<string>, kept: Set<string>) => boolean,
][] = [
  // Life's own chat (see LIFE_CHAT) and mail.
  ["life-output", (b) => b.unit.key === LIFE_CHAT || lifeMail(b)],
  // An imported conversation the import step did not keep as about his life (memory/imported.jsonl).
  [
    "not-kept",
    (b, _seen, kept) =>
      !!sourceOf(b.unit.source).imported && !kept.has(b.unit.key),
  ],
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
  ["newsletter", newsletter],
  // Vendor and notification mail from a no-reply or alerts address the owner never answered, with nothing in it that matters.
  [
    "automated",
    (b) =>
      isMail(b) &&
      !MATTERS.test(b.text) &&
      b.messages.every((m) => AUTOMATED.test(m.sender.split("@")[0] ?? "")),
  ],
];

/** Marks each unit a rule drops (`unit.drop` names the rule); `kept`: the imported conversations the import kept. */
export function applyRules(built: Built[], kept = new Set<string>()) {
  const seen = new Set<string>();
  for (const b of built) {
    const rule = RULES.find(([, test]) => test(b, seen, kept))?.[0];
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
    /** What `search` reads chat messages and notes from: the sources it has a window for. */
    SEARCHED: readers((s) => s.kind !== "mail" && s.searchDays !== undefined),
    /** The mail `search` reads, in a section of its own. */
    SEARCHED_MAIL: readers(
      (s) => s.kind === "mail" && s.searchDays !== undefined
    ),
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
/** The tables of the sources that can be read now, worked out on each call (settings and permissions change). */
export const tables = () => tablesOf(readySources());
export type Tables = ReturnType<typeof tablesOf>;

type Read = Exclude<Descriptor, { kind: "voice" }>;
/** A source's events since `since`: a repo's are read with his map (whose repos are whose, who he is) and carry no files. */
const readOf = (s: Read, since: Date, map: { me: Person; repos: RepoMap }) =>
  s.kind === "repo" ? s.read(since, map) : s.read(since);

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
  const events = showFiles(
    readOf(source, new Date(unit.start), { me, repos }).filter(
      (e) => e.chat === unit.key && e.at <= unit.end
    ),
    readFiles()
  );
  if (events.length > 0) {
    return cut(events, resolve);
  }
}

/** The voice server's person id -> the name on the map, for the people `truth/people.yaml` holds a `lifelog` handle for. */
export const voiceNames = (truth: Truth) =>
  new Map(
    truth.people.flatMap((p) =>
      p.handles.lifelog ? [[p.handles.lifelog, p.name]] : []
    )
  );

/**
 * The default look-back of every step: yesterday, plus what a sleeping Mac or a late transcript left behind, and the
 * conversations the voice server regroups a few days later (their new hash needs a new verdict). Files are described
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

/** The local days of `window` before `before`, in order. */
function datesIn(window: Window, before: string) {
  const dates: string[] = [];
  for (let d = window.from; d <= window.to && d < before; ) {
    dates.push(d);
    d = daysBefore(d, -1);
  }
  return dates;
}

/**
 * The evidence of a window of local days: every source (his conversations,
 * chats, mail, notes, his commits), cut into units with the code rules applied, senders kept unresolved (`resolve` names them in the text only), in time order across channels; also
 * what the later stages need around them. The one reader of the sources for the memory steps: a sweep gathers once
 * and hands it to each step, which reads the days of its units. The recent messages' new files are read first
 * (`describeFiles`), so a unit's hash moves once when its file is described; an older window (a backfill) keeps its
 * files as tags. A repo's units are never extracted nor read for people (extract skips them; the moments step caps
 * their importance at 1).
 */
export async function gather(
  window: Window,
  { resolve, truth }: { resolve: Resolve; truth: Truth }
) {
  // ponytail: the readers read from `since` to now and the window is cut after, so a backfill week of 2025 reads every
  // source up to today; give the readers an end if the pilot measures that slow next to the model calls.
  const since = dayStart(window.from);
  const failed: string[] = [];
  const repos = repoMap(truth, await readInferredRepos());
  const ctx = { me: ownerIn(truth.people), repos };
  // Voice units come from the watcher's store, cut first as the registry lists it (before the cutover, as stored);
  // every other source's from its events, in the registry's order. Only the sources he turned on that can be read now;
  // the others' units are kept.
  const sources = readySources();
  const skipped = enabledSources().filter((s) => !sources.includes(s));
  for (const s of skipped) {
    log("source.read", { ok: true, skipped: s.missing?.(), source: s.name });
  }
  const voice = sources.some((s) => s.kind === "voice")
    ? await safely(
        "voice",
        () =>
          withStore((store) =>
            readConversations(store, since, voiceNames(truth))
          ),
        failed
      )
    : [];
  const cutover = voiceCutover();
  const chapters = readUnitsOf(datesIn(window, cutover))
    .filter((u) => isFrozen(u, cutover))
    .map(frozen);
  const read = await Promise.all(
    sources
      .flatMap((s) => (s.kind === "voice" ? [] : [s]))
      .map(async (s) => ({
        events: await safely(s.name, () => readOf(s, since, ctx), failed),
        s,
      }))
  );
  // The recent messages' files are described, then every message's shown.
  const recent = dayStart(lastDays(clock(), DAYS).from).toISOString();
  const files = await describeFiles(
    read.flatMap(({ events }) => events).filter((e) => e.at >= recent)
  );
  const known = readFiles();
  const shown = read.map(({ events, s }) => ({
    events: showFiles(events, known),
    s,
  }));
  const built = [
    ...chapters,
    ...applyRules(
      [
        ...voiceUnits(voice, cutover),
        ...shown.flatMap(({ events }) => messageUnits(events, resolve)),
      ],
      keptConversations()
    ),
  ]
    .filter((b) => b.unit.date >= window.from && b.unit.date <= window.to)
    .toSorted((a, b) => a.unit.start.localeCompare(b.unit.start));
  return {
    built,
    conversations: voice,
    failed,
    files,
    read: {
      voice: voice.length,
      ...Object.fromEntries(
        shown.map(({ events, s }) => [s.name, events.length])
      ),
    },
    repos,
    /** Sources he turned on that can't be read now: their units stay as they were. */
    skipped: skipped.map((s) => s.name),
    truth,
    window,
  };
}
export type Evidence = Awaited<ReturnType<typeof gather>>;

/**
 * Writes memory/units/<date>.jsonl for each of `dates`: that day's units, sorted by start, with the units already there
 * that `keep` keeps (those of a source this write did not read).
 */
export async function writeUnits(
  dates: string[],
  fresh: Unit[],
  keep: (u: Unit) => boolean = () => false
) {
  const ids = new Set(fresh.map((u) => u.id));
  const units = [
    ...fresh,
    ...readUnitsOf(dates).filter((u) => keep(u) && !ids.has(u.id)),
  ];
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
 * Makes the voice units in memory/units/ the ones the store gives (what the watcher does after a page), from the
 * cutover on: a chapter unit before it stays as stored. A day's file is rewritten only when its voice units differ;
 * other sources' units in it stay. Returns how many units were built, changed and removed.
 * ponytail: `gather` (moments) applies the `duplicate` rule to the window's units of every source, this to all voice
 * units, so a voice unit repeating one from before the window may flip between the two writers; one writer settles it.
 */
export async function syncVoiceUnits(store: Store) {
  const truth = await loadTruth();
  const cutover = voiceCutover();
  const want = applyRules(
    voiceUnits(
      readConversations(store, new Date(0), voiceNames(truth)),
      cutover
    )
  ).map((b) => Unit.parse(b.unit));
  const all = await readUnits();
  const have = all.filter(
    (u) => kindOf(u.source) === "voice" && !isFrozen(u, cutover)
  );
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
    want,
    (u) => kindOf(u.source) !== "voice" || isFrozen(u, cutover)
  );
  return {
    added: added.length,
    changed: changed.length,
    checked: want.length,
    removed: removed.length,
  };
}
