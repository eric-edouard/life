import { INVALID_PARAMS, ProtocolError } from "@modelcontextprotocol/server";
import { z } from "zod";
import { clock, HOUR, iso } from "../core/clock";
import { DEFAULT_RADIUS_M, distanceM } from "../core/distance";
import { log } from "../core/log";
import { errorOf } from "../core/log-line";
import {
  decode,
  encode,
  feedPage,
  MAX_PAGE,
  PAGE,
  parseCursor,
  type Source,
} from "../memory/changes";
import { directChats } from "../memory/closeness";
import type { Decision } from "../memory/decision-lines";
import {
  cardsHearingOf,
  decisionsNow,
  settledAtOf,
  settledBetween,
} from "../memory/decisions";
import { readFiles } from "../memory/memory-files";
import { hearVoiceNotes, showFiles } from "../memory/message-files";
import { overlappingPhoneCallsOf } from "../memory/naming-context";
import { readySources, SOURCES } from "../memory/sources";
import { isLifeOutput, speakerOf } from "../memory/units";
import { meant, nameRefusalOf, type People, readPeople } from "../memory/who";
import { EventFilter } from "../records/registered-agent";
import { eventKey, type SourceEvent } from "../records/source";
import type { Descriptor } from "../sources/contract";
import { EVENT_CHANNELS, type Matchable } from "./event-channels";

// Events: what an agent can wait for, MCP's Events extension (SEP-3415, a draft; `io.modelcontextprotocol/events`),
// served by poll only. The agent picks its own arguments and Life matches them by code. An event is computed when it
// is polled, from each source's own order (`incoming`), or from the decisions as they stand (`decisionsNow`): Life
// stores nothing for it, and the agent keeps its cursor.

export const EVENTS = "io.modelcontextprotocol/events";
export const MESSAGE_RECEIVED = "message.received";
/** A decision the caller asked got his answer, lapsed unanswered at its deadline, or was withdrawn because he answered in its draft's chat himself: the follow-through to its asker. */
export const DECISION_ANSWERED = "decision.answered";
export const DECISION_LAPSED = "decision.lapsed";
export const DECISION_WITHDRAWN = "decision.withdrawn";
/** Another asker's card waits on the open card of the agent woken, both drafting into one chat: the desk's event alone, facts only (the waiting card's id, its asker, the chat, the held card, until when), never words (`pollContests`). */
export const DRAFT_CONTESTED = "draft.contested";
/** The holder kept its card against the waiting card of the agent woken: the desk's event alone, with the holder's why. */
export const DRAFT_KEPT = "draft.kept";
/** A call of his that ended, once lifelog holds its words: the desk's event alone (`pollCalls`), never the connector's. */
export const CALL_ENDED = "call.ended";
/** His complaint (his "Wrong…" on a card of Life's), received for the caretaker: the desk's event alone, its payload the ask's id, never his words (`desk/complaint-intake.ts`). */
export const COMPLAINT_RECEIVED = "complaint.received";
/** How far back a call that began is looked at: the desk asks again each poll, so a late pendant sync still wakes. */
export const CALLS_BACK = 12 * HOUR;
/** Each decision event: the state it reports and what it tells its asker. */
const DECISION_EVENT_OF: Record<
  string,
  { about: string; states: readonly Decision["state"][] }
> = {
  [DECISION_ANSWERED]: {
    about:
      "A decision you asked (`request_decision`) got his answer: the options he picked and his words; or, with no answer, `doneSeen`: Life saw its step done itself.",
    // A card Life saw done with no answer of his is told as answered: `doneSeen`, no `answer`.
    states: ["answered", "seen"],
  },
  [DECISION_LAPSED]: {
    about:
      "A decision you asked lapsed unanswered at its deadline: take your `onSilence` option now.",
    states: ["lapsed"],
  },
  [DECISION_WITHDRAWN]: {
    about:
      "A decision you asked with a draft was withdrawn for you (`why`): he answered in its chat himself, or another card took its place (`replacedBy`: the newer card he sent, or the holder's card that merged yours, whose answer you hear too): read the chat again, then finish or ask something new.",
    states: ["withdrawn"],
  },
};
/** The decision events, the one list (the connector's poll, the desk's wake at once). */
export const DECISION_EVENTS = Object.keys(DECISION_EVENT_OF);
/** How often an agent should poll when nothing is waiting. */
const NEXT_POLL_MS = 30_000;
/** How long a poll waits for its page's voice notes to be heard. */
const HEAR_VOICE_NOTES_MS = 60_000;
// The extension's provisional error code for an unknown event name.
const NOT_FOUND = -32_023;

