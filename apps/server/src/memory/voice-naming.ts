import { DAY, HOUR } from "../core/clock";
import { newestWithin } from "../core/lists";
import { redact } from "../core/redact";
import { NamedVoice, VOICE_NAMING_READ } from "../records/read-reply";
import type { SourceEvent } from "../records/source";
import { openStore, parseTurnRef, withStore } from "../sources/lifelog";
import {
  ownAnswerOf,
  readVoices,
  type VoiceRow,
  voiceKey,
  voiceNamesIn,
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
  HEARD_WITHIN,
  isHeardAround,
  namingBriefOf,
  overlappingPhoneCallsOf,
  possibleSpeakersOf,
} from "./naming-context";
import {
  type Asked,
  makeReplies,
  READS,
  readReplyIndex,
  replyOf,
} from "./read-replies";
import { begin, chunks, readsOf, type Step } from "./run";
import { partLine, type SpokenPart } from "./spoken-conversations";
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

// The voice naming (docs/glossary.md): one read of each part of a long conversation recorded in person, saying for each
// voice no one named the person it probably is, from the lines and the day around them. A guess stays a guess: it is
// stored by `memory/read-replies.ts` after `checkedVoices` (never as the model gave it) and acts on nothing: no person is
// created or folded, nothing goes to lifelog, no line any step reads changes. What is pending is derived from the
// stored lines (`replyOf`) and the keys of the part now (`unnamedTurnKey`); the night asks, behind his `voiceNaming`
// setting, which gates the calls and never the reading of what is stored.

/** The most calls a night makes: a first build takes several nights, the newest first. */
export const VOICE_NAMING_CALLS = 40;
/** The one-to-one messages of the possible speakers a call shows: this long either side of the part, this many characters. */
const MESSAGES_AROUND = 3 * HOUR;
const MESSAGES_CHARS = 4000;
const { prompt: PROMPT } = READS.voice_naming;

/** What the model is shown for one part. */
export interface NamingInput {
  calls: string[];
  day: string;
  /** Each line `[n] HH:MM who: text`, a voice nobody named as `V1`, `V2`… (`voiceTokensOf`). */
  lines: string[];
  /** The one-to-one messages of the people offered, around the part. */
  messages: string[];
  /** The people offered: who could be there (`possibleSpeakersOf`), each with a short brief. */
  people: { brief: string; name: string; ref: string }[];
  /** For a voice: whom it sounds like among the people offered, from its sound alone. */
  voices: { likeness: { person: string; score: number }[]; voice: string }[];
}

const LINE_WHO = /^\[\d+\] \S+ (\S+): /;
const TOKEN = /^V\d+$/;

/** What code knows of a part and the model is not shown. */
interface Known {
  /** The `V` tokens of the voices his own answer says name no one: stored `unknown`, whatever the model said. */
  noOne: Set<string>;
  /** The people on a call that overlaps the part (refs). */
  onCall: string[];
}

