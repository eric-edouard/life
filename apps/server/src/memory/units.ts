import { daysBefore, iso, SECOND } from "../core/clock";
import { digest } from "../core/hash";
import { count } from "../core/lists";
import type { SourceName } from "../core/names";
import { redact } from "../core/redact";
import { settings } from "../core/settings";
import type { SourceEvent } from "../records/source";
import type { Person } from "../records/truth";
import type { Unit } from "../records/unit";
import type { Descriptor, RepoMap } from "../sources/contract";
import {
  authorOf,
  type LifelogConversation,
  type LifelogTurn,
  liveConversations,
  parseTurnRef,
  type Store,
  turnRef,
} from "../sources/voice-server";
import { voiceKey } from "../sources/voice-speakers";
import {
  deviceDayText,
  measurementDayText,
  photoDayText,
} from "./activity-days";
import { cutsOn, type Deletions, isGone, NO_DELETIONS } from "./deletions";
import { LIFE_MAIL } from "./email";
import { keptConversations } from "./memory-files";
import { readFiles, showFiles } from "./message-files";
import { OWNER, type Truth } from "./read-truth";
import {
  deletedReadOf,
  isDirect,
  isWithPeople,
  kindOf,
  sourceOf,
} from "./sources";
import { dayUnitId, voiceUnitId } from "./unit-ids";
import { dayStart, localDate, time } from "./zones";

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
  sender: string;
  text: string;
  /** Mail only: see `SourceEvent.transaction`. */
  transaction?: boolean;
}

/** Where a name or handle was read: a source (its senders' kind, `Descriptor.hasPhoneHandles`) or a Contacts field. */
export type HandleFrom = SourceName | "contacts";

/** A conversation, chat or mail thread across sources: its source and its unit `key` (`source|key`). His `this-is` may be said in one (`inConversation`). */
export const conversationKeyOf = (u: { key: string; source: string }) =>
  `${u.source}|${u.key}`;

/** Who a name, handle or address is (`foldsOf`, who.ts: the one resolver), or null; `from` where it was read and `inConversation` (`conversationKeyOf`) the conversation, when known. */
export type Resolve = (
  nameOrHandle: string,
  from?: HandleFrom,
  inConversation?: string
) => string | null;

export interface Built {
  messages: Message[];
  /** The whole text, as the models read it. Never stored in memory/: it may hold message text. */
  text: string;
  unit: Unit;
}

const contentHash = (s: string) => digest("sha256", s, 16);

type Hashed = Pick<Message, "fromMe" | "id" | "text">;
const messagesHash = (messages: Hashed[], marked: string[]) =>
  contentHash(
    messages
      .map(
        (e) =>
          `${e.fromMe ? 1 : 0}${marked.includes(e.id) ? "|kept" : ""}|${e.text}`
      )
      .join("\n")
  );

/** The hash (content only, a mark added to a marked line) a message unit had when it held only its first `n` messages: what an earlier reading of it stored. */
export const linesHashOf = ({ messages, unit }: Built, n: number) =>
  messagesHash(messages.slice(0, n), unit.marked ?? []);

/**
 * Lower case, no accents, Latin letters and digits only: the recipe of stored text and ids (observation ids, entry ids,
 * slugs, the passages column, topic tags), never to change. Names are compared with `nameKey`.
 */
export const normalize = (s: string) =>
  s
    .normalize("NFD")
    .replace(MARKS, "")
    .toLowerCase()
    .replace(NON_ALNUM, " ")
    .trim();

// Latin accents and variation selectors (the emoji "❤️" is two characters): dropped; other scripts' marks tell words apart.
const DROPPED_MARKS = /[\u0300-\u036f\ufe00-\ufe0f]/g;
const NOT_NAME = /[^\p{L}\p{N}\p{M}]+/gu;

/**
 * How a person's or a project's name is compared, computed fresh on both sides: lower case, Latin accents removed,
 * letters, digits and marks of every script kept. Never stored, never an id: ids and stored text use `normalize`.
 */
export const nameKey = (s: string) =>
  s
    .normalize("NFD")
    .replace(DROPPED_MARKS, "")
    .toLowerCase()
    .replace(NOT_NAME, " ")
    .trim();