export type Messaging = Descriptor & {
  incoming: NonNullable<Descriptor["incoming"]>;
  kind: "chat" | "mail";
  read: (since: Date) => SourceEvent[];
};

/** The sources with events now: on, readable, chat or mail, and able to say what they wrote after a row. */
const messaging = () =>
  readySources().filter(
    (s): s is Messaging =>
      (s.kind === "chat" || s.kind === "mail") && Boolean(s.incoming)
  );

/** The arguments an agent polls with: an `EventFilter` (its apps among the sources on now). */
const argumentsOf = (channels: string[]) =>
  EventFilter.omit({
    above: true,
    below: true,
    latitude: true,
    longitude: true,
    quantity: true,
    radius_m: true,
    repo: true,
  })
    .extend({
      channels: z
        .array(
          channels.length
            ? z.enum(channels as [string, ...string[]])
            : z.never()
        )
        .optional()
        .describe("Only these apps; every one by default"),
    })
    .strict();

const Payload = z.object({
  at: z.iso.datetime(),
  chat: z.string(),
  chatName: z.string().optional(),
  id: z.string().describe("Its id: `fetch` or `read_chats` reads it"),
  person: z
    .string()
    .nullable()
    .describe("Who wrote it (person:<id>), or the 1:1 chat's for his own"),
  source: z.string(),
});

export type MessagePayload = z.infer<typeof Payload>;

/** A message as an event says it: who wrote it (his own: the 1:1 chat's person, when it is one by its id or name alone, never by who else wrote in this read), where and when. */
export function messagePayloadOf(
  e: SourceEvent,
  people: People
): MessagePayload {
  const [chatPerson] = e.fromMe ? directChats([e], people.resolve).keys() : [];
  const who = e.fromMe ? chatPerson : speakerOf(e.source, e, people.resolve);
  return {
    at: e.at,
    chat: e.chat,
    ...(e.chatName ? { chatName: e.chatName } : {}),
    id: e.id,
    person: who === undefined ? null : people.refOf(who),
    source: e.source,
  };
}

const DecisionPayload = z.object({
  answer: z
    .object({
      at: z.iso.datetime(),
      note: z.string().optional().describe("His words"),
      options: z.array(z.string()).describe("The option ids he picked"),
    })
    .optional(),
  at: z.iso
    .datetime()
    .describe(
      "When he answered, the deadline it lapsed at, or when Life withdrew it or saw its step done"
    ),
  doneSeen: z
    .object({ eventId: z.string(), state: z.literal("seen") })
    .optional()
    .describe(
      "Life saw its step done itself (`doneSeenBy`): the payment's event (`read_payments`); with no `answer` when Life saw it before he said"
    ),
  end: z
    .object({ error: z.string().optional() })
    .optional()
    .describe(
      "Its step or matter, closed in Life on his pick of an `ends` option: why not, if it failed"
    ),
  id: z.string().describe("The decision's id, as `request_decision` gave it"),
  onSilence: z
    .string()
    .nullable()
    .describe("The option you said you take if he doesn't answer"),
  question: z
    .string()
    .optional()
    .describe("The card's question: absent on the card that merged yours"),
  replacedBy: z
    .string()
    .optional()
    .describe(
      "Withdrawn because another card took its place: the newer card he sent, or the holder's card that merged yours"
    ),
  send: z
    .object({ error: z.string().optional(), eventId: z.string().optional() })
    .optional()
    .describe("Its draft, sent on his answer: the event, or why not"),
  why: z
    .string()
    .optional()
    .describe("Why Life withdrew it: he answered in the chat himself"),
});

