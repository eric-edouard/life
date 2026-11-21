import { DAY, iso } from "../core/clock";
import { newestWithin } from "../core/lists";
import { redact } from "../core/redact";
import { NamedVoice, VOICE_NAMING_READ } from "../records/read-reply";
import type { SourceEvent } from "../records/source";
import { openStore, parseTurnRef, withStore } from "../sources/lifelog";
import {
  type NamingQueueItem,
  ownAnswerOf,
  readNamingQueueNow,
  readVoices,
  type VoiceRow,
  voiceKey,
  voiceNamesOf,
} from "../sources/lifelog-voices";
import {
  directChats,
  type HeardTurn,
  heardTurnsOf,
  readWithPeople,
} from "./closeness";
import type { ConversationSummaryWork } from "./conversation-summaries";
import { readDetailsOf } from "./details";
import { withOf } from "./exchange-reads";
import { observationStatusOf, READ_REPLIES, readUnitsOf } from "./memory-files";
import {
  type Brief,
  CALL_SLACK,
  EXPECTED_BEFORE,
  expectedCompanyOf,
  expectedWindowOf,
  HEARD_WITHIN,
  isHeardAround,
  isNameSaid,
  isPlannedBefore,
  namingBriefOf,
  namingConfidenceOf,
  overlappingPhoneCallsOf,
  possibleSpeakersOf,
  SOUNDS_LIKE,
  voiceGroupsOf,
} from "./naming-context";
import {
  type Asked,
  makeReplies,
  READS,
  readReplyIndex,
  readTogetherSoon,
  replyOf,
} from "./read-replies";
import { begin, chunks, readsOf, type Step } from "./run";
import {
  isSummarised,
  partLine,
  type SpokenPart,
} from "./spoken-conversations";
import {
  callSpanOf,
  clip,
  turnRefOf,
  unnamedTurnKey,
  voiceTokensOf,
} from "./units";
import type { People } from "./who";
import { observationsNow, voicePersonOf } from "./who";
import { messageLine } from "./words";
import { localDate, time } from "./zones";

// The voice naming (docs/glossary.md): one read of each part of a conversation recorded in person (a long one, or a
// short one near a call or a plan: `isWorthNaming`), saying for each voice group no one named the person it probably is,
// from the lines and the day around them, how sure counted by code (`namingConfidenceOf`). A guess stays a guess: it is
// stored by `memory/read-replies.ts` after `checkedVoices` (never as the model gave it) and acts on nothing: no person is
// created or folded, nothing goes to lifelog, no line any step reads changes. What is pending is derived from the
// stored lines (`replyOf`) and the keys of the part now (`unnamedTurnKey`); the night asks, behind his `voiceNaming`
// setting, which gates the calls and never the reading of what is stored.

/** The most calls a night makes: a first build takes several nights, the newest first. */
export const VOICE_NAMING_CALLS = 40;
/** The one-to-one messages of the possible speakers a call shows, over the expected company's window: this many characters. */
const MESSAGES_CHARS = 4000;
const { prompt: PROMPT } = READS.voice_naming;

/** What the model is shown for one part. */
export interface NamingInput {
  calls: string[];
  day: string;
  /** Each line `[n] HH:MM who: text`, a voice group nobody named as `V1`, `V2`… (`voiceGroupsOf`). */
  lines: string[];
  /** The one-to-one messages of the people offered, from 6 hours before the conversation to its end, nearest first. */
  messages: string[];
  /** The people offered: who could be there (`possibleSpeakersOf`), each with a short brief and the titles of a chat of theirs in the window. */
  people: { brief: string; chats?: string[]; name: string; ref: string }[];
  /** For a voice group: the name Voice heard for it, and whom it sounds like among the people offered, from its sound alone. */
  voices: {
    heard?: string;
    likeness: { person: string; score: number }[];
    voice: string;
  }[];
}

const LINE_WHO = /^\[\d+\] \S+ (\S+): /;
const TOKEN = /^V\d+$/;

/** What code knows of a part and the model is not shown. */
interface Known {
  /** For a group `V` and a person offered (`${voice} ${person}`): the signals code counted, and whether one points to someone else. */
  evidence: Map<string, { elsewhere: boolean; signals: number }>;
  /** Each group `V`'s recording voices, by the `V` they are stored as (`voiceTokensOf` of the part's unnamed keys), with their lines; a `V` not here is stored as itself. */
  members: Map<string, Map<string, number[]>>;
  /** The group `V`s of the voices his own answer says name no one: stored `unknown`, whatever the model said. */
  noOne: Set<string>;
}