/** Whether `text` holds one of `names` as a whole word run (never inside a longer word; accents and case never matter); an empty name matches nothing. */
export const holdsName = (
  text: string,
  names: readonly (string | undefined)[]
) =>
  names.some(
    (n) => n && nameKey(n) && ` ${nameKey(text)} `.includes(` ${nameKey(n)} `)
  );

const SUMMARY_MAX = 300;

/** `s` cut at a word within `max` characters, with an ellipsis. */
export const clip = (s: string, max = SUMMARY_MAX) =>
  s.length <= max
    ? s
    : `${s.slice(0, s.lastIndexOf(" ", max - 1) > 0 ? s.lastIndexOf(" ", max - 1) : max - 1)}…`;

/** `s` on one line (its whitespace runs flattened), cut at a word within `max` characters. */
export const oneLineOf = (s: string, max: number) =>
  clip(s.replace(/\s+/g, " ").trim(), max);

/** Whether a sender is one of his agents mailing him a report: Life's own sender or the `reports` setting. */
export const isAgentReport = (sender: string) =>
  sender === LIFE_MAIL.from || settings().agentReportSenders.includes(sender);

/** A no-reply address: mail no one answers. */
const NO_REPLY =
  /(^|[-_.+])(no[-_.]?repl(y|ay)|do[-_.]?not[-_.]?reply|ne[-_.]?pas[-_.]?repondre|mailer-daemon|notifications?|failed-payments)([-_.+]|$)/i;

const isNoReply = (handle: string) => NO_REPLY.test(handle.split("@")[0] ?? "");

/** Whether a mail handle is a sender no one answers or owes: a no-reply address, or his agents' reports. */
export const isMailerHandle = (handle: string) =>
  isAgentReport(handle) || isNoReply(handle);

/** What a unit holding his marks adds to its text (`voiceText`, words.ts): kept, not weighed. */
export const MARKED = "[He asked Life to keep what he says here.]";

/**
 * A stored voice unit that is one of lifelog's chapters (it carries lifelog's summary): kept as stored while its
 * conversation is live (`frozenUnits`), never built again, as the facts, his fact-check answers and corrections cite it (AGENTS.md);
 * its conversation gets no conversation-days.
 * ponytail: a conversation that had chapters when conversation-days came stays chapter-only, even if it grows after;
 * build days for its later turns if that matters.
 */
export const isFrozen = (u: Pick<Unit, "source" | "summary">) =>
  kindOf(u.source) === "voice" && Boolean(u.summary);

