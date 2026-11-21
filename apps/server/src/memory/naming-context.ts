import { DAY, HOUR, MIN } from "../core/clock";
import { chatGroups, type SourceEvent } from "../records/source";
import type { DetailLine } from "./details";
import { OWNER } from "./read-truth";
import { callLine, callSpanOf, chatPerson, clip, holdsName } from "./units";
import type { People } from "./who";
import { offsetAt } from "./zones";

// What the voice naming read (`memory/voice-naming.ts`) is told about a conversation, made by code from his rules and
// never by a model (docs/glossary.md: calls, possible speaker, naming brief). Pure: the caller reads the data.

/** The calls a naming read is shown: at most this many characters. */
export const CALLS_CHARS = 600;
/** A person's naming brief: at most this many characters. */
export const BRIEF_CHARS = 300;
/** The most people a naming read offers. */
export const POSSIBLE_SPEAKERS = 12;
/** A person heard in person counts as a possible speaker for this long afterwards. */
export const HEARD_WITHIN = 90 * DAY;
/** A call this near a recording is near it: a phone's clock and the pendant's can be minutes apart. */
export const CALL_SLACK = 5 * MIN;
/** The expected company: his one-to-one chats and calls from this long before a conversation to its end. */
export const EXPECTED_BEFORE = 6 * HOUR;
/** A one-to-one message this long before a voice starts is a plan to meet: a signal, and what makes a short conversation worth a read. */
export const PLANNED_WITHIN = 2 * HOUR;
/** A likeness this strong is Voice's own bar for "sounds like them" (its `isLikely`). */
export const SOUNDS_LIKE = 0.65;

/**
 * His first rule: the phone calls that overlap [from, to), the ones that matter to who is in the room. A picked-up
 * call overlaps when its span does; one with no end seen when it starts inside; one not picked up never. `people`
 * are the person refs on them (a one-to-one chat's person, else the senders of the calls), `lines` how a model is shown
 * them, in time order, at most `CALLS_CHARS` characters.
 */
export function overlappingPhoneCallsOf(
  events: SourceEvent[],
  from: string,
  to: string,
  people: Pick<People, "nameOf" | "resolve">
) {
  const [start, end] = [Date.parse(from), Date.parse(to)];
  const overlaps = (e: SourceEvent) => {
    const began = Date.parse(e.at);
    if (!e.phoneCall || e.phoneCall.seconds === 0) {
      return false;
    }
    return e.phoneCall.seconds === undefined
      ? began >= start && began < end
      : began < end && Date.parse(callSpanOf(e).until) > start;
  };
  const found = [...chatGroups(events).values()].flatMap((chat) => {
    const calls = chat.filter(overlaps);
    const person = chatPerson(chat, people.resolve);
    const senders = (list: SourceEvent[]) =>
      list
        .filter((e) => !e.fromMe)
        .map((e) => people.resolve(e.sender, e.source));
    // A group call he started carries no one else's sender: the group's senders are who may be on it.
    const refs = person?.startsWith("person:")
      ? [person]
      : ([senders(calls), senders(chat)].find((s) => s.some(Boolean)) ?? []);
    const who = [
      ...new Set(refs.filter((r): r is string => !!r && r !== OWNER)),
    ];
    return calls.map((call) => ({ at: call.at, call, who }));
  });
  found.sort((a, b) => a.at.localeCompare(b.at));
  const lines: string[] = [];
  let chars = 0;
  for (const { call, who } of found) {
    const names = who.map((r) => people.nameOf(r)).join(", ");
    const line = `${callLine(call)} with ${names || "someone not known"}`;
    if (chars + line.length > CALLS_CHARS) {
      break;
    }
    chars += line.length;
    lines.push(line);
  }
  return { lines, people: [...new Set(found.flatMap((f) => f.who))] };
}

/**
 * The expected company of a conversation running from `began` to `ended`: everyone (a person ref, `direct`'s key) with a
 * one-to-one message or call from `EXPECTED_BEFORE` before it to its end, nearest to its start first, with the titles of
 * those chats.
 */
export function expectedCompanyOf(
  direct: Map<string, SourceEvent[]>,
  began: string,
  ended: string
) {
  const [start, end] = [Date.parse(began), Date.parse(ended)];
  return [...direct]
    .flatMap(([ref, events]) => {
      const near = events.filter((e) => {
        const at = Date.parse(e.at);
        return at >= start - EXPECTED_BEFORE && at <= end;
      });
      const away = Math.min(
        ...near.map((e) => Math.abs(Date.parse(e.at) - start))
      );
      return near.length > 0
        ? [
            {
              away,
              chats: [
                ...new Set(
                  near.flatMap((e) => (e.chatName ? [e.chatName] : []))
                ),
              ],
              ref,
            },
          ]
        : [];
    })
    .toSorted((a, b) => a.away - b.away || a.ref.localeCompare(b.ref));
}

/** What shows that a person could be in the room: each is a list of person refs. */
export interface Signs {
  /** Named by his answer in this conversation (lifelog's `owner` basis). */
  answered: string[];
  /** His expected company (`expectedCompanyOf`), nearest first. */
  expected: string[];
  /** In an active fact dated that day whose evidence is not a recording. */
  facts: string[];
  /** Spoke in person in one of his recordings, the voice named by his own answer and not heard over a phone (any time: `isHeardAround` keeps the 90 days either side). */
  heard: { at: string; ref: string }[];
  /** On a call that overlaps the recording (`overlappingPhoneCallsOf`). */
  onCall: string[];
  /** Pictured in a photo of that day. */
  pictured: string[];
}

