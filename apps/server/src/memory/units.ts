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
  authorOf,
  type LifelogConversation,
  liveConversations,
  readConversations,
  type Store,
  turnRef,
  withStore,
} from "../sources/lifelog";
import { LIFE_MAIL } from "./email";
import {
  keptConversations,
  readFiles,
  readInferredRepos,
  readUnits,
  readUnitsOf,
  UNITS,
} from "./ledger";
import { describeFiles, showFiles } from "./message-files";
import { loadTruth, OWNER, ownerIn, type Truth } from "./read-truth";
import { enabledSources, kindOf, readySources, sourceOf } from "./sources";
import { dayStart, localDate, wall } from "./zones";

// Units (docs/architecture.md, "The pipeline"): one conversation-day, chat-day, mail thread-day, note-day or repo-day
// (and lifelog's chapters, as stored before conversation-days: `isFrozen`). Built by code, nothing judged yet. A unit's
// id is stable (same conversation or chat and day -> same id); its hash changes when its content does, so a verdict is
// reused only while the content is unchanged.

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

export interface Message {
  at: string;
  bulk?: boolean;
  fromMe: boolean;
  id: string;
  /** The sender is someone he knows: a person `resolve` names, or (mail) one his Contacts hold. */
  known: boolean;
  sender: string;
  text: string;
  /** Mail only: see `SourceEvent.transaction`. */
  transaction?: boolean;
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
/** A local day, `YYYY-MM-DD`, not an instant. */
export const isDay = (s: string) => DAY.test(s);
/**
 * `from`..`to` as ISO instants. A date is a local day: `from` starts it, `to` is inclusive (it ends after that day).
 * `from` may be missing; `to` never passes now.
 */
export function dayRange(from?: string, to?: string) {
  const edge = (d: string | undefined, plus: number) => {
    if (!d) {
      return;
    }
    return isDay(d)
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
const agentReports = () => [
  ...(LIFE_MAIL.from ? [LIFE_MAIL.from] : []),
  ...settings().reports,
];

/** A unit's text as the moments model reads it: its start and its end, `TEXT_MAX` at most. */
export const head = (text: string) =>
  text.length <= TEXT_MAX
    ? text
    : `${text.slice(0, TEXT_MAX / 2)}\n…\n${text.slice(-TEXT_MAX / 2)}`;

/** What a unit holding one of his asks (its marks) adds to its text (`voiceText`, words.ts). */
export const MARKED =
  "[He spoke to his agent here: what he says after it is his to remember.]";

/**
 * A stored voice unit that is one of lifelog's chapters (it carries lifelog's summary): kept as stored while its
 * conversation is live (`frozenUnits`), never built again, so the voice history is not read through the models again;
 * its conversation gets no conversation-days.
 * ponytail: a conversation that had chapters when conversation-days came stays chapter-only, even if it grows after;
 * build days for its later turns if that matters.
 */
export const isFrozen = (u: Pick<Unit, "source" | "summary">) =>
  kindOf(u.source) === "voice" && Boolean(u.summary);

/** A stored chapter unit as the steps take it: its text the chapter's title and summary (and `MARKED`), its hash as stored. */
const frozen = (unit: Unit): Built => ({
  messages: [],
  text: [unit.title, unit.summary ?? "", ...(unit.marked ? [MARKED] : [])].join(
    "\n"
  ),
  unit,
});

/**
 * The stored chapter units among `units` whose conversation is live in the store: the one frozen set of both writers
 * (`gather`, `syncLifelogUnits`). A chapter of a conversation lifelog retired or dropped is not, so it goes.
 */
export const frozenUnits = (store: Store, units: Unit[]) => {
  const live = liveConversations(store);
  return units.filter((u) => isFrozen(u) && live.has(u.key));
};

/**
 * Conversation-days: the turns of one conversation on one local day, cut by code alone (no model), for every
 * conversation that is not the `key` of a chapter unit in `frozenKeys`. Its people are the names lifelog gave them,
 * unresolved (`unknown:`, read by `refOf`), and him when he spoke. Life holds no words: its text is filled when it is
 * read (`voiceText`, words.ts), and its hash is its turns, who lifelog says spoke each (his, its person id, else its
 * name) and its marks, so a turn added, moved, marked or given to someone else (29 Oct 2026: he named 96 voices, and
 * their days kept the old names) has it read again.
 * ponytail: words transcribed again under the same turn refs keep the hash; hash the words if re-transcription matters.
 */
export function lifelogUnits(
  conversations: LifelogConversation[],
  frozenKeys: Set<string>
): Built[] {
  return conversations
    .filter((c) => !frozenKeys.has(c.id))
    .flatMap((c) =>
      [...Map.groupBy(c.turns, (t) => localDate(t.at))].map(
        ([date, turns]): Built => {
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
              hash: contentHash(
                [
                  ...turns.map(
                    (t, i) =>
                      `${refs[i]} ${t.owner ? OWNER : (authorOf(t) ?? "")}`
                  ),
                  ...marked,
                ].join("\n")
              ),
              id: unitId("lifelog", c.id, date),
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
              source: "lifelog",
              start: first.at,
              stats: {
                chars: 0,
                fromMe: turns.filter((t) => t.owner).length,
                items: turns.length,
              },
              title: c.title || "Recorded conversation",
            },
          };
        }
      )
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

/** A line of a unit's text, `HH:MM who: text`: `who` the speaker without `person:`, or `unknownAs` when unresolved. */
export const lineOf = (
  at: string,
  speaker: string,
  unknownAs: string,
  text: string
) =>
  `${time(at)} ${speaker.startsWith(UNKNOWN) ? unknownAs : speaker.replace(PERSON, "")}: ${text}`;

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
  const lines = sorted.map((e) =>
    lineOf(e.at, speakerOf(kind, e, resolve), e.sender, redact(e.text))
  );
  const title = unitTitle(first);
  const ids = sorted.map((e) => e.id);
  return {
    messages: sorted.map((e) => ({
      at: e.at,
      bulk: e.bulk,
      fromMe: e.fromMe,
      id: e.id,
      known: !!e.contact || resolve(e.sender) !== null,
      sender: e.sender,
      text: e.text,
      transaction: e.transaction,
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
 * The chat with Life's retired Telegram bot (its chat id, the `lifeChat` setting): its briefs and answers were
 * Life's output, so neither memory nor the raw chat reads open it. Unset, no chat is Life's.
 */
export const lifeChat = () => settings().lifeChat;

/** A mail thread-day as the mail rules read it (a `Built` is one): its subject and its messages. */
interface Thread {
  messages: Pick<Message, "bulk" | "fromMe" | "sender">[];
  unit: Pick<Unit, "source" | "title">;
}
/** Mail the owner never wrote in, other than his agents' reports (the model judges those: he asked for their to-dos). */
const isMail = (t: Thread) =>
  kindOf(t.unit.source) === "mail" &&
  !t.messages.some((m) => m.fromMe || agentReports().includes(m.sender));
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
  // Life's own chat (see lifeChat) and mail.
  ["life-output", (b) => b.unit.key === lifeChat() || lifeMail(b)],
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
  // Mail from no one he knows (a shop, a service, a stranger) in a thread he never wrote in, other than a transaction
  // (a bulk one is still a newsletter, above): search still finds it.
  [
    "not-a-person",
    (b) => isMail(b) && !b.messages.some((m) => m.known || m.transaction),
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
/** A source's events since `since`: a repo's are read with his map (whose repos are whose, who he is) and carry no files (a commit without a subject is dropped, like any empty message). */
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

/** Lifelog person id -> the name on the map, for the people `truth/people.yaml` holds a `lifelog` handle for. */
export const lifelogNames = (truth: Truth) =>
  new Map(
    truth.people.flatMap((p) =>
      p.handles.lifelog ? [[p.handles.lifelog, p.name]] : []
    )
  );

/**
 * The default look-back of every step: yesterday, plus what a sleeping Mac or a late transcript left behind, and the
 * conversations lifelog regroups a few days later (their new hash needs a new verdict). Files are described
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
  // Lifelog's units come from the watcher's store, cut first as the registry lists it (a chapter unit as stored); every
  // other source's from its events, in the registry's order. Only the sources he turned on that can be read now; the others' units are kept.
  const sources = readySources();
  const skipped = enabledSources().filter((s) => !sources.includes(s));
  for (const s of skipped) {
    log("source.read", { ok: true, skipped: s.missing?.(), source: s.name });
  }
  // The stored chapter units whose conversation is live, read with the conversations (`frozenUnits`).
  let chapters: Unit[] = [];
  const lifelog = sources.some((s) => s.kind === "voice")
    ? await safely(
        "lifelog",
        async () => {
          const units = await readUnits();
          return withStore((store) => {
            chapters = frozenUnits(store, units);
            return readConversations(store, since, lifelogNames(truth));
          });
        },
        failed
      )
    : [];
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
    ...chapters.map(frozen),
    ...applyRules(
      [
        ...lifelogUnits(lifelog, new Set(chapters.map((u) => u.key))),
        ...shown.flatMap(({ events }) => messageUnits(events, resolve)),
      ],
      keptConversations()
    ),
  ]
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
 * Makes the lifelog units in memory/units/ the ones the store gives (what the watcher does after a page); a chapter unit
 * stays as stored while its conversation is live (`frozenUnits`), and goes with it. A day's file is rewritten only when its lifelog units differ; other sources' units in it stay. Returns how many units were built,
 * changed and removed.
 * ponytail: `gather` (moments) applies the `duplicate` rule to the window's units of every source, this to all lifelog
 * units, so a lifelog unit repeating one from before the window may flip between the two writers; one writer settles it.
 */
export async function syncLifelogUnits(store: Store) {
  const truth = await loadTruth();
  const all = await readUnits();
  const have = all.filter((u) => kindOf(u.source) === "voice");
  const chapters = frozenUnits(store, have);
  const want = [
    ...chapters,
    ...applyRules(
      lifelogUnits(
        readConversations(store, new Date(0), lifelogNames(truth)),
        new Set(chapters.map((u) => u.key))
      )
    ).map((b) => Unit.parse(b.unit)),
  ];
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
  await writeUnits([...dates], want, (u) => kindOf(u.source) !== "voice");
  return {
    added: added.length,
    changed: changed.length,
    checked: want.length,
    removed: removed.length,
  };
}