/**
 * The model's reply checked against what it was shown: an entry stays only when its voice is a `V` of the lines, its
 * person is one of the refs offered, `me` or `unknown`, every line it cites exists and is a line of that voice, and its
 * confidence is one of sure, likely, weak; a voice is answered once. Anything else is dropped, never kept as a name. A
 * person's confidence is counted by code (`namingConfidenceOf` over `known.evidence`). A voice his own answer says names
 * no one is stored `unknown` at `weak` (nothing for a reader to show), whatever the model said and even when it left the
 * voice out. A group's entry is stored as one entry per recording voice of it (`known.members`), citing its lines of that
 * voice, else that voice's first line. A reply with no list of voices is not a reply (it throws, so it is stored nowhere
 * and asked again).
 */
export function checkedVoices(
  reply: unknown,
  input: NamingInput,
  known: Known
) {
  const { voices } = (reply ?? {}) as { voices?: unknown };
  if (!Array.isArray(voices)) {
    throw new Error("the reply has no list of voices");
  }
  const offered = new Set(input.people.map((p) => p.ref));
  const seen = new Set<string>();
  const kept = voices.flatMap((v) => {
    const e = NamedVoice.safeParse(v).data;
    if (
      !e ||
      known.noOne.has(e.voice) ||
      seen.has(e.voice) ||
      !(e.person === "me" || e.person === "unknown" || offered.has(e.person)) ||
      !e.lines.every((n) => input.lines[n]?.match(LINE_WHO)?.[1] === e.voice) ||
      !TOKEN.test(e.voice)
    ) {
      return [];
    }
    seen.add(e.voice);
    const found = known.evidence.get(`${e.voice} ${e.person}`);
    return [
      offered.has(e.person)
        ? {
            ...e,
            confidence: namingConfidenceOf(
              e.confidence,
              found?.signals ?? 0,
              found?.elsewhere ?? false
            ),
          }
        : e,
    ];
  });
  const answered = [...known.noOne].flatMap((voice) => {
    const line = input.lines.findIndex((l) => l.match(LINE_WHO)?.[1] === voice);
    return line < 0
      ? []
      : [
          {
            confidence: "weak" as const,
            lines: [line],
            person: "unknown",
            voice,
          },
        ];
  });
  const stored = [...kept, ...answered].flatMap((e) => {
    const recorded = known.members.get(e.voice);
    return recorded
      ? [...recorded].map(([voice, own]) => {
          const cited = e.lines.filter((n) => own.includes(n));
          return {
            ...e,
            lines: cited.length > 0 ? cited : own.slice(0, 1),
            voice,
          };
        })
      : [e];
  });
  return { voices: stored };
}

/** The recording a turn key is of. */
export const jobOf = (key: string) => parseTurnRef(turnRefOf(key))?.jobId ?? "";

/** What every part is read against, read once for a run. */
interface Context {
  /** The local days each person spoke on a call he picked up, by person ref, sorted. */
  callDays: Map<string, string[]>;
  detailsFor: ReturnType<typeof readDetailsOf>;
  /** The messages of each person's one-to-one chats and mail threads. */
  direct: Map<string, SourceEvent[]>;
  events: SourceEvent[];
  /** Persons in an active fact whose evidence is not a recording, by day. */
  facts: Map<string, Set<string>>;
  heard: { at: string; ref: string }[];
  /** The newest name lifelog gave each person id (`voiceNamesOf`), for the id the directory does not know. */
  names: Map<string, string>;
  /** The people who spoke in person, by local day. */
  onDay: Map<string, Set<string>>;
  people: People;
  /** Persons in a photo, by day. */
  pictured: Map<string, Set<string>>;
  /** Voice's naming queue item of each voice in one (`voiceKey`): its group. */
  queue: Map<string, NamingQueueItem>;
  /** The keys of the messages the arrival trigger read as together soon (`readTogetherSoon`). */
  together: ReadonlySet<string>;
}

const addTo = <K, V>(m: Map<K, Set<V>>, k: K, v: V) =>
  m.set(k, (m.get(k) ?? new Set<V>()).add(v));

/** Who spoke in person on each local day. */
function heardOnDayOf(heard: { at: string; ref: string }[]) {
  const onDay = new Map<string, Set<string>>();
  for (const h of heard) {
    addTo(onDay, localDate(h.at), h.ref);
  }
  return onDay;
}