/**
 * Whether a turn heard in person at `heardAt` counts for the conversation running from `begin` to `end`, whose part is at
 * `at`: in another conversation (before it began or after it ended), within `HEARD_WITHIN` either side, at the UTC
 * offset he had at the part: someone heard only while he was in another time zone, where they may live, does not count.
 */
export function isHeardAround(
  heardAt: string,
  at: string,
  begin: string,
  end: string
) {
  const [t, from, to] = [heardAt, begin, end].map((s) => Date.parse(s)) as [
    number,
    number,
    number,
  ];
  return (
    ((t < from && t >= from - HEARD_WITHIN) ||
      (t > to && t <= to + HEARD_WITHIN)) &&
    offsetAt(heardAt) === offsetAt(at)
  );
}

/**
 * His third rule: who could be there, at most `POSSIBLE_SPEAKERS`, in this order: on an overlapping call; named by his
 * answer in this conversation; his expected company; heard in person in another conversation
 * (`isHeardAround`, the conversation running from `begin` to `end`); pictured in a photo of that day; in an active fact
 * dated that day that no recording is evidence of.
 * Nothing else: a person with none of these is not offered, whoever lifelog says the voice sounds like; an organization
 * (`isOrganization`) never is.
 */
export function possibleSpeakersOf(
  signs: Signs,
  at: string,
  begin: string,
  end: string,
  isOrganization: (ref: string) => boolean,
  cap = POSSIBLE_SPEAKERS
) {
  const heard = signs.heard
    .filter((h) => isHeardAround(h.at, at, begin, end))
    .toSorted((a, b) => b.at.localeCompare(a.at))
    .map((h) => h.ref);
  return [
    ...new Set(
      [
        ...signs.onCall,
        ...signs.answered,
        ...signs.expected,
        ...heard,
        ...signs.pictured,
        ...signs.facts,
      ].filter(
        (r) => r.startsWith("person:") && r !== OWNER && !isOrganization(r)
      )
    ),
  ].slice(0, cap);
}

/** What a person's brief is made of. */
export interface Brief {
  /** The local days he spoke with them on a call picked up, within `HEARD_WITHIN` before the conversation. */
  byCall: string[];
  details: DetailLine[];
  /** The local days they spoke in person in his recordings, in another conversation within `HEARD_WITHIN` either side (`isHeardAround`). */
  inPerson: string[];
  language?: "en" | "fr" | "th";
  /** The names of the two people most often recorded the same days. */
  often: string[];
  relation?: string | null;
}

const LANGUAGES = { en: "English", fr: "French", th: "Thai" };

/**
 * His second rule: a short brief of a person, made for naming a voice: what they are to him, their language, family and
 * where they live, how often and how he last heard them, and who is usually there with them. At most `BRIEF_CHARS`.
 */
export function namingBriefOf(b: Brief) {
  const last = [...b.inPerson, ...b.byCall].toSorted().at(-1);
  const heard = `heard in person on ${b.inPerson.length} days, by call on ${b.byCall.length} days${last ? `, last on ${last}` : ""}`;
  const place = b.details.flatMap((d) =>
    d.kind === "home" || d.kind === "family"
      ? [`${d.kind === "home" ? "lives in" : "family"} ${d.text}`]
      : []
  );
  return clip(
    [
      b.relation,
      b.language && `speaks ${LANGUAGES[b.language]}`,
      ...place,
      heard,
      b.often.length > 0 &&
        `often recorded the same days as ${b.often.join(" and ")}`,
    ]
      .filter(Boolean)
      .join("; "),
    BRIEF_CHARS
  );
}

/**
 * How sure a guess is, decided by code (the design of 21 Nov 2026, section 2): the model's word is one signal, `signals`
 * counts the independent ones code found for that voice and person (planned, a name said, on a call, sounds like them),
 * `elsewhere` whether one points to someone else. Sure: the model says sure, 2 signals or more, nothing elsewhere.
 * Likely: the model says sure or likely, with 1 signal or more. Weak: the rest.
 */
export function namingConfidenceOf(
  said: "sure" | "likely" | "weak",
  signals: number,
  elsewhere: boolean
) {
  if (said === "sure" && signals >= 2 && !elsewhere) {
    return "sure" as const;
  }
  return said !== "weak" && signals >= 1
    ? ("likely" as const)
    : ("weak" as const);
}

const NOT_WORD = /[^\p{L}\p{N}]+/u;

/** Whether one of `lines` (spoken by others than the voice) says a word of `names` (a person's name, their chat titles), of 3 letters or more. */
export const isNameSaid = (
  lines: readonly string[],
  names: readonly string[]
) => {
  const words = names
    .flatMap((n) => n.split(NOT_WORD))
    .filter((w) => w.length >= 3);
  return lines.some((l) => holdsName(l, words));
};

/**
 * The voices of a part as the voice naming shows them: Voice's groups (a naming queue item, across recordings), not each
 * recording's labels. `unnamed` is each line's voice (`voiceKey`) when nobody named it, else null; `groupOf` a voice's
 * group id, none for a voice in no group (its own). Returns each line's group `V` (V1, V2… by first line) and each
 * group's recording voices with their lines, for storing a group's guess under the voices it is made of.
 */
export function voiceGroupsOf(
  unnamed: readonly (string | null)[],
  groupOf: (voice: string) => string | undefined
) {
  const tokens = new Map<string, string>();
  const members = new Map<string, Map<string, number[]>>();
  const lineTokens = unnamed.map((voice, n) => {
    if (!voice) {
      return null;
    }
    const group = groupOf(voice) ?? voice;
    const token = tokens.get(group) ?? `V${tokens.size + 1}`;
    tokens.set(group, token);
    const voices = members.get(token) ?? new Map<string, number[]>();
    members.set(token, voices.set(voice, [...(voices.get(voice) ?? []), n]));
    return token;
  });
  return { lineTokens, members };
}