/**
 * The model's reply checked against what it was shown: an entry stays only when its voice is a `V` of the lines, its
 * person is one of the refs offered, `me` or `unknown`, every line it cites exists and is a line of that voice, and its
 * confidence is one of sure, likely, weak; a voice is answered once. Anything else is dropped, never kept as a name. A
 * person named `likely` who is neither in that voice's likeness nor on a call that overlaps the part (`known`) is
 * stored `weak`. A voice his own answer says names no one is stored `unknown` at `weak` (nothing for a reader to show),
 * whatever the model said and even when it left the voice out. A reply with no list of voices is not a reply (it
 * throws, so it is stored nowhere and asked again).
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
    const sounds = input.voices
      .find((x) => x.voice === e.voice)
      ?.likeness.some((l) => l.person === e.person);
    return [
      e.confidence === "likely" &&
      offered.has(e.person) &&
      !sounds &&
      !known.onCall.includes(e.person)
        ? { ...e, confidence: "weak" as const }
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
  return { voices: [...kept, ...answered] };
}

/** The recording a turn key is of. */
const jobOf = (key: string) => parseTurnRef(turnRefOf(key))?.jobId ?? "";

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
  /** The newest name lifelog gave each person id (`voiceNamesIn`), for the id the directory does not know. */
  names: ReadonlyMap<string, string>;
  /** The people who spoke in person, by local day. */
  onDay: Map<string, Set<string>>;
  people: People;
  /** Persons in a photo, by day. */
  pictured: Map<string, Set<string>>;
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
  const first = parts.reduce(
    (a, p) => (p.at < a ? p.at : a),
    parts[0]?.at ?? ""
  );
  const since = new Date(Date.parse(first) - HEARD_WITHIN);
  const events = chats ?? (await readWithPeople(since)).events;
  const direct = directChats(events, people.resolve);
  const { names, turns } = await withStore(
    (store) => ({
      names: voiceNamesIn(store),
      turns: heardTurnsOf(store, people.resolve, since),
    }),
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
    names,
    onDay: heardOnDayOf(heard),
    people,
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

/** The one-to-one messages of the people offered, around a part, nearest first up to `MESSAGES_CHARS`, then in time order. */
function messagesAround(offered: string[], part: SpokenPart, c: Context) {
  const [from, to] = [
    Date.parse(part.at) - MESSAGES_AROUND,
    Date.parse(part.until) + MESSAGES_AROUND,
  ];
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

/**
 * A part as the naming read asks it, or null when no voice is left unnamed. `began` is when its conversation began,
 * `voices` what lifelog says of the voices of its recordings. Who could be there (`possibleSpeakersOf`) decides which
 * names to trust: a voice lifelog named by sound as someone who could not be there (`basis: recognized`) is shown as a
 * `V` token like an unnamed one, and may be guessed again. A voice is its `V` by `voiceTokensOf` over the keys it is
 * stored by (`unnamedTurnKey` for those, the turn's own key for the rest). `hidden` (the score's hidden run, never the
 * night) is voices (`voiceKey`) shown as unnamed whatever lifelog says of them (their likeness stays: lifelog's route already judges it without the span's own exemplars), and whose answers
 * name no one as possible; a part with none of them is null.
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
  const calls = overlappingPhoneCallsOf(
    c.events,
    part.at,
    part.until,
    c.people
  );
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
  const tokens = voiceTokensOf(keys.filter((_, n) => unnamed[n]));
  // The hidden run asks only the parts holding a voice it hid.
  if (
    tokens.size === 0 ||
    (hidden && ![...tokens.keys()].some((v) => hidden.has(v)))
  ) {
    return null;
  }
  const input: NamingInput = {
    calls: calls.lines,
    day: part.day,
    lines: part.voices.map((v, n) => {
      const who = unnamed[n]
        ? (tokens.get(voiceKey(jobAt(n), v.label)) ?? "")
        : (v.name ?? "me");
      return partLine(n, v, who);
    }),
    messages: messagesAround(possible, part, c),
    people: possible.map((ref) => ({
      brief: briefOf(ref, part, [began, ended], c),
      name: c.people.nameOf(ref),
      ref,
    })),
    voices: [...tokens].map(([voice, token]) => ({
      likeness: (rows.get(voice)?.likeness ?? []).flatMap((l) => {
        const person = voicePersonOf(
          c.people.resolve,
          l.personId,
          c.names.get(l.personId)
        );
        return person && could.has(person)
          ? [{ person, score: Math.round(l.score * 100) / 100 }]
          : [];
      }),
      voice: token,
    })),
  };
  // A voice he answered "A stranger", not relevant or otherwise as no one is never guessed (the hidden run's own are).
  const noOne = new Set(
    part.voices.flatMap((v, n) => {
      const key = voiceKey(jobAt(n), v.label);
      const own = unnamed[n] && !hidden?.has(key) && ownAnswerOf(rows.get(key));
      return own && own.kind !== "person" ? [tokens.get(key) ?? ""] : [];
    })
  );
  return { input, keys, known: { noOne, onCall: calls.people } };
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
 * The calls due for the parts of the conversations the summaries examine (`readConversationSummaryWork`): one read of
 * lifelog's voices per conversation, so a Lifelog Host without the route (404) stops it with a clear message. `counts` is what is
 * pending before the night's cap. With `again` a part is due even when a reply is stored (the newest line is the current one). With `hiding` (the score's hidden run) the voices he answered, a person, not relevant or "A stranger",
 * as a whole voice and not mixed, are shown as unnamed (`namingOf`'s `hidden`), and only the parts holding one are asked.
 */
export async function readVoiceNamingWork(
  found: ConversationSummaryWork,
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
    for (const group of chunks(talks, 8)) {
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
