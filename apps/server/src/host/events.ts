import { INVALID_PARAMS, ProtocolError } from "@modelcontextprotocol/server";
import { z } from "zod";
import { clock, HOUR, iso } from "../core/clock";
import { log } from "../core/log";
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
import { decisionsNow, settledAtOf, settledBetween } from "../memory/decisions";
import { overlappingPhoneCallsOf } from "../memory/naming-context";
import { readySources } from "../memory/sources";
import { isLifeOutput, speakerOf } from "../memory/units";
import { meant, type People, readPeople } from "../memory/who";
import { MessageFilter } from "../records/registered-agent";
import type { SourceEvent } from "../records/source";
import type { Descriptor } from "../sources/contract";

// Events: what an agent can wait for, MCP's Events extension (SEP-3415, a draft; `io.modelcontextprotocol/events`),
// served by poll only. The agent picks its own arguments and Life matches them by code. An event is computed when it
// is polled, from each source's own order (`incoming`), or from the decisions as they stand (`decisionsNow`): Life
// stores nothing for it, and the agent keeps its cursor.

export const EVENTS = "io.modelcontextprotocol/events";
export const MESSAGE_RECEIVED = "message.received";
/** A decision the caller asked got his answer, or lapsed unanswered at its deadline: the follow-through to its asker. */
export const DECISION_ANSWERED = "decision.answered";
export const DECISION_LAPSED = "decision.lapsed";
/** A call of his that ended, once lifelog holds its words: the desk's event alone (`pollCalls`), never the connector's. */
export const CALL_ENDED = "call.ended";
/** How far back a call that began is looked at: the desk asks again each poll, so a late pendant sync still wakes. */
export const CALLS_BACK = 12 * HOUR;
const DECISION_EVENTS = [DECISION_ANSWERED, DECISION_LAPSED];
/** How often an agent should poll when nothing is waiting. */
const NEXT_POLL_MS = 30_000;
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

/** Whether a client's `text_matches` compiles. */
const isPattern = (source: string) => {
  try {
    return Boolean(new RegExp(source));
  } catch {
    return false;
  }
};

/** The arguments an agent polls with: a `MessageFilter` (its apps among the sources on now), and a pattern on the text. */
const argumentsOf = (channels: string[]) =>
  MessageFilter.extend({
    channels: z
      .array(
        channels.length ? z.enum(channels as [string, ...string[]]) : z.never()
      )
      .optional()
      .describe("Only these apps; every one by default"),
    text_matches: z
      .string()
      .max(200)
      .refine(isPattern, "not a regular expression")
      .optional()
      .describe("A regular expression its text must match, any case"),
  }).strict();

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
  const who = e.fromMe ? chatPerson : speakerOf("chat", e, people.resolve);
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
    .describe("When he answered, or the deadline it lapsed at"),
  id: z.string().describe("The decision's id, as `request_decision` gave it"),
  onSilence: z
    .string()
    .nullable()
    .describe("The option you said you take if he doesn't answer"),
  question: z.string(),
  send: z
    .object({ error: z.string().optional(), eventId: z.string().optional() })
    .optional()
    .describe("Its draft, sent on his answer: the event, or why not"),
});

/** A decision events cursor: the instant the next window starts at (`request_decision` returns one at the asking instant). */
export const decisionCursorOf = (at: Date) => encode({ at: at.getTime() });

/**
 * The decisions `agent` asked that got his answer (`decision.answered`) or lapsed (`decision.lapsed`) since `cursor`
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
  const state = name === DECISION_ANSWERED ? "answered" : "lapsed";
  const settled = settledBetween(decisionsNow(now), from, now).filter(
    (d) => d.asker === agent && d.state === state
  );
  return {
    cursor: decisionCursorOf(now),
    events: settled.map((d) => {
      const at = d.answer?.at ?? settledAtOf(d) ?? d.deadline;
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
          id: d.id,
          onSilence: d.onSilence,
          question: d.question,
          ...(d.send
            ? {
                send:
                  d.send.kind === "sent"
                    ? { eventId: d.send.eventId }
                    : { error: d.send.error },
              }
            : {}),
        } satisfies z.infer<typeof DecisionPayload>,
        eventId: `${d.id}.${state}`,
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
      ...DECISION_EVENTS.map((name) => ({
        delivery: ["poll"],
        description:
          name === DECISION_ANSWERED
            ? "A decision you asked (`request_decision`) got his answer: the options he picked and his words."
            : "A decision you asked lapsed unanswered at its deadline: take your `onSilence` option now.",
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

/** Who `filter.person` means, as a person id: none when it names no one. */
const wantedOf = (filter: MessageFilter, people: People) =>
  filter.person ? meant(filter.person, people).known : undefined;

/**
 * Whether a message is one `filter` wants, decided here only (the connector's polls and the desk's agent waits): null
 * when its person is no one Life knows.
 */
export function matcherOf(
  filter: MessageFilter & { text_matches?: string },
  people: People
) {
  const wanted = wantedOf(filter, people);
  if (filter.person && !wanted) {
    return null;
  }
  const text = filter.text_matches
    ? new RegExp(filter.text_matches, "i")
    : undefined;
  return (m: MessagePayload, e: SourceEvent) =>
    e.fromMe === filter.from_me &&
    (!filter.channels || filter.channels.includes(m.source)) &&
    (!filter.chat || m.chat === filter.chat) &&
    (!wanted || m.person === `person:${wanted}`) &&
    (!text || text.test(e.text));
}

/**
 * The messages past `cursor` (none: start at now) that `item` makes something of, at most `max`, and the cursor past
 * them: one read for the connector's polls and the desk's. A source that cannot be read keeps its place, so nothing it
 * wrote meanwhile is skipped.
 */
export function readMessageEvents<T>(
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
          error: String(error),
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
  const page = feedPage(
    feeds,
    { ...at, ...Object.fromEntries(feeds.map((f) => [f.name, f.from])) },
    max,
    (_s, e) => item(messagePayloadOf(e, people), e)
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
      `No one goes by ${parsed.data.person}`
    );
  }
  const read = readMessageEvents(
    p.cursor,
    p.maxEvents ?? PAGE,
    people,
    (m, e) =>
      isMatch(m, e)
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

/**
 * Whether a call is one `filter` wants, decided here only (the desk's waits): by chat or app, and by person against who
 * was on the call, not who dialed. `from_me` is not asked: a call of his own matches too. A filter on his own messages
 * (`from_me`) or on their words (`text_matches`) matches no call. Null when its person is no one Life knows.
 */
export function callMatcherOf(
  filter: MessageFilter & { text_matches?: string },
  people: People
) {
  const wanted = wantedOf(filter, people);
  if (filter.person && !wanted) {
    return null;
  }
  return (c: CallPayload) =>
    !(filter.from_me || filter.text_matches) &&
    (!filter.channels || filter.channels.includes(c.source)) &&
    (!filter.chat || c.chat === filter.chat) &&
    (!wanted || c.people.includes(`person:${wanted}`));
}

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
        error: String(error),
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
          ).people.map(people.refOf),
          until,
          video: e.phoneCall.video,
        },
      ];
    });
  });
}