/** What came of a settled decision besides his answer: Life saw its step done (`doneSeen`), its end, its send. */
const outcomesOf = (
  d: Decision
): Pick<z.infer<typeof DecisionPayload>, "doneSeen" | "end" | "send"> => ({
  ...(d.doneSeen?.state === "seen" && d.doneSeen.eventId
    ? { doneSeen: { eventId: d.doneSeen.eventId, state: "seen" } }
    : {}),
  ...(d.end ? { end: d.end.error ? { error: d.end.error } : {} } : {}),
  ...(d.send
    ? {
        send:
          d.send.kind === "sent"
            ? { eventId: d.send.eventId }
            : { error: d.send.error },
      }
    : {}),
});

/** A decision events cursor: the instant the next window starts at (`request_decision` returns one at the asking instant). */
export const decisionCursorOf = (at: Date) => encode({ at: at.getTime() });

/**
 * The decisions `agent` asked, or that merged one it asked (`cardsHearingOf`), that got his answer (`decision.answered`), lapsed (`decision.lapsed`) or were withdrawn
 * because he answered in the chat (`decision.withdrawn`) since `cursor`
 * (none: from now), all of them: an agent has few, so one page. The new cursor is now, the window half-open, so an
 * answer recorded in the same instant comes on the next poll.
 */
export function pollDecisions(
  name: string,
  cursor: string | null,
  agent: string | undefined
) {
  if (!agent) {
    throw new ProtocolError(
      INVALID_PARAMS,
      "Only a paired agent waits for its decisions (`bun life pair <agent>`)"
    );
  }
  const now = clock();
  const from = new Date(
    decode(cursor ?? undefined, z.object({ at: z.int() }), {
      at: now.getTime(),
    }).at
  );
  const states: readonly Decision["state"][] =
    DECISION_EVENT_OF[name]?.states ?? [];
  const all = decisionsNow(now);
  // Its own cards, and the cards that merged one of its own: their answer is its too.
  const settled = settledBetween(all, from, now).filter(
    (d) =>
      states.includes(d.state) &&
      cardsHearingOf(d, all).some((c) => c.asker === agent)
  );
  return {
    cursor: decisionCursorOf(now),
    events: settled.map((d) => {
      const at = d.answer?.at ?? settledAtOf(d) ?? d.deadline;
      // A merged card's asker hears his answer, never the holder's words or its `onSilence`.
      const isOwn = d.asker === agent;
      return {
        data: {
          ...(d.answer
            ? {
                answer: {
                  at: d.answer.at,
                  ...(d.answer.note ? { note: d.answer.note } : {}),
                  options: d.answer.options,
                },
              }
            : {}),
          at,
          ...outcomesOf(d),
          id: d.id,
          onSilence: isOwn ? d.onSilence : null,
          question: isOwn ? d.question : undefined,
          ...(d.withdrawn?.replacedBy
            ? { replacedBy: d.withdrawn.replacedBy }
            : {}),
          ...(d.withdrawn ? { why: d.withdrawn.why } : {}),
        } satisfies z.infer<typeof DecisionPayload>,
        eventId: `${d.id}.${states[0]}`,
        name,
        timestamp: at,
      };
    }),
    hasMore: false,
    nextPollMs: NEXT_POLL_MS,
    resultType: "complete",
    truncated: false,
  };
}

/** `events/list`: the event types an agent can poll now, built from the sources that are on (a plugin's come with it). */
export function eventTypes() {
  const channels = messaging().map((s) => s.name);
  return {
    events: [
      {
        delivery: ["poll"],
        description:
          "A message in a chat app or mail: who wrote it, where and when, never its text (read it with `fetch`). By default others' messages to him; `from_me` for his own.",
        inputSchema: z.toJSONSchema(argumentsOf(channels), { io: "input" }),
        name: MESSAGE_RECEIVED,
        payloadSchema: z.toJSONSchema(Payload),
      },
      ...Object.entries(DECISION_EVENT_OF).map(([name, { about }]) => ({
        delivery: ["poll"],
        description: about,
        inputSchema: z.toJSONSchema(z.object({}).strict(), { io: "input" }),
        name,
        payloadSchema: z.toJSONSchema(DecisionPayload),
      })),
    ],
    resultType: "complete",
  };
}

