import { INVALID_PARAMS, ProtocolError } from "@modelcontextprotocol/server";
import { z } from "zod";
import { feedPage, PAGE, parseCursor, type Source } from "../memory/changes";
import { directChats } from "../memory/closeness";
import { readySources } from "../memory/sources";
import { isLifeOutput, speakerOf } from "../memory/units";
import { meant, readPeople } from "../memory/who";
import type { SourceEvent } from "../records/source";
import type { Descriptor } from "../sources/contract";

// Events: what an agent can wait for, MCP's Events extension (SEP-3415, a draft; `io.modelcontextprotocol/events`),
// served by poll only. The agent picks its own arguments and Life matches them by code. An event is computed when it
// is polled, from each source's own order (`incoming`): Life stores nothing for it, and the agent keeps its cursor.

export const EVENTS = "io.modelcontextprotocol/events";
export const MESSAGE_RECEIVED = "message.received";
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

const argumentsOf = (channels: string[]) =>
  z
    .object({
      channels: z
        .array(
          channels.length
            ? z.enum(channels as [string, ...string[]])
            : z.never()
        )
        .optional()
        .describe("Only these apps; every one by default"),
      chat: z
        .string()
        .optional()
        .describe("Only this chat: its key, as `read_chats` gives it"),
      from_me: z
        .boolean()
        .default(false)
        .describe("His own messages instead of everyone else's"),
      person: z
        .string()
        .optional()
        .describe(
          "Who: a name, handle or person id. Matches who wrote it; on his own messages, the other side of a 1:1 chat"
        ),
      text_matches: z
        .string()
        .optional()
        .describe("A regular expression its text must match, any case"),
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
    ],
    resultType: "complete",
  };
}

export const PollParams = z.object({
  arguments: z.record(z.string(), z.unknown()).default({}),
  cursor: z.string().nullable().default(null),
  maxEvents: z.int().min(1).max(500).optional(),
  name: z.string(),
});

/**
 * One source's rows past `from`, resolved to its messages (read once, from the earliest new one's time, so a row is
 * what `read` makes of it: a newsletter or a draft it skips is no message). None at first: the cursor starts at now.
 */
function rowsOf(s: Messaging, from: number | undefined) {
  const { end, rows } = s.incoming(from ?? Number.MAX_SAFE_INTEGER);
  // Mail rebuilt its index (renumbered): start again at now, and say so.
  if (from === undefined || from > end) {
    return { end, from: end, rows: [], truncated: from !== undefined };
  }
  const since = rows.reduce((t, r) => (r.at < t ? r.at : t), rows[0]?.at ?? "");
  const read = since ? s.read(new Date(since)) : [];
  const byId = new Map(read.map((e) => [e.id, e]));
  return {
    end,
    from,
    rows: rows.flatMap((r) => {
      const e = byId.get(r.id);
      return e && !isLifeOutput(e) ? [[r.row, e] as [number, SourceEvent]] : [];
    }),
    truncated: false,
  };
}

/**
 * `events/poll`: the messages matching `arguments` past `cursor` (none: start at now). A source that cannot be read keeps
 * its place, so nothing it wrote meanwhile is skipped.
 */
export async function pollEvents(
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
  const a = parsed.data;
  const people = await readPeople();
  const wanted = a.person ? meant(a.person, people).known : undefined;
  if (a.person && !wanted) {
    throw new ProtocolError(INVALID_PARAMS, `No one goes by ${a.person}`);
  }
  const text = a.text_matches ? new RegExp(a.text_matches, "i") : undefined;
  const cursor = parseCursor(p.cursor ?? undefined);
  let truncated = false;
  const feeds: (Source<SourceEvent> & { from: number })[] = sources
    .filter((s) => !a.channels || a.channels.includes(s.name))
    .flatMap((s) => {
      try {
        const r = rowsOf(s, cursor[s.name]);
        truncated ||= r.truncated;
        return [{ end: r.end, from: r.from, name: s.name, rows: () => r.rows }];
      } catch {
        const at = cursor[s.name];
        return at === undefined
          ? []
          : [{ end: at, from: at, name: s.name, rows: () => [] }];
      }
    });
  const read = feeds.flatMap((f) => f.rows(0).map(([, e]) => e));
  const theirs = new Map(
    [...directChats(read, people.resolve)].flatMap(([who, list]) =>
      list.map((e) => [e.id, people.refOf(who)] as const)
    )
  );
  const personOf = (e: SourceEvent) =>
    e.fromMe
      ? (theirs.get(e.id) ?? null)
      : people.refOf(speakerOf("chat", e, people.resolve));
  const page = feedPage(
    feeds,
    Object.fromEntries(feeds.map((f) => [f.name, f.from])),
    p.maxEvents ?? PAGE,
    (_s, e) => {
      const person = personOf(e);
      const match =
        e.fromMe === a.from_me &&
        (!a.chat || e.chat === a.chat) &&
        (!wanted || person === `person:${wanted}`) &&
        (!text || text.test(e.text));
      return match
        ? {
            data: {
              at: e.at,
              chat: e.chat,
              ...(e.chatName ? { chatName: e.chatName } : {}),
              id: e.id,
              person,
              source: e.source,
            } satisfies z.infer<typeof Payload>,
            eventId: e.id,
            name: MESSAGE_RECEIVED,
            timestamp: e.at,
          }
        : null;
    }
  );
  return {
    cursor: page.cursor,
    events: page.items,
    hasMore: page.remaining > 0,
    nextPollMs: NEXT_POLL_MS,
    resultType: "complete",
    truncated,
  };
}
