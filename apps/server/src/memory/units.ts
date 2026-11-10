import { clock, daysBefore, MIN } from "../core/clock";
import { digest } from "../core/hash";
import { log } from "../core/log";
import type { Engine } from "../core/names";
import { redact } from "../core/redact";
import { settings } from "../core/settings";
import type { SourceEvent } from "../records/source";
import type { Person } from "../records/truth";
import type { Unit } from "../records/unit";
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
import { WEB } from "../sources/screen";
import { LIFE_MAIL } from "./email";
import {
  keptConversations,
  readFiles,
  readInferredRepos,
  readUnits,
} from "./ledger";
import { describeFiles, showFiles } from "./message-files";
import { OWNER, ownerIn, type Truth } from "./read-truth";
import {
  enabledSources,
  isDirect,
  kindOf,
  readySources,
  SOURCES,
  safely,
  sourceOf,
} from "./sources";
import { dayStart, lastDays, localDate, time, type Window } from "./zones";

// Units (docs/architecture.md, "The pipeline"): one conversation-day, chat-day, mail thread-day, note-day or repo-day
// (and lifelog's chapters, as stored before conversation-days: `isFrozen`). Built by code, nothing judged yet. A unit's
// id is stable (same conversation or chat and day -> same id); its hash changes when its content does, so a verdict is
// reused only while the content is unchanged.

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

/** Who a name, handle or address is (`foldsOf`, who.ts: the one resolver), or null. */
export type Resolve = (surface: string) => string | null;

export interface Built {
  messages: Message[];
  /** The whole text, as the models read it. Never stored in memory/: it may hold message text. */
  text: string;
  unit: Unit;
}

export const unitId = (...parts: string[]) =>
  `unit_${digest("sha1", parts.join("|"), 12)}`;
/** The id of the chat-day (thread-day, note-day, repo-day) an event is in. */
export const dayUnitId = (e: SourceEvent) =>
  unitId(e.source, e.chat, localDate(e.at));
/** Messages by chat, in the order given. */
export const chatGroups = (events: SourceEvent[]) =>
  Map.groupBy(events, (e) => `${e.source}|${e.chat}`);
const contentHash = (s: string) => digest("sha256", s, 16);

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

/** Where his agents mail him their reports from: Life's own sender and the `reports` setting. */
const agentReports = () => [
  ...(LIFE_MAIL.from ? [LIFE_MAIL.from] : []),
  ...settings().reports,
];

/** What a unit holding his marks adds to its text (`voiceText`, words.ts): kept, not weighed. */
export const MARKED = "[He asked Life to keep what he says here.]";

/**
 * A stored voice unit that is one of lifelog's chapters (it carries lifelog's summary): kept as stored while its
 * conversation is live (`frozenUnits`), never built again, as the facts, his ratings and corrections cite it (AGENTS.md);
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

/** Events cut into one list per unit: source, chat (or thread, note, repo) and local day. */
const byDay = (events: SourceEvent[]) => [
  ...Map.groupBy(events, dayUnitId).values(),
];

/** One chat's, thread's, note's, repo's or device's events of a day, cut into its unit by its source's kind. */
function cut(list: SourceEvent[], resolve: Resolve) {
  const kind = kindOf((list[0] as SourceEvent).source);
  if (kind === "repo") {
    return repoDay(list);
  }
  return kind === "screen" ? deviceDay(list) : chatDay(list, resolve);
}

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

const lengthOf = (seconds: number) => {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (seconds < 60) {
    return `${seconds} s`;
  }
  return h ? `${h} h ${m} min` : `${m} min`;
};

/**
 * The line Life writes for a phone call (`SourceEvent.phoneCall`), its text in its chat: its kind and span, so a model
 * reads what was said in the room against it, or that no one picked up. Its times make two calls' lines differ.
 */
export function callLine({ at, phoneCall }: SourceEvent) {
  const kind = phoneCall?.video ? "video call" : "audio call";
  const seconds = phoneCall?.seconds;
  if (seconds === undefined) {
    return `(${kind} from ${time(at)}, no end seen)`;
  }
  if (seconds === 0) {
    return `(${kind} at ${time(at)}, not picked up)`;
  }
  const end = new Date(Date.parse(at) + seconds * 1000).toISOString();
  return `(${kind} ${time(at)}–${time(end)}, ${lengthOf(seconds)})`;
}

/** A message's text as every reader shows it: a phone call is its call line. */
export const textOf = (e: SourceEvent) => (e.phoneCall ? callLine(e) : e.text);

/**
 * A 1:1 chat's person: its other senders, else its key, else its name (never a mail subject or a call-only display name).
 * `isDirect` uses the source's group predicate, else more than one other sender means a group.
 */