export const PollParams = z.object({
  arguments: z.record(z.string(), z.unknown()).default({}),
  cursor: z.string().nullable().default(null),
  maxEvents: z.int().min(1).max(MAX_PAGE).optional(),
  name: z.string(),
});

/**
 * One source's new messages from row `from`, at most a page (`MAX_PAGE`: a bridge's backfill pages through, `hasMore`),
 * as `read` makes them: a row it skips (a newsletter, a draft) is no message. With no `from`, none: the cursor starts at
 * the source's end, now.
 */
function readNewMessages(s: Messaging, from: number | undefined) {
  const { end, rows } = s.incoming(from);
  // No cursor yet, or Mail rebuilt its index (renumbered): start at its end, and say so on a rebuild.
  if (from === undefined || from > end) {
    return {
      end,
      from: end,
      isCut: false,
      messages: [],
      truncated: from !== undefined,
    };
  }
  const kept = rows.slice(0, MAX_PAGE);
  const since = kept.reduce((t, r) => (r.at < t ? r.at : t), kept[0]?.at ?? "");
  // ponytail: `read` has no upper bound, so a cursor far behind (an agent's first, a long backlog) reads from its oldest
  // kept row to now on each page; give `read` an `until` if an agent ever pages through months.
  const byId = new Map(
    (since ? s.read(new Date(since)) : []).map((e) => [e.id, e])
  );
  const isCut = rows.length > kept.length;
  return {
    end: isCut ? (kept.at(-1)?.row ?? from) + 1 : end,
    from,
    isCut,
    messages: kept.flatMap((r) => {
      const e = byId.get(r.id);
      return e && !isLifeOutput(e) ? [[r.row, e] as [number, SourceEvent]] : [];
    }),
    truncated: false,
  };
}

/** Who `filter.person` means, as a person id: none when it names no one (or no people are given). */
const wantedOf = (filter: EventFilter, people?: People) =>
  filter.person && people ? meant(filter.person, people).known : undefined;

/**
 * Whether an event is one `filter` wants, decided here only (the connector's polls and the desk's agent waits), by the
 * rules of `Matchable`: by app or channel, chat, his own or others', who (a message's writer, or who was on a call,
 * whoever placed it), a pattern on its text, a quantity's range, a GitHub repo and a place: the event's own point within `radius_m`
 * of the filter's coordinates (the stay's point as lifelog gives it, unlike `read_places_visited`'s circle mode, which
 * weighs each fix's accuracy). Null when its person is no one Life knows (none are needed for a filter with no person).
 */
export function matcherOf(filter: EventFilter, people?: People) {
  const wanted = wantedOf(filter, people);
  if (filter.person && !wanted) {
    return null;
  }
  const text = filter.text_matches
    ? new RegExp(filter.text_matches, "i")
    : undefined;
  const { above, below, quantity } = filter;
  return (x: Matchable) =>
    (x.fromMe ?? false) === filter.from_me &&
    (filter.channels ? filter.channels.includes(x.channel) : !x.isNamedOnly) &&
    (!filter.chat || x.chat === filter.chat) &&
    (!wanted || (x.people ?? []).includes(`person:${wanted}`)) &&
    // ponytail: a backtracking pattern stalls the desk's message poll for every agent (200 characters and a compile check bound its size, not its match time; the author is his own agent or paired app). A linear-time engine at this one call if it ever bites.
    (!text || (x.text !== undefined && text.test(x.text))) &&
    (!quantity || isInRange(x.quantities?.[quantity], above, below)) &&
    isNear(x.point, filter) &&
    isRepoOf(x.repo, filter.repo);
}

/** Whether an event's repo is the filter's (`owner/name`, or any of an owner's, `owner/*`), any case; an event with a repo needs a filter naming one. */
const isRepoOf = (repo: string | undefined, wanted: string | undefined) => {
  if (!(repo && wanted)) {
    return repo === wanted;
  }
  const [r, w] = [repo.toLowerCase(), wanted.toLowerCase()];
  return w.endsWith("/*") ? r.startsWith(w.slice(0, -1)) : r === w;
};