/** The people pictured in a photo of each of `dates`, and those in an active fact of that day that no recording is evidence of. */
async function readDayFacts(dates: string[], people: People) {
  const pictured = new Map<string, Set<string>>();
  for (const u of readUnitsOf(dates).filter((x) => x.source === "photos")) {
    for (const p of u.people.map((x) => people.refOf(x, u.source))) {
      addTo(pictured, u.date, p);
    }
  }
  const facts = new Map<string, Set<string>>();
  const { observations, statusInputs } = await observationsNow(people);
  for (const o of observations) {
    if (
      dates.includes(o.date) &&
      o.source.channel !== "lifelog" &&
      observationStatusOf(o, statusInputs).state === "active"
    ) {
      for (const s of o.subjects) {
        addTo(facts, o.date, s);
      }
    }
  }
  return { facts, pictured };
}

/**
 * The turns of people he heard in person, of the recordings since `since`: those of a voice his own answer named
 * (lifelog's `owner` basis, from `/speakers/voices` for each day with such a turn) that did not fall inside a phone
 * call he picked up with that same person (`direct`: his one-to-one chats). A match by lifelog's sound never makes
 * anyone possible. Lifelog's own kinds (phone, screen) are not read: they cover only the voices it could not name.
 */
async function readHeardInPerson(
  turns: HeardTurn[],
  direct: Map<string, SourceEvent[]>
) {
  const answered = new Set<string>();
  const days = [
    ...new Set(turns.map((t) => Math.floor(Date.parse(t.at) / DAY) * DAY)),
  ];
  for (const group of chunks(days, 8)) {
    // biome-ignore lint/performance/noAwaitInLoops: a few days at a time
    const rows = await Promise.all(
      group.map((d) => readVoices(new Date(d), new Date(d + DAY)))
    );
    for (const r of rows.flat()) {
      const own = ownAnswerOf(r);
      if (own?.kind === "person") {
        answered.add(`${r.jobId} ${own.personId}`);
      }
    }
  }
  // ponytail: a call is of a one-to-one chat; a person on a group call is not caught
  const onCall = (t: HeardTurn) =>
    (direct.get(t.ref) ?? []).some((e) => {
      const span = callSpanOf(e);
      const at = Date.parse(t.at);
      return at >= Date.parse(span.at) && at < Date.parse(span.until);
    });
  return turns.filter((t) => answered.has(`${t.job} ${t.id}`) && !onCall(t));
}

async function readContext(
  parts: SpokenPart[],
  people: People,
  open = openStore,
  chats?: SourceEvent[]
): Promise<Context> {
  const queue = new Map(
    (await readNamingQueueNow()).flatMap((item) =>
      item.voices.map((v) => [voiceKey(v.jobId, v.speakerLabel), item] as const)
    )
  );
  const first = parts.reduce(
    (a, p) => (p.at < a ? p.at : a),
    parts[0]?.at ?? ""
  );
  const since = new Date(Date.parse(first) - HEARD_WITHIN);
  const events = chats ?? (await readWithPeople(since)).events;
  const direct = directChats(events, people.resolve);
  const turns = await withStore(
    (store) => heardTurnsOf(store, people.resolve, since),
    open
  );
  const heard = (await readHeardInPerson(turns, direct)).map((t) => ({
    at: t.at,
    ref: t.ref,
  }));
  const callDays = new Map(
    [...direct].map(([ref, list]) => [
      ref,
      [
        ...new Set(
          list.flatMap((e) =>
            (e.phoneCall?.seconds ?? 0) > 0 ? [localDate(e.at)] : []
          )
        ),
      ].sort(),
    ])
  );
  return {
    callDays,
    ...(await readDayFacts([...new Set(parts.map((p) => p.day))], people)),
    detailsFor: readDetailsOf(people),
    direct,
    events,
    heard,
    names: voiceNamesOf(turns),
    onDay: heardOnDayOf(heard),
    people,
    queue,
    together: readTogetherSoon(iso(Date.parse(first) - EXPECTED_BEFORE)),
  };
}

/**
 * A person's brief for a part of the conversation running from `began` to `ended`: how he has met them within 90 days of
 * this day (in person: the turns that make them possible, `isHeardAround`; by call: the 90 days before), who is often
 * there too, and what his directory holds.
 */
