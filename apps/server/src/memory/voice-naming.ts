import { HOUR } from "../core/clock";
import { newestWithin } from "../core/lists";
import { redact } from "../core/redact";
import { NamedVoice, VOICE_NAMING_READ } from "../records/read-reply";
import type { SourceEvent } from "../records/source";
import {
  openStore,
  parseTurnRef,
  speakerTurns,
  withStore,
} from "../sources/lifelog";
import { readVoices, type VoiceRow, voiceKey } from "../sources/lifelog-voices";
import { directChats, readWithPeople } from "./closeness";
import { type ConversationSummaryWork, refOf } from "./conversation-summaries";
import { readDetailsOf } from "./details";
import { withOf } from "./exchange-reads";
import { observationStatusOf, READ_REPLIES, readUnitsOf } from "./memory-files";
import {
  type Brief,
  HEARD_WITHIN,
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
import { OWNER } from "./read-truth";
import { begin, chunks, type Step } from "./run";
import { partLine, type SpokenPart } from "./spoken-conversations";
import { clip, unnamedTurnKey, voiceTokensOf } from "./units";
import type { People } from "./who";
import { observationsNow } from "./who";
import { messageLine } from "./words";
import { localDate, time } from "./zones";

// The voice naming (docs/glossary.md): one read of each part of a long conversation recorded in person, saying for each
// voice no one named the person it probably is, from the lines and the day around them. A guess stays a guess: it is
// stored by `memory/read-replies.ts` as the model gave it (after `checkedVoices`) and acts on nothing: no person is
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

/**
 * The model's reply checked against what it was shown: an entry stays only when its voice is a `V` of the lines, its
 * person is one of the refs offered, `me` or `unknown`, every line it cites exists and is a line of that voice, and its
 * confidence is one of sure, likely, weak; a voice is answered once. Anything else is dropped, never kept as a name. A
 * reply with no list of voices is not a reply (it throws, so it is stored nowhere and asked again).
 */
export function checkedVoices(reply: unknown, input: NamingInput) {
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
      seen.has(e.voice) ||
      !(e.person === "me" || e.person === "unknown" || offered.has(e.person)) ||
      !e.lines.every((n) => input.lines[n]?.match(LINE_WHO)?.[1] === e.voice) ||
      !TOKEN.test(e.voice)
    ) {
      return [];
    }
    seen.add(e.voice);
    return [e];
  });
  return { voices: kept };
}

/** What every part is read against, read once for a run. */
interface Context {
  /** The local days each person spoke on a call he picked up, by person ref, sorted. */
  callDays: Map<string, string[]>;
  /** The local days each person spoke in person in his recordings, by person ref, sorted. */
  days: Map<string, string[]>;
  detailsFor: ReturnType<typeof readDetailsOf>;
  /** The messages of each person's one-to-one chats and mail threads. */
  direct: Map<string, SourceEvent[]>;
  events: SourceEvent[];
  /** Persons in an active fact whose evidence is not a recording, by day. */
  facts: Map<string, Set<string>>;
  heard: { at: string; ref: string }[];
  /** The people who spoke in person, by local day. */
  onDay: Map<string, Set<string>>;
  people: People;
  /** Persons in a photo, by day. */
  pictured: Map<string, Set<string>>;
}

const addTo = <K, V>(m: Map<K, Set<V>>, k: K, v: V) =>
  m.set(k, (m.get(k) ?? new Set<V>()).add(v));

/** The days each person spoke in person (sorted), and who spoke on each day. */
function heardDaysOf(heard: { at: string; ref: string }[]) {
  const onDay = new Map<string, Set<string>>();
  for (const h of heard) {
    addTo(onDay, localDate(h.at), h.ref);
  }
  const days = new Map<string, string[]>();
  for (const [day, refs] of onDay) {
    for (const ref of refs) {
      days.set(ref, [...(days.get(ref) ?? []), day]);
    }
  }
  for (const list of days.values()) {
    list.sort();
  }
  return { days, onDay };
}