/** Whether a point lies within `radius_m` of the filter's coordinates; true when it names none. */
const isNear = (
  point: Matchable["point"],
  { latitude, longitude, radius_m = DEFAULT_RADIUS_M }: EventFilter
) =>
  latitude === undefined ||
  longitude === undefined ||
  (point !== undefined &&
    distanceM({ latitude, longitude }, point) <= radius_m);

/** Whether a quantity is known and lies strictly between `above` and `below` (each optional). */
const isInRange = (n: number | undefined, above?: number, below?: number) =>
  n !== undefined &&
  (above === undefined || n > above) &&
  (below === undefined || n < below);

/** A message as a filter sees it: its writer (his own: the 1:1 chat's person, `messagePayloadOf`) and its text. */
export const messageMatchableOf = (
  m: MessagePayload,
  e: SourceEvent
): Matchable => ({
  channel: m.source,
  chat: m.chat,
  fromMe: e.fromMe,
  people: m.person ? [m.person] : [],
  text: e.text,
});

/**
 * The messages past `cursor` (none: start at now) that `item` makes something of, at most `max`, and the cursor past
 * them: one read for the connector's polls and the desk's. A source that cannot be read keeps its place, so nothing it
 * wrote meanwhile is skipped.
 */
export async function readMessageEvents<T>(
  cursor: string | null | undefined,
  max: number,
  people: People,
  item: (m: MessagePayload, e: SourceEvent) => T | null,
  sources = messaging()
) {
  const at = parseCursor(cursor ?? undefined);
  let truncated = false;
  let isCut = false;
  const feeds: (Source<SourceEvent> & { from: number })[] = sources.flatMap(
    (s) => {
      const from = at[s.name];
      try {
        const r = readNewMessages(s, from);
        truncated ||= r.truncated;
        isCut ||= r.isCut;
        return [
          { end: r.end, from: r.from, name: s.name, rows: () => r.messages },
        ];
      } catch (error) {
        log("source.read", {
          ...errorOf(error),
          ok: false,
          source: s.name,
          what: "events",
        });
        return from === undefined
          ? []
          : [{ end: from, from, name: s.name, rows: () => [] }];
      }
    }
  );
  const read = feeds.flatMap((f) => f.rows(f.from).map(([, e]) => e));
  // A chat's voice note is heard before it is matched, so a wait on words sees what was said; past the bound it goes
  // as it is (the arrival pass hears it).
  const chats = new Set(
    sources.filter((s) => s.kind === "chat").map((s) => s.name)
  );
  await Promise.race([
    hearVoiceNotes(read.filter((e) => chats.has(e.source))),
    Bun.sleep(HEAR_VOICE_NOTES_MS),
  ]).catch((error) =>
    log("source.read", { ...errorOf(error), ok: false, what: "voice notes" })
  );
  // What a filter matches is the text every reader sees: its files' lines included.
  const shown = new Map(
    showFiles(read, readFiles()).map((e) => [eventKey(e), e])
  );
  const page = feedPage(
    feeds,
    { ...at, ...Object.fromEntries(feeds.map((f) => [f.name, f.from])) },
    max,
    (_s, raw) => {
      const e = shown.get(eventKey(raw)) ?? raw;
      return item(messagePayloadOf(e, people), e);
    }
  );
  return {
    cursor: page.cursor,
    hasMore: page.remaining > 0 || isCut,
    items: page.items,
    truncated,
  };
}

/** `events/poll`: the caller's decisions settled since `cursor` (`pollDecisions`), else its messages (`pollMessagesReceived`). */
export const pollEvents = async (
  p: z.infer<typeof PollParams>,
  agent: string | undefined
) =>
  DECISION_EVENTS.includes(p.name)
    ? pollDecisions(p.name, p.cursor, agent)
    : pollMessagesReceived(p);