function briefOf(
  ref: string,
  part: SpokenPart,
  [began, ended]: [string, string],
  c: Context
) {
  const from = localDate(
    new Date(Date.parse(part.at) - HEARD_WITHIN).toISOString()
  );
  const recent = (list: string[] = []) =>
    list.filter((d) => d >= from && d < part.day);
  const inPerson = [
    ...new Set(
      c.heard
        .filter(
          (h) => h.ref === ref && isHeardAround(h.at, part.at, began, ended)
        )
        .map((h) => localDate(h.at))
    ),
  ].sort();
  const withThem = new Map<string, number>();
  for (const day of inPerson) {
    for (const other of c.onDay.get(day) ?? []) {
      if (other !== ref) {
        withThem.set(other, (withThem.get(other) ?? 0) + 1);
      }
    }
  }
  const person = c.people.truth.people.find((p) => `person:${p.id}` === ref);
  const brief: Brief = {
    byCall: recent(c.callDays.get(ref)),
    details: c.detailsFor(ref),
    inPerson,
    language: person?.language,
    often: [...withThem]
      .toSorted((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 2)
      .map(([other]) => c.people.nameOf(other)),
    relation: withOf(ref.slice("person:".length), c.people).relation,
  };
  return namingBriefOf(brief);
}

/**
 * The one-to-one messages of the people offered, from `EXPECTED_BEFORE` before the conversation (`began`) to its end,
 * nearest the part first up to `MESSAGES_CHARS`, then in time order.
 */
function messagesAround(
  offered: string[],
  part: SpokenPart,
  [began, ended]: [string, string],
  c: Context
) {
  const [from, to] = expectedWindowOf(began, ended);
  const near = offered
    .flatMap((ref) =>
      (c.direct.get(ref) ?? []).flatMap((e) => {
        const at = Date.parse(e.at);
        return !e.phoneCall && at >= from && at <= to
          ? [
              {
                at: e.at,
                away: Math.max(
                  0,
                  Date.parse(part.at) - at,
                  at - Date.parse(part.until)
                ),
                line: messageLine(
                  time(e.at),
                  e.fromMe ? "me" : c.people.nameOf(ref),
                  clip(redact(e.text), 300)
                ),
              },
            ]
          : [];
      })
    )
    .toSorted((a, b) => a.away - b.away);
  let chars = 0;
  return near
    .filter((m) => {
      chars += m.line.length;
      return chars <= MESSAGES_CHARS;
    })
    .toSorted((a, b) => a.at.localeCompare(b.at))
    .map((m) => m.line);
}

/** When a turn began, from its key (`turnRef`'s instant). */
const turnAtOf = (key: string) =>
  Date.parse(turnRefOf(key).split("@")[1] ?? "");

/** The phone calls near [from, to), with `CALL_SLACK` either side (the phone's clock and the pendant's differ). */
const callsNear = (
  c: Pick<Context, "events" | "people">,
  from: string,
  to: string
) =>
  overlappingPhoneCallsOf(
    c.events,
    iso(Date.parse(from) - CALL_SLACK),
    iso(Date.parse(to) + CALL_SLACK),
    c.people
  );

/**
 * Whether a spoken conversation is worth a naming read: a long one (`isSummarised`) always; a short one only when a call
 * is near it (`callsNear`) or a plan to meet came before it began (`isPlannedBefore`: someone on the way).
 */
export function isWorthNaming(
  parts: SpokenPart[],
  c: Pick<Context, "direct" | "events" | "people" | "together">
) {
  const [began, ended] = [parts[0]?.at ?? "", parts.at(-1)?.until ?? ""];
  return (
    isSummarised(parts) ||
    callsNear(c, began, ended).lines.length > 0 ||
    [...c.direct.values()].some((list) =>
      isPlannedBefore(list, Date.parse(began), c.together)
    )
  );
}

/**
 * What code counts for a voice group (its lines `lines`, its recording voices `voices`) and each person offered: the
 * signals (a plan to meet before its first line, `isPlannedBefore`; a word of their name or chat title said
 * in a line not its own; on a call near the part; its sound like them: its queue item's `isLikely`, else, in no item, its
 * likeness at `SOUNDS_LIKE` or more), and whether a sound points to someone else. Keyed `${voice} ${person}`.
 */
function evidenceOf(
  part: SpokenPart,
  groups: ReturnType<typeof voiceGroupsOf>,
  o: {
    c: Context;
    chats: Map<string, string[]>;
    onCall: string[];
    possible: string[];
    rows: Map<string, VoiceRow>;
  }
) {
  const { c } = o;
  const refOf = (personId: string) =>
    voicePersonOf(c.people.resolve, personId, c.names.get(personId));
  const evidence = new Map<string, { elsewhere: boolean; signals: number }>();
  for (const [token, voices] of groups.members) {
    const lines = [...voices.values()].flat();
    const first = Math.min(...lines.map((n) => turnAtOf(part.keys[n] ?? "")));
    const others = part.voices.flatMap((v, n) =>
      lines.includes(n) ? [] : [v.text]
    );
    const item = c.queue.get([...voices.keys()][0] ?? "");
    const likely =
      item?.isLikely && item.personId ? refOf(item.personId) : null;
    const strong = new Set(
      [...voices.keys()].flatMap((v) =>
        (o.rows.get(v)?.likeness ?? []).flatMap((l) =>
          l.score >= SOUNDS_LIKE ? (refOf(l.personId) ?? []) : []
        )
      )
    );
    for (const person of o.possible) {
      const planned = isPlannedBefore(
        c.direct.get(person) ?? [],
        first,
        c.together
      );
      const named = isNameSaid(others, [
        c.people.nameOf(person),
        ...(o.chats.get(person) ?? []),
      ]);
      const sounds = item ? likely === person : strong.has(person);
      evidence.set(`${token} ${person}`, {
        elsewhere: item
          ? Boolean(likely && likely !== person)
          : [...strong].some((r) => r !== person),
        signals: [planned, named, o.onCall.includes(person), sounds].filter(
          Boolean
        ).length,
      });
    }
  }
  return evidence;
}

/**
 * A part as the naming read asks it, or null when no voice is left unnamed. `began` and `ended` bound its conversation,
 * `voices` what lifelog says of the voices of its recordings. Who could be there (`possibleSpeakersOf`, with his expected
 * company over the conversation, `expectedCompanyOf`) decides which names to trust: a voice lifelog named by sound as
 * someone who could not be there (`basis: recognized`) is shown as a `V` like an unnamed one, and may be guessed again.
 * A `V` is a voice group (`voiceGroupsOf`, Voice's naming queue items); its guess is stored under the keys of its
 * recording voices (`unnamedTurnKey` for those, the turn's own key for the rest). `hidden` (the score's hidden run,
 * never the night) is voices (`voiceKey`) shown as unnamed whatever lifelog says of them (their likeness stays:
 * lifelog's route already judges it without the span's own exemplars), and whose answers name no one as possible; a part
 * with none of them is null.
 */
export function namingOf(
  part: SpokenPart,
  [began, ended]: [string, string],
  voices: VoiceRow[],
  c: Context,
  hidden?: Set<string>
) {
  const jobAt = (n: number) => jobOf(part.keys[n] as string);
  const rows = new Map(
    voices.map((v) => [voiceKey(v.jobId, v.speakerLabel), v])
  );
  const calls = callsNear(c, part.at, part.until);
  const expected = expectedCompanyOf(c.direct, began, ended, c.together);
  const chats = new Map(expected.map((e) => [e.ref, e.chats]));
  const possible = possibleSpeakersOf(
    {
      answered: voices.flatMap((v) => {
        const own = ownAnswerOf(v);
        return own?.kind === "person" &&
          !hidden?.has(voiceKey(v.jobId, v.speakerLabel))
          ? (voicePersonOf(
              c.people.resolve,
              own.personId,
              c.names.get(own.personId)
            ) ?? [])
          : [];
      }),
      expected: expected.map((e) => e.ref),
      facts: [...(c.facts.get(part.day) ?? [])],
      heard: c.heard,
      onCall: calls.people,
      pictured: [...(c.pictured.get(part.day) ?? [])],
    },
    part.at,
    began,
    ended,
    c.people.isOrganization
  );
  const could = new Set(possible);
  const unnamed = part.voices.map((v, n) => {
    if (v.owner) {
      return false;
    }
    if (!v.name || hidden?.has(voiceKey(jobAt(n), v.label))) {
      return true;
    }
    const ref = voicePersonOf(c.people.resolve, v.from, v.name);
    return (
      rows.get(voiceKey(jobAt(n), v.label))?.basis === "recognized" &&
      !(ref && could.has(ref))
    );
  });
  const keys = part.keys.map((k, n) =>
    unnamed[n] ? unnamedTurnKey(turnRefOf(k), part.voices[n]?.label ?? "") : k
  );
  // The `V` each recording voice is stored as, the one numbering `voiceGuessesOf` reads back.
  const stored = voiceTokensOf(keys.filter((_, n) => unnamed[n]));
  // The hidden run asks only the parts holding a voice it hid.
  if (
    stored.size === 0 ||
    (hidden && ![...stored.keys()].some((v) => hidden.has(v)))
  ) {
    return null;
  }
  const groups = voiceGroupsOf(
    part.voices.map((v, n) =>
      unnamed[n] ? voiceKey(jobAt(n), v.label) : null
    ),
    (v) => c.queue.get(v)?.id
  );
  const likenessOf = (recorded: string[]) => {
    const best = new Map<string, number>();
    for (const l of recorded.flatMap((v) => rows.get(v)?.likeness ?? [])) {
      const person = voicePersonOf(
        c.people.resolve,
        l.personId,
        c.names.get(l.personId)
      );
      if (person && could.has(person)) {
        best.set(person, Math.max(best.get(person) ?? 0, l.score));
      }
    }
    return [...best].map(([person, score]) => ({
      person,
      score: Math.round(score * 100) / 100,
    }));
  };
  const input: NamingInput = {
    calls: calls.lines,
    day: part.day,
    lines: part.voices.map((v, n) =>
      partLine(n, v, groups.lineTokens[n] ?? v.name ?? "me")
    ),
    messages: messagesAround(possible, part, [began, ended], c),
    people: possible.map((ref) => ({
      brief: briefOf(ref, part, [began, ended], c),
      ...(chats.get(ref)?.length ? { chats: chats.get(ref) } : {}),
      name: c.people.nameOf(ref),
      ref,
    })),
    voices: [...groups.members].map(([token, recorded]) => {
      const heard = c.queue.get([...recorded.keys()][0] ?? "")?.name;
      return {
        ...(heard ? { heard } : {}),
        likeness: likenessOf([...recorded.keys()]),
        voice: token,
      };
    }),
  };
  // A voice he answered "A stranger", not relevant or otherwise as no one is never guessed (the hidden run's own are).
  const noOne = new Set(
    part.voices.flatMap((v, n) => {
      const key = voiceKey(jobAt(n), v.label);
      const own = unnamed[n] && !hidden?.has(key) && ownAnswerOf(rows.get(key));
      return own && own.kind !== "person" ? [groups.lineTokens[n] ?? ""] : [];
    })
  );
  const members = new Map(
    [...groups.members].map(([token, recorded]) => [
      token,
      new Map([...recorded].map(([v, lines]) => [stored.get(v) ?? "", lines])),
    ])
  );
  const evidence = evidenceOf(part, groups, {
    c,
    chats,
    onCall: calls.people,
    possible,
    rows,
  });
  return { input, keys, known: { evidence, members, noOne } };
}

/** The voices (`voiceKey`) he answered whole, a person, not relevant or "A stranger", and not mixed: what the score's hidden run hides. */
const hiddenOf = (rows: VoiceRow[]) =>
  new Set(
    rows.flatMap((v) => {
      const kind = ownAnswerOf(v)?.kind;
      return !v.mixed &&
        (kind === "person" || kind === "not_relevant" || kind === "unknown")
        ? [voiceKey(v.jobId, v.speakerLabel)]
        : [];
    })
  );

/** What a run would do: the parts with a voice to name, and the calls due (those with no stored reply under their keys now). */
export type VoiceNamingWork = Awaited<ReturnType<typeof readVoiceNamingWork>>;

/** One read of lifelog's voices for the whole of a conversation (not for each part), those of its own recordings. */
async function readConversationVoices(parts: SpokenPart[]) {
  const jobs = new Set(parts.flatMap((p) => p.keys.map((k) => jobOf(k))));
  const rows = await readVoices(
    new Date(parts[0]?.at ?? ""),
    new Date(Date.parse(parts.at(-1)?.until ?? "") + 1)
  );
  return rows.filter((v) => jobs.has(v.jobId));
}

/**
 * Whether a part's naming is already stored under its turns' keys as they stand (a voice nobody named kept as
 * `unnamedTurnKey`, any other as its own key), decided with no read of lifelog. A part with a voice lifelog named by
 * sound is not recognised here (rule 3 may have hidden it): it is read again until the night stops examining it.
 */
function isStored(part: SpokenPart, index: ReturnType<typeof readReplyIndex>) {
  const keys = part.keys.map((k, n) =>
    part.voices[n]?.name || part.voices[n]?.owner
      ? k
      : unnamedTurnKey(turnRefOf(k), part.voices[n]?.label ?? "")
  );
  return Boolean(replyOf(keys, VOICE_NAMING_READ, index));
}

/** The parts of one conversation with a voice to name, and the calls due among them (those with no stored reply under their keys now). */
function namingsOf(
  parts: SpokenPart[],
  due: SpokenPart[],
  voices: VoiceRow[],
  c: Context,
  index: ReturnType<typeof readReplyIndex>,
  { again, hiding }: { again?: boolean; hiding?: boolean }
) {
  const hidden = hiding ? hiddenOf(voices) : undefined;
  const namings = due.flatMap((part) => {
    const n = namingOf(
      part,
      [parts[0]?.at ?? part.at, parts.at(-1)?.until ?? part.until],
      voices,
      c,
      hidden
    );
    return n ? [{ n, part }] : [];
  });
  const asked: Asked[] = namings
    .filter(({ n }) => again || !replyOf(n.keys, VOICE_NAMING_READ, index))
    .map(({ n, part }) => ({
      at: part.at,
      call: {
        checked: (reply) => checkedVoices(reply, n.input, n.known),
        firstAt: part.at,
        input: n.input,
        keys: n.keys,
        reads: readsOf(part.units.map((unit) => ({ source: "lifelog", unit }))),
        starts: [0],
      },
      read: VOICE_NAMING_READ,
    }));
  return { asked, named: namings.length };
}

/**
 * The calls due for the parts of the conversations the summaries examine (`readConversationSummaryWork`) that are worth a
 * naming read (`isWorthNaming`): one read of
 * lifelog's voices per conversation, so a Lifelog Host without the route (404) stops it with a clear message. `counts` is what is
 * pending before the night's cap. With `again` a part is due even when a reply is stored (the newest line is the current one). With `hiding` (the score's hidden run) the voices he answered, a person, not relevant or "A stranger",
 * as a whole voice and not mixed, are shown as unnamed (`namingOf`'s `hidden`), and only the parts holding one are asked.
 */
export async function readVoiceNamingWork(
  found: Pick<ConversationSummaryWork, "parts">,
  people: People,
  where = READ_REPLIES,
  open = openStore,
  {
    again,
    chats,
    hiding,
  }: {
    again?: boolean;
    chats?: SourceEvent[];
    hiding?: boolean;
  } = {}
) {
  const asked: Asked[] = [];
  let named = 0;
  const index = readReplyIndex(where);
  // Due only if a voice could be named and nothing is stored for the part: decided before any read of lifelog.
  const talks = found.parts
    .map((parts) => ({
      due: parts.filter(
        (part) =>
          part.voices.some((v) => !v.owner) && (again || !isStored(part, index))
      ),
      parts,
    }))
    .filter((t) => t.due.length > 0);
  if (talks.length > 0) {
    const c = await readContext(
      talks.flatMap((t) => t.due),
      people,
      open,
      chats
    );
    const worth = talks.filter((t) => isWorthNaming(t.parts, c));
    for (const group of chunks(worth, 8)) {
      // biome-ignore lint/performance/noAwaitInLoops: a few conversations at a time
      const voices = await Promise.all(
        group.map((t) => readConversationVoices(t.parts))
      );
      for (const [i, t] of group.entries()) {
        const done = namingsOf(t.parts, t.due, voices[i] ?? [], c, index, {
          again,
          hiding,
        });
        asked.push(...done.asked);
        named += done.named;
      }
    }
  }
  return { asked, counts: { calls: asked.length, parts: named } };
}

/**
 * The night's voice namings: the newest of what is due up to `cap` calls, each reply checked (`checkedVoices`) and
 * stored. A call that fails costs that call only.
 */
export async function voiceNaming(
  work: Pick<VoiceNamingWork, "asked">,
  cap = VOICE_NAMING_CALLS,
  where = READ_REPLIES,
  step?: Step
) {
  const run =
    step ?? (await begin("voice-naming", "main", { prompts: [PROMPT] }));
  const asked = newestWithin(work.asked, cap, {
    at: (a) => a.at,
    size: () => 1,
  });
  const made = await makeReplies(asked, run, where);
  return run.end({ calls: asked.length, stored: made.stored });
}
