import { DAY, HOUR, MIN } from "../core/clock";
import { chatGroups, type SourceEvent } from "../records/source";
import type { DetailLine } from "./details";
import { OWNER, projectPeopleAndChatsOf, type Truth } from "./read-truth";
import { sourceOf } from "./sources";
import {
  callLine,
  callSpanOf,
  chatPerson,
  clip,
  holdsName,
  UNKNOWN,
} from "./units";
import type { People } from "./who";
import { offsetAt, time } from "./zones";

// What the voice naming read (`memory/voice-naming.ts`) is told about a conversation, made by code from his rules and
// never by a model (docs/glossary.md: calls, possible speaker, naming brief). Pure: the caller reads the data.

/** The calls a naming read is shown: at most this many characters. */
export const CALLS_CHARS = 600;
/** A guess's why (`whyOf`): at most this many characters. */
export const WHY_CHARS = 120;
/** A person's naming brief: at most this many characters. */
export const BRIEF_CHARS = 300;
/** The most people a naming read offers. */
export const POSSIBLE_SPEAKERS = 12;
/** A person heard in person counts as a possible speaker for this long afterwards. */
export const HEARD_WITHIN = 90 * DAY;
/** A call this near a recording is near it: a phone's clock and the pendant's can be minutes apart. */
export const CALL_SLACK = 5 * MIN;
/** The expected company: his one-to-one chats and calls from this long before a conversation to its end. */
const EXPECTED_BEFORE = 6 * HOUR;
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

/** The expected company's window of a conversation running from `began` to `ended`, as instants: from `EXPECTED_BEFORE` before it to its end. */
export const expectedWindowOf = (began: string, ended: string) =>
  [Date.parse(began) - EXPECTED_BEFORE, Date.parse(ended)] as const;

/** The last of `events` (one-to-one) that is a message, not a call, in the `PLANNED_WITHIN` up to `at` (ms): a plan to meet. */
export const plannedBeforeOf = (events: readonly SourceEvent[], at: number) =>
  events.findLast((e) => {
    const t = Date.parse(e.at);
    return !e.phoneCall && t >= at - PLANNED_WITHIN && t <= at;
  });

/** Whether one of `events` is a plan to meet (`plannedBeforeOf`). */
export const isPlannedBefore = (events: readonly SourceEvent[], at: number) =>
  Boolean(plannedBeforeOf(events, at));

/**
 * Why a guess is shown, in his words on the card: the most telling signal code found for that voice and person, the
 * event of his calendar first (`calendarGuestsOf`), then the plan for the day (its words), then the message before (its app, time and words), the call, the name said, the
 * sound. Null: none, the model's word alone.
 */