/** A stored chapter unit as the steps take it: its text the chapter's title and summary (and `MARKED`), its hash as stored. */
export const frozenBuilt = (unit: Unit): Built => ({
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

/** A recording's label, made by code: "Conversation at 14:05 with Sam, Mai" (his local time; just the time when he was alone). */
export function conversationLabel(start: string, names: string[]) {
  const who = [...new Set(names)].sort();
  return `Conversation at ${time(start)}${who.length > 0 ? ` with ${who.join(", ")}` : ""}`;
}

/**
 * What a deletion did to a turn, folded into its unit's hash so the unit is read again: its ref when the turn is gone whole,
 * each cut's digest (never its words) for one he cut words out of.
 */
const deletionKeysOf = (t: LifelogTurn, deletions: Deletions) => {
  const ref = turnRef(t.jobId, t.turnIndex, t.at);
  return isGone(ref, deletions)
    ? [`${ref} deleted`]
    : cutsOn(ref, deletions).map((c) => `${ref} cut:${c.digest}`);
};

/** A turn's identity: its ref and who lifelog says spoke it (his, its person id, else its name). */
export const turnKey = (t: LifelogTurn) =>
  `${turnRef(t.jobId, t.turnIndex, t.at)} ${t.owner ? OWNER : (authorOf(t) ?? "")}`;

/**
 * An unnamed turn's key for the voice naming read: its ref and its voice's label in its recording, so a guess is of that
 * voice and goes the moment a name is given to it, lifelog matches it or it is relabelled (`memory/voice-naming.ts`).
 */
export const unnamedTurnKey = (ref: string, label: string) =>
  `${ref} voice:${label}`;

/** The turn ref a key starts with: of a `turnKey`, an `unnamedTurnKey` or a line of `messages`. */
export const turnRefOf = (key: string) => key.split(" ")[0] ?? "";

/** The voice (its recording and label, `voiceKey`) of an `unnamedTurnKey`. */
export function voiceOfKey(key: string) {
  const [ref = "", label = ""] = key.split(" voice:");
  return voiceKey(parseTurnRef(ref)?.jobId ?? ref, label);
}

/**
 * `V1`, `V2`… for the distinct voices among `keys`, by first appearance: the one numbering of the voices of a part. A
 * key is `unnamedTurnKey`'s.
 */
export function voiceTokensOf(keys: string[]) {
  const tokens = new Map<string, string>();
  for (const key of keys) {
    const voice = voiceOfKey(key);
    if (!tokens.has(voice)) {
      tokens.set(voice, `V${tokens.size + 1}`);
    }
  }
  return tokens;
}

/** A conversation's turns by local day: one voice unit's turns each (`voiceUnitId(c.id, day)`). */
export const turnsByDayOf = (c: LifelogConversation) =>
  Map.groupBy(c.turns, (t) => localDate(t.at));

/**
 * Conversation-days: the turns of one conversation on one local day, cut by code alone (no model), for every
 * conversation that is not the `key` of a chapter unit in `frozenKeys`. Its people are the names lifelog gave them,
 * unresolved (`unknown:`, read by `refOf`), and him when he spoke. Life holds no words: its text is filled when it is
 * read (`voiceText`, words.ts), and its hash is its turns, who lifelog says spoke each (his, its person id, else its
 * name), its marks and what he deleted of it (`deletionKeysOf`), so a turn added, moved, marked or given to someone else
 * (29 Oct 2026: he named 96 voices, and their days kept the old names) or whose words he deleted has it read again.
 * ponytail: words transcribed again under the same turn refs keep the hash; hash the words if re-transcription matters.
 */
export function lifelogUnits(
  conversations: LifelogConversation[],
  frozenKeys: Set<string>,
  deletions: Deletions = NO_DELETIONS
): Built[] {
  return conversations
    .filter((c) => !frozenKeys.has(c.id))
    .flatMap((c) =>
      [...turnsByDayOf(c)].map(([date, turns]): Built => {
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
                ...turns.map(turnKey),
                ...turns.flatMap((t) => deletionKeysOf(t, deletions)),
                ...marked,
              ].join("\n")
            ),
            id: voiceUnitId(c.id, date),
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
            title: conversationLabel(
              first.at,
              turns.flatMap((t) => (t.owner || !t.name ? [] : [t.name]))
            ),
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

/** One list per chat-day, thread-day, note-day, repo-day, device-day, measurement-day or photo-day, by source and local day. */
const byDay = (events: SourceEvent[]) => [
  ...Map.groupBy(events, dayUnitId).values(),
];

/** A chat-day, thread-day, note-day, repo-day, device-day, measurement-day or photo-day, cut by its source's kind. */
function cut(list: SourceEvent[], resolve: Resolve) {
  const kind = kindOf((list[0] as SourceEvent).source);
  if (kind === "repo") {
    return repoDay(list);
  }
  if (kind === "screen") {
    return activityDay(list, deviceDayText(list));
  }
  if (kind === "photos") {
    return activityDay(list, photoDayText(list));
  }
  return kind === "physical"
    ? activityDay(list, measurementDayText(list))
    : chatDay(list, resolve);
}

/** Chat-days, mail thread-days, note-days and repo-days: every event of one chat, thread, note or repo on one local day. */
export const messageUnits = (events: SourceEvent[], resolve: Resolve) =>
  byDay(events).map((list) => cut(list, resolve));

/**
 * The units of every source but lifelog, from their events with files shown (`showFiles`), the code rules applied: the
 * night's (`gather`) and the watcher's today (`publishTodayUnits`) alike. Lifelog's are ruled apart; their hashes never
 * meet these, so the `duplicate` rule is the same either way.
 */
export const sourceUnitsOf = (shown: SourceEvent[], resolve: Resolve) =>
  applyRules(messageUnits(shown, resolve), keptConversations());

/** A chat-day's or thread-day's title: its chat's name, else for mail "(no subject)", else the chat id. */
export const unitTitle = (first: SourceEvent) =>
  first.chatName ??
  (kindOf(first.source) === "mail" ? "(no subject)" : first.chat);

/**
 * Who wrote a message, as the memory steps read it: him, an agent (its own line, never a person), else whom `resolve`
 * names now, else `unknown:<sender>`.
 */
export function speakerOf(
  source: SourceName,
  m: { fromMe: boolean; sender: string },
  resolve: Resolve,
  inConversation?: string
) {
  if (m.fromMe) {
    return OWNER;
  }
  if (kindOf(source) === "agent") {
    return `${AGENT}${m.sender}`;
  }
  return resolve(m.sender, source, inConversation) ?? `${UNKNOWN}${m.sender}`;
}

/** A line of a unit's text, `HH:MM who: text`: `who` the speaker without `person:`, or `unknownAs` when unresolved. */
export const lineOf = (
  at: string,
  speaker: string,
  unknownAs: string,
  text: string
) =>
  `${time(at)} ${speaker.startsWith(UNKNOWN) ? unknownAs : speaker.replace(PERSON, "")}: ${text}`;

// ponytail: call durations keep their stored text; unify with minutes only with a hash migration.
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
export function callLine(e: SourceEvent) {
  const kind = e.phoneCall?.video ? "video call" : "audio call";
  const seconds = e.phoneCall?.seconds;
  if (seconds === undefined) {
    return `(${kind} from ${time(e.at)}, no end seen)`;
  }
  if (seconds === 0) {
    return `(${kind} at ${time(e.at)}, not picked up)`;
  }
  const span = callSpanOf(e);
  return `(${kind} ${time(span.at)}–${time(span.until)}, ${lengthOf(seconds)})`;
}

/** A call's exact span, to the second, as ISO instants: its start and its start plus its length (none when unseen). */
export const callSpanOf = ({ at, phoneCall }: SourceEvent) => ({
  at: iso(Date.parse(at)),
  until: iso(Date.parse(at) + (phoneCall?.seconds ?? 0) * SECOND),
});

/** A message's text as every reader shows it: a phone call is its call line. */
export const textOf = (e: SourceEvent) => (e.phoneCall ? callLine(e) : e.text);

/**
 * A 1:1 chat's person: its other senders, else its key, else its name (never a mail subject or a call-only display name).
 * `isDirect` uses the source's group predicate, else more than one other sender means a group.
 */
export function chatPerson(list: SourceEvent[], resolve: Resolve) {
  const [first] = list;
  return first
    ? oneToOnePersonOf(
        {
          chat: first.chat,
          chatName: list.every((e) => e.phoneCall) ? null : first.chatName,
          others: new Set(
            list
              .filter((e) => !e.fromMe)
              .map((e) => resolve(e.sender, e.source) ?? e.sender)
          ),
          source: first.source,
        },
        resolve
      )
    : null;
}

/** `chatPerson`'s rule over what a reader holds: the chat, its name, and its other writers as resolved (else as written). */
export function oneToOnePersonOf(
  o: {
    chat: string;
    chatName?: string | null;
    others: ReadonlySet<string>;
    source: SourceName;
  },
  resolve: Resolve
) {
  if (!isDirect(o.source, o.chat, o.others.size)) {
    return null;
  }
  const named =
    o.chatName && kindOf(o.source) !== "mail" ? resolve(o.chatName) : null;
  const person = [...o.others].find((x) => x.startsWith("person:"));
  // A chat only he wrote in is with whoever its key names (its source's `handleOf`: a WhatsApp id holds a phone).
  const keyed = sourceOf(o.source).handleOf?.(o.chat) ?? o.chat;
  return (
    person ?? (o.others.size === 0 ? resolve(keyed, o.source) : null) ?? named
  );
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
  const written = isWithPeople(kind);
  const lines = sorted.map((e) =>
    lineOf(e.at, speakerOf(e.source, e, resolve), e.sender, redact(e.text))
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
      hash: messagesHash(sorted, marked),
      id: dayUnitId(first),
      key: first.chat,
      ...(marked.length > 0 ? { marked } : {}),
      people: [
        ...new Set(
          sorted.flatMap((e) => {
            if (e.fromMe) {
              return [
                OWNER,
                ...(e.photo?.pictured ?? []).map(
                  (p) => `${UNKNOWN}${p.handle ?? p.name}`
                ),
              ];
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

/** A device-day, measurement-day or photo-day, made like a chat-day of its lines; its text is their body (a device-day's its totals), its title their headline. */
function activityDay(
  list: SourceEvent[],
  { body, headline, lines }: ReturnType<typeof deviceDayText>
): Built {
  list.sort((a, b) => a.at.localeCompare(b.at));
  const { messages, unit } = chatDay(
    lines.length > 0 ? lines : list,
    () => null
  );
  const title = `${unit.title}: ${headline}`;
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
      stats: { ...unit.stats, chars: body.length },
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
  messages: (Pick<Message, "bulk" | "fromMe" | "sender"> &
    Partial<Pick<Message, "transaction">>)[];
  unit: Pick<Unit, "source" | "title">;
}
/** Mail the owner never wrote in on that day, other than his agents' reports (the model judges those: he asked for their to-dos). */
const isMail = (t: Thread) =>
  kindOf(t.unit.source) === "mail" &&
  !t.messages.some((m) => m.fromMe || isAgentReport(m.sender));
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
/** A login code: a short message that says so, or a mail whose subject says it is one (a long mail with a promo code in it is not). */
const isOneTimeCodeOf = (
  m: Pick<Message, "text">,
  unit: Pick<Unit, "source" | "title">
) =>
  (m.text.length <= OTP_MAX && OTP.test(m.text)) ||
  (kindOf(unit.source) === "mail" &&
    CODE_SUBJECT.test(unit.title) &&
    m.text.length <= CODE_MAIL_MAX);
/**
 * An automated message, by what it says itself, true for anyone: a no-reply sender, a list or bulk header, or a login
 * code; a transaction (an order, a booking, a bank notice) never is: its facts and appointments are read.
 */
export const isAutomatedOf = (
  m: Pick<Message, "bulk" | "sender" | "text" | "transaction">,
  unit: Pick<Unit, "source" | "title">
) =>
  !m.transaction &&
  (isNoReply(m.sender) || Boolean(m.bulk) || isOneTimeCodeOf(m, unit));
/** A newsletter or marketing send (Mail saw a list id or an unsubscribe link) the owner never answered that day. */
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
  [
    "one-time-code",
    (b) =>
      b.messages.length > 0 &&
      b.messages.every((m) => isOneTimeCodeOf(m, b.unit)),
  ],
  ["newsletter", newsletter],
  // Automated mail (`isAutomatedOf`: no one answers it, no transaction in it) in a thread he never wrote in that day:
  // search still finds it. Whoever sent it is no test: a stranger's mail is read.
  [
    "automated",
    (b) =>
      isMail(b) &&
      b.messages.length > 0 &&
      b.messages.every((m) => isAutomatedOf(m, b.unit)),
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

/**
 * A source's events since `since`: a repo's are read with his directory (whose repos are whose, who he is) and carry no
 * files (a commit without a subject is dropped, like any empty message), and every source's words as a deletion leaves them.
 */
export const readEventsOf = (
  s: Read,
  since: Date,
  map: { me: Person; repos: RepoMap },
  before?: Date
) =>
  deletedReadOf(
    s.name,
    s.kind === "repo"
      ? (at: Date, until?: Date) => s.read(at, map, until)
      : s.read
  )(since, before);

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
    readEventsOf(
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

/** Lifelog person id -> the name in the directory, for the people `truth/people.yaml` holds a `lifelog` handle for. */
export const lifelogNames = (truth: Truth) =>
  new Map(
    truth.people.flatMap((p) =>
      p.handles.lifelog ? [[p.handles.lifelog, p.name]] : []
    )
  );