/** The messages matching `arguments` past `cursor`. */
export async function pollMessagesReceived(
  p: z.infer<typeof PollParams>,
  sources = messaging()
) {
  if (p.name !== MESSAGE_RECEIVED) {
    throw new ProtocolError(NOT_FOUND, `No event ${p.name}`, { kind: "event" });
  }
  const parsed = argumentsOf(sources.map((s) => s.name)).safeParse(p.arguments);
  if (!parsed.success) {
    throw new ProtocolError(INVALID_PARAMS, z.prettifyError(parsed.error));
  }
  const people = await readPeople();
  const isMatch = matcherOf(parsed.data, people);
  if (!isMatch) {
    throw new ProtocolError(
      INVALID_PARAMS,
      nameRefusalOf(parsed.data.person ?? "", people)
    );
  }
  const read = await readMessageEvents(
    p.cursor,
    p.maxEvents ?? PAGE,
    people,
    (m, e) =>
      isMatch(messageMatchableOf(m, e))
        ? { data: m, eventId: m.id, name: MESSAGE_RECEIVED, timestamp: m.at }
        : null,
    sources
  );
  return {
    cursor: read.cursor,
    events: read.items,
    hasMore: read.hasMore,
    nextPollMs: NEXT_POLL_MS,
    resultType: "complete",
    truncated: read.truncated,
  };
}

/** A call that ended, as `call.ended` says it: its message's payload, when it ended, whether it had video, who was on it. */
export interface CallPayload extends MessagePayload {
  people: string[];
  until: string;
  video: boolean;
}

/** A call as a filter sees it: who was on it, never who dialed; not his own message and no text. */
export const callMatchableOf = (c: CallPayload): Matchable => ({
  channel: c.source,
  chat: c.chat,
  people: c.people,
});

/**
 * The channels a wait may name: those Life knows (every chat and mail app, and the event channels) and those on now
 * (the apps whose messages or calls the desk reads, and the event channels that can be read), so "off" and "unknown"
 * differ.
 */
export const waitChannelsOf = (
  sources: { name: string }[] = [...messaging(), ...chatSources()],
  channels = EVENT_CHANNELS
) => ({
  known: [
    ...SOURCES.filter((s) => s.kind === "chat" || s.kind === "mail").map(
      (s) => s.name
    ),
    ...channels.map((c) => c.name),
  ],
  on: [
    ...sources.map((s) => s.name),
    ...channels.filter((c) => !c.block()).map((c) => c.name),
  ],
});

/** The chat apps that are on and readable: where calls are, whether or not they say what came after a row (the phone's don't). */
const chatSources = () =>
  readySources().filter(
    (s): s is Descriptor & { kind: "chat"; read: Messaging["read"] } =>
      s.kind === "chat"
  );

/**
 * The picked-up calls that began in the `CALLS_BACK` before `now` and have ended (a call's end is `at` plus its length,
 * which lands after the call: WhatsApp rewrites the call's message, a bridge's end notice gives it), from every chat
 * app's own read; `people` on each are who the chat's messages and calls say were on it (`overlappingPhoneCallsOf`).
 * A source that cannot be read gives none this time.
 * ponytail: reads 12 h of every chat source on each poll; gate it by the archives' change stamp if a poll passes 1 s.
 */
export function readEndedCalls(
  people: People,
  sources: Pick<Messaging, "name" | "read">[] = chatSources(),
  now = clock().getTime()
): CallPayload[] {
  return sources.flatMap((s) => {
    let events: SourceEvent[];
    try {
      events = s.read(new Date(now - CALLS_BACK));
    } catch (error) {
      log("source.read", {
        ...errorOf(error),
        ok: false,
        source: s.name,
        what: "calls",
      });
      return [];
    }
    // One source's read: its events' chats are keyed by `chat` alone.
    const chats = Map.groupBy(events, (e) => e.chat);
    return events.flatMap((e) => {
      if (!e.phoneCall?.seconds) {
        return [];
      }
      const [at, until] = [
        iso(Date.parse(e.at)),
        iso(Date.parse(e.at) + e.phoneCall.seconds * 1000),
      ];
      return [
        {
          ...messagePayloadOf(e, people),
          at,
          people: overlappingPhoneCallsOf(
            chats.get(e.chat) ?? [],
            at,
            until,
            people
          ).people.map((p) => people.refOf(p)),
          until,
          video: e.phoneCall.video,
        },
      ];
    });
  });
}