export function whyOf(s: {
  calendar?: string;
  named: boolean;
  onCall: boolean;
  plan?: string;
  planned?: SourceEvent;
  sounds: boolean;
}) {
  if (s.calendar) {
    return s.calendar;
  }
  if (s.plan) {
    return clip(`Planned that day: ${s.plan}`, WHY_CHARS);
  }
  if (s.planned) {
    const e = s.planned;
    return clip(
      `${sourceOf(e.source).label}, ${time(e.at)}: ${e.text}`,
      WHY_CHARS
    );
  }
  if (s.onCall) {
    return "On a call at that time";
  }
  if (s.named) {
    return "Their name is said";
  }
  return s.sounds ? "Sounds like them" : null;
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
  const [from, to] = expectedWindowOf(began, ended);
  const start = Date.parse(began);
  return [...direct]
    .flatMap(([ref, events]) => {
      const near = events.filter((e) => {
        const at = Date.parse(e.at);
        return at >= from && at <= to;
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
  /** Named by his answer in this conversation (the voice server's `owner` basis). */
  answered: string[];
  /** Brought by an event of his calendar overlapping the part (`calendarGuestsOf`): a guest not known is offered as written (`unknown:`). */
  calendar: string[];
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
  /** In an active plan for that day (`modality` plan, its `when` the day; never a conditional one), whose evidence is not a recording: a meeting set by mail or chat; a project or organization it names brings that organization's people (`plannedPeopleOf`). Not `appointments.ts`'s choice, which keeps every dated observation from today on for his calendar. */
  scheduled: string[];
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
 * Who a plan's subject brings to a meeting: a project's people as his directory holds them (`projectPeopleAndChatsOf`),
 * an organization's current `people` (no `until`) in its place, else the subject itself. A meeting set by an invitation
 * names the client's project, rarely each guest (his report of 22 Nov).
 */
export function plannedPeopleOf(
  subject: string,
  truth: Pick<Truth, "chats" | "organizations" | "people" | "projects">
) {
  const project = subject.startsWith("project:")
    ? projectPeopleAndChatsOf(truth, subject.slice("project:".length))
    : null;
  const refs = project?.people.map((p) => `person:${p.id}`) ?? [subject];
  return refs.flatMap((r) => organizationPeopleOf(r, truth) ?? [r]);
}

/** The current people (no `until`) of the organization of his directory `ref` is, or null when it is none. */
const organizationPeopleOf = (
  ref: string,
  truth: Pick<Truth, "organizations">
) =>
  truth.organizations
    .find((o) => `person:${o.id}` === ref)
    ?.people.filter((p) => !p.until)
    .map((p) => `person:${p.id}`) ?? null;

/** A timed event of his calendar as the voice naming reads it (`readCalendarDay`): when, its title and its guests but him. */
export interface DayEvent {
  at: string;
  guests: { email?: string; name?: string }[];
  title: string;
  until: string;
}

/**
 * Who the events of his calendar overlapping `from`..`to` (`CALL_SLACK` either side) bring, each with why
 * (`Calendar: <title>, HH:MM`, the first event's): each guest as `resolve` reads their address, else their name, else
 * as written (`unknown:`); a guest who is an organization of his directory brings its current people in its place, and
 * one at such an organization brings its people too, as a plan's organization does (`plannedPeopleOf`; his ask of 22
 * Nov 2026: an invitation rarely names each guest).
 */
export function calendarGuestsOf(
  events: readonly DayEvent[],
  from: string,
  to: string,
  people: Pick<People, "resolve" | "truth">
) {
  const brought = new Map<string, string>();
  const [start, end] = [
    Date.parse(from) - CALL_SLACK,
    Date.parse(to) + CALL_SLACK,
  ];
  const { organizations } = people.truth;
  for (const e of events) {
    if (Date.parse(e.at) >= end || Date.parse(e.until) <= start) {
      continue;
    }
    const why = clip(`Calendar: ${e.title}, ${time(e.at)}`, WHY_CHARS);
    const guests = e.guests.flatMap((g) => {
      const ref =
        (g.email && people.resolve(g.email)) ||
        (g.name && people.resolve(g.name));
      return (
        ref || ((g.name ?? g.email) ? [`${UNKNOWN}${g.name ?? g.email}`] : [])
      );
    });
    const theirs = organizations.flatMap((o) =>
      o.people.some((p) => !p.until && guests.includes(`person:${p.id}`))
        ? [`person:${o.id}`]
        : []
    );
    for (const r of [...guests, ...theirs].flatMap(
      (g) => organizationPeopleOf(g, people.truth) ?? [g]
    )) {
      if (!brought.has(r)) {
        brought.set(r, why);
      }
    }
  }
  return brought;
}

/** The people of the active plans (`modality` plan) for each of `dates` (their `when`), each with its plan's words (`plannedPeopleOf`). */
export function scheduledOf(
  observations: readonly {
    modality?: string | null;
    subjects: string[];
    text: string;
    when?: string | null;
  }[],
  dates: readonly string[],
  truth: Parameters<typeof plannedPeopleOf>[1]
) {
  const scheduled = new Map<string, Map<string, string>>();
  for (const o of observations) {
    if (o.modality !== "plan" || !o.when || !dates.includes(o.when)) {
      continue;
    }
    const plans = scheduled.get(o.when) ?? new Map<string, string>();
    for (const p of o.subjects.flatMap((s) => plannedPeopleOf(s, truth))) {
      plans.set(p, o.text);
    }
    scheduled.set(o.when, plans);
  }
  return scheduled;
}

/**
 * His third rule: who could be there, at most `POSSIBLE_SPEAKERS`, in this order: on an overlapping call; named by his
 * answer in this conversation; his expected company; brought by an event of his calendar overlapping the part
 * (`calendarGuestsOf`; a guest not known offered as written, the one `unknown:` ref offered); in a plan for that day (a meeting set ahead, which the 90 days of
 * people heard would otherwise crowd out: his report of 22 Nov); heard in person in another conversation
 * (`isHeardAround`, the conversation running from `begin` to `end`); pictured in a photo of that day; in an active fact
 * dated that day that no recording is evidence of.
 * Nothing else: a person with none of these is not offered, whoever the voice server says the voice sounds like; an organization
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
        ...signs.calendar,
        ...signs.scheduled,
        ...heard,
        ...signs.pictured,
        ...signs.facts,
      ].filter(
        (r) =>
          (r.startsWith("person:") ||
            (r.startsWith(UNKNOWN) && signs.calendar.includes(r))) &&
          r !== OWNER &&
          !isOrganization(r)
      )
    ),
  ].slice(0, cap);
}

/** What a person's brief is made of. */
export interface Brief {
  /** The local days he spoke with them on a call picked up, within `HEARD_WITHIN` before the conversation. */
  byCall: string[];
  /** Why an event of his calendar brings them (`calendarGuestsOf`). */
  calendar?: string;
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
 * His second rule: a short brief of a person, made for naming a voice: the event of his calendar that brings them, what they are to him, their language, family and
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
      b.calendar,
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
 * counts the independent ones code found for that voice and person (planned, in his calendar, scheduled for the day, a name said, on a call, sounds like them),
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