/** The people pictured in a photo of each of `dates`, and those in an active fact of that day that no recording is evidence of. */
async function readDayFacts(dates: string[], people: People) {
  const pictured = new Map<string, Set<string>>();
  for (const u of readUnitsOf(dates).filter((x) => x.source === "photos")) {
    for (const p of u.people.map(people.refOf)) {
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

async function readContext(
  parts: SpokenPart[],
  people: People,
  open = openStore
): Promise<Context> {
  const first = parts.reduce(
    (a, p) => (p.at < a ? p.at : a),
    parts[0]?.at ?? ""
  );
  const since = new Date(Date.parse(first) - HEARD_WITHIN);
  const { events } = await readWithPeople(since);
  const heard = (
    await withStore((store) => speakerTurns(store, since), open)
  ).flatMap((t) => {
    const ref =
      people.resolve(t.id) ?? (t.name ? people.resolve(t.name) : null);
    return ref && ref !== OWNER ? [{ at: t.at, ref }] : [];
  });
  const direct = directChats(events, people.resolve);
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
    ...heardDaysOf(heard),
    ...(await readDayFacts([...new Set(parts.map((p) => p.day))], people)),
    detailsFor: readDetailsOf(people),
    direct,
    events,
    heard,
    people,
  };
}

/** A person's brief for a part: how he has met them in the 90 days before, who is often there too, and what his directory holds. */
function briefOf(ref: string, part: SpokenPart, c: Context) {
  const from = localDate(
    new Date(Date.parse(part.at) - HEARD_WITHIN).toISOString()
  );
  const recent = (list: string[] = []) =>
    list.filter((d) => d >= from && d < part.day);
  const inPerson = recent(c.days.get(ref));
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
 * night) is voices (`voiceKey`) shown as unnamed whatever lifelog says of them, with no likeness, and whose answers
 * name no one as possible; a part with none of them is null.
 */
export function namingOf(
  part: SpokenPart,
  began: string,
  voices: VoiceRow[],
  c: Context,
  hidden?: Set<string>
) {
  const jobOf = (n: number) =>
    parseTurnRef(refOf(part.keys[n] as string))?.jobId ?? "";
  const rows = new Map(
    voices.map((v) => [voiceKey(v.jobId, v.speakerLabel), v])
  );
  const jobs = new Set(part.keys.map((_, n) => jobOf(n)));
  const calls = overlappingPhoneCallsOf(
    c.events,
    part.at,
    part.until,
    c.people
  );
  const possible = possibleSpeakersOf(
    {
      answered: voices.flatMap((v) =>
        jobs.has(v.jobId) &&
        !hidden?.has(voiceKey(v.jobId, v.speakerLabel)) &&
        v.basis === "owner" &&
        v.status === "person" &&
        v.personId
          ? (c.people.resolve(v.personId) ?? [])
          : []
      ),
      facts: [...(c.facts.get(part.day) ?? [])],
      heard: c.heard,
      onCall: calls.people,
      pictured: [...(c.pictured.get(part.day) ?? [])],
    },
    part.at,
    began
  );
  const could = new Set(possible);
  const unnamed = part.voices.map((v, n) => {
    if (v.owner) {
      return false;
    }
    if (!v.name || hidden?.has(voiceKey(jobOf(n), v.label))) {
      return true;
    }
    const ref = v.from ? c.people.resolve(v.from) : null;
    return (
      rows.get(voiceKey(jobOf(n), v.label))?.basis === "recognized" &&
      !(ref && could.has(ref))
    );
  });
  const keys = part.keys.map((k, n) =>
    unnamed[n] ? unnamedTurnKey(refOf(k), part.voices[n]?.label ?? "") : k
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
        ? (tokens.get(voiceKey(jobOf(n), v.label)) ?? "")
        : (v.name ?? "me");
      return partLine(n, v, who);
    }),
    messages: messagesAround(possible, part, c),
    people: possible.map((ref) => ({
      brief: briefOf(ref, part, c),
      name: c.people.nameOf(ref),
      ref,
    })),
    voices: [...tokens].map(([voice, token]) => ({
      likeness: (hidden?.has(voice)
        ? []
        : (rows.get(voice)?.likeness ?? [])
      ).flatMap((l) => {
        const person = c.people.resolve(l.personId);
        return person && could.has(person)
          ? [{ person, score: Math.round(l.score * 100) / 100 }]
          : [];
      }),
      voice: token,
    })),
  };
  return { input, keys };
}

/** The voices (`voiceKey`) he answered whole, a person or not relevant, and not mixed: what the score's hidden run hides. */
const hiddenOf = (rows: VoiceRow[]) =>
  new Set(
    rows.flatMap((v) =>
      v.basis === "owner" &&
      !v.mixed &&
      (v.status === "person" || v.status === "not_relevant")
        ? [voiceKey(v.jobId, v.speakerLabel)]
        : []
    )
  );

/** What a run would do: the parts with a voice to name, and the calls due (those with no stored reply under their keys now). */
export type VoiceNamingWork = Awaited<ReturnType<typeof readVoiceNamingWork>>;

/**
 * The calls due for the parts of the conversations the summaries examine (`readConversationSummaryWork`): one read of
 * lifelog's voices per part, so a Lifelog Host without the route (404) stops it with a clear message. `counts` is what is
 * pending before the night's cap. With `hiding` (the score's hidden run) the voices he answered, a person or not relevant,
 * as a whole voice and not mixed, are shown as unnamed (`namingOf`'s `hidden`), and only the parts holding one are asked.
 */
export async function readVoiceNamingWork(
  found: ConversationSummaryWork,
  people: People,
  where = READ_REPLIES,
  open = openStore,
  hiding = false
) {
  const parts = found.parts.flatMap((c) =>
    c.map((part) => ({ began: c[0]?.at ?? part.at, part }))
  );
  const asked: Asked[] = [];
  let named = 0;
  if (parts.length > 0) {
    const c = await readContext(
      parts.map((p) => p.part),
      people,
      open
    );
    const index = readReplyIndex(where);
    for (const group of chunks(parts, 8)) {
      // biome-ignore lint/performance/noAwaitInLoops: a few parts at a time
      const voices = await Promise.all(
        group.map(({ part }) =>
          readVoices(new Date(part.at), new Date(Date.parse(part.until) + 1))
        )
      );
      for (const [i, { began, part }] of group.entries()) {
        const rows = voices[i] ?? [];
        const n = namingOf(
          part,
          began,
          rows,
          c,
          hiding ? hiddenOf(rows) : undefined
        );
        if (n) {
          named += 1;
          if (!replyOf(n.keys, VOICE_NAMING_READ, index)) {
            asked.push({
              at: part.at,
              call: {
                firstAt: part.at,
                input: n.input,
                keys: n.keys,
                starts: [0],
              },
              read: VOICE_NAMING_READ,
            });
          }
        }
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
  const made = await makeReplies(
    asked,
    {
      ...run,
      ask: async (o) => checkedVoices(await run.ask(o), o.input as NamingInput),
    },
    where
  );
  return run.end({ calls: asked.length, stored: made.stored });
}