export function chatPerson(
  list: SourceEvent[],
  resolve: (s: string) => string | null
) {
  const others = new Set(
    list.filter((e) => !e.fromMe).map((e) => resolve(e.sender) ?? e.sender)
  );
  const [first] = list;
  if (!(first && isDirect(first.source, first.chat, others.size))) {
    return null;
  }
  const named =
    first.chatName &&
    !list.every((e) => e.phoneCall) &&
    kindOf(first.source) !== "mail"
      ? resolve(first.chatName)
      : null;
  const person = [...others].find((o) => o.startsWith("person:"));
  // A chat only he wrote in is with whoever its key names (its source's `handleOf`: a WhatsApp id holds a phone).
  const keyed = sourceOf(first.source).handleOf?.(first.chat) ?? first.chat;
  return person ?? (others.size === 0 ? resolve(keyed) : null) ?? named;
}

/**
 * The unit of one chat's (or thread's) messages. Where people write (a chat, a mail) it keeps each sender as
 * `unknown:<sender>`, never resolved here: a reader maps them as of its day (`unitNow`). Its text, read once by the
 * episodes step, names them as `speakerOf` does now.
 */
function chatDay(list: SourceEvent[], resolve: Resolve): Built {
  const sorted = list
    .map((e) => ({ ...e, text: textOf(e) }))
    .sort((a, b) => a.at.localeCompare(b.at));
  const first = sorted[0] as SourceEvent;
  const last = sorted.at(-1) as SourceEvent;
  const kind = kindOf(first.source);
  const written = kind === "chat" || kind === "mail";
  const lines = sorted.map((e) =>
    lineOf(e.at, speakerOf(kind, e, resolve), e.sender, redact(e.text))
  );
  const title = unitTitle(first);
  const ids = sorted.map((e) => e.id);
  // His words to Life: what its reader marked, or every message of a chat with himself.
  const toSelf = chatPerson(sorted, resolve) === OWNER;
  const marked = sorted.filter((e) => e.marked || toSelf).map((e) => e.id);
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
      // Content only, not ids or times: the same chat seen through two sources hashes the same. A mark is content (a
      // line becomes his to keep when whose the chat is resolves later), added only to a marked line.
      hash: contentHash(
        sorted
          .map(
            (e) =>
              `${e.fromMe ? 1 : 0}${marked.includes(e.id) ? "|kept" : ""}|${e.text}`
          )
          .join("\n")
      ),
      id: dayUnitId(first),
      key: first.chat,
      ...(marked.length > 0 ? { marked } : {}),
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

/** "1 h 38 min", "12 min". */
function minutes(ms: number) {
  const m = Math.round(ms / MIN);
  return m < 60
    ? `${m} min`
    : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}`;
}

/** A device-day's stints this long are its lines; shorter ones count in its totals only. */
const LINE_STINT = 5 * MIN;

/**
 * The unit of one device's Screen Time on a local day (a device-day), made like a chat-day: the time by app and website
 * (a minute or more), then each stint of 5 minutes or more. The title: the time in apps and the top one.
 */
function deviceDay(list: SourceEvent[]): Built {
  list.sort((a, b) => a.at.localeCompare(b.at));
  const length = (e: SourceEvent) =>
    Date.parse(e.until ?? e.at) - Date.parse(e.at);
  const lines = list.filter((e) => length(e) >= LINE_STINT);
  const { messages, unit } = chatDay(
    lines.length > 0 ? lines : list,
    () => null
  );
  const totals = [...Map.groupBy(list, (e) => e.text)]
    .map(([what, l]) => ({ ms: l.reduce((n, e) => n + length(e), 0), what }))
    .filter((t) => t.ms >= MIN)
    .sort((a, b) => b.ms - a.ms);
  const apps = totals.filter((t) => !t.what.startsWith(WEB));
  const [top] = apps;
  const body = [
    `Time: ${totals.map((t) => `${t.what} ${minutes(t.ms)}`).join(", ")}`,
    ...lines.map((e) => `${time(e.at)}–${time(e.until ?? e.at)} ${e.text}`),
  ].join("\n");
  const title = `${unit.title}: ${minutes(apps.reduce((n, t) => n + t.ms, 0))} in apps${top ? `, most ${top.what} ${minutes(top.ms)}` : ""}`;
  return {
    messages,
    text: `${title}\n${body}`,
    unit: {
      ...unit,
      end: list
        .map((e) => e.until ?? e.at)
        .sort()
        .at(-1) as string,
      hash: contentHash(body),
      start: (list.at(0) as SourceEvent).at,
      summary: clip(body.split("\n")[0] as string),
      title,
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
/**
 * Life's own mail, its nightly report and alerts, by sender and subject: reading it back would turn its own output into
 * facts. An agent's report, sent from the same address, is not.
 */
const isLifeMail = (sender: string, subject: string) =>
  sender === LIFE_MAIL.from && subject.startsWith(LIFE_MAIL.subject);
/** A message Life wrote: in its own chat, or its own mail. */
export const isLifeOutput = (
  m: Pick<SourceEvent, "chat" | "chatName" | "sender" | "source">
) =>
  m.chat === lifeChat() ||
  (kindOf(m.source) === "mail" && isLifeMail(m.sender, m.chatName ?? ""));
const lifeMail = (t: Thread) =>
  kindOf(t.unit.source) === "mail" &&
  t.messages.every((m) => isLifeMail(m.sender, t.unit.title));
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

type Read = Exclude<Descriptor, { kind: "voice" }>;
/** A source's events since `since`: a repo's are read with his map (whose repos are whose, who he is) and carry no files (a commit without a subject is dropped, like any empty message). */
const readOf = (
  s: Read,
  since: Date,
  map: { me: Person; repos: RepoMap },
  before?: Date
) => (s.kind === "repo" ? s.read(since, map, before) : s.read(since, before));

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
    readOf(
      source,
      new Date(unit.start),
      { me, repos },
      new Date(Date.parse(unit.end) + 1)
    ).filter((e) => e.chat === unit.key && e.at <= unit.end),
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

/**
 * The evidence of a window of local days: every source (lifelog,
 * chats, mail, notes, his commits), cut into units with the code rules applied, senders kept unresolved (`resolve` names them in the text only), in time order across channels; also
 * what the later stages need around them. The one reader of the sources for the memory steps: a sweep gathers once
 * and hands it to each step, which reads the days of its units. The recent messages' new files are read first
 * (`describeFiles`), so a unit's hash moves once when its file is described; an older window (a backfill) keeps its
 * files as tags. A repo's units are never extracted nor read for people (extract skips them; the episodes step caps
 * their importance at 1).
 */
export async function gather(
  window: Window,
  { resolve, truth }: { resolve: Resolve; truth: Truth },
  options: { engine?: Engine; historical?: boolean } = {}
) {
  const since = dayStart(window.from);
  const before = dayStart(daysBefore(window.to, -1));
  const failed: string[] = [];
  const repos = repoMap(truth, await readInferredRepos());
  const ctx = { me: ownerIn(truth.people), repos };
  // Lifelog's units come from the watcher's store, cut first as the registry lists it (a chapter unit as stored); every
  // other source's from its events, in the registry's order. Only the sources he turned on that can be read now; the others' units are kept.
  const sources = readySources().filter(
    (s) => !options.historical || s.kind !== "voice"
  );
  const skipped = enabledSources().filter((s) => !sources.includes(s));
  for (const s of skipped) {
    log("source.read", { ok: true, skipped: s.missing?.(), source: s.name });
  }
  // The voice units the watcher writes, composed the same way (`voiceUnits`).
  let chapters: Unit[] = [];
  let voice: Built[] = [];
  const lifelog = sources.some((s) => s.kind === "voice")
    ? await safely(
        "lifelog",
        () =>
          withStore(async (store) => {
            const v = await voiceUnits(store, since, truth);
            ({ chapters } = v);
            voice = v.built;
            return v.conversations;
          }),
        failed
      )
    : [];
  const read = await Promise.all(
    sources
      .flatMap((s) => (s.kind === "voice" ? [] : [s]))
      .map(async (s) => ({
        events: await safely(
          s.name,
          () => readOf(s, since, ctx, before),
          failed
        ),
        s,
      }))
  );
  // The recent messages' files are described, then every message's shown.
  const recent = dayStart(lastDays(clock(), DAYS).from).toISOString();
  const files = options.historical
    ? undefined
    : await describeFiles(
        read.flatMap(({ events }) => events).filter((e) => e.at >= recent),
        options.engine
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
        ...voice,
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
    engine: options.engine,
    events: shown.flatMap(({ events }) => events),
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
    skipped: (options.historical
      ? SOURCES.filter((s) => !sources.includes(s))
      : skipped
    ).map((s) => s.name),
    truth,
    window,
  };
}
export type Evidence = Awaited<ReturnType<typeof gather>>;

/**
 * The voice units from `since` on, composed once for both writers (`gather`, `syncLifelogUnits`): the conversations
 * lifelog has that end at or after it, built into conversation-days; `have`, the stored voice units they replace (of a
 * conversation read, or ending at or after `since`), read from the earliest day either begins; the frozen chapters
 * among them (`frozenUnits`).
 */
export async function voiceUnits(store: Store, since: Date, truth: Truth) {
  const conversations = readConversations(store, since, lifelogNames(truth));
  const read = new Set(conversations.map((c) => c.id));
  const from = [since.toISOString(), ...conversations.map((c) => c.startedAt)]
    .map(localDate)
    .sort()[0] as string;
  const have = (await readUnits(from)).filter(
    (u) =>
      kindOf(u.source) === "voice" &&
      (read.has(u.key) || u.end >= since.toISOString())
  );
  const chapters = frozenUnits(store, have);
  return {
    built: lifelogUnits(conversations, new Set(chapters.map((u) => u.key))),
    chapters,
    conversations,
    have,
  };
}
