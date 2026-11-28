import { z } from "zod";
import { DAY } from "../core/clock";
import { readJson } from "../core/files";
import { newestWithin } from "../core/lists";
import { AGENT_WORD } from "../core/names";
import {
  CommunicationStyle,
  CommunicationStyleLine,
} from "../records/communication-style";
import type { SourceEvent } from "../records/source";
import { directChats, pagedNow, type WithPeople } from "./closeness";
import { sendOf } from "./decision-fold";
import type { Decision } from "./decision-lines";
import { decisionsNow } from "./decisions";
import { communicationStylePath } from "./memory-files";
import { meContext } from "./model-context";
import { foundQuotesAt } from "./quote-check";
import { OWNER } from "./read-truth";
import { begin, inBatches, inputsOf, isDue, readsOf, replyLines } from "./run";
import { kindOf } from "./sources";
import { dayUnitId } from "./unit-ids";
import { clip, isLifeOutput, textOf } from "./units";
import { readPeople } from "./who";
import { localTime } from "./zones";

// `bun life memory communication-styles`: how each person with a page writes to him and he to them (docs/architecture.md,
// "The pipeline"), for an agent drafting a message for him. One call per person reads their newest 1:1 chat messages and
// mails (the night's `readWithPeople`, never older), both ways, and writes the style whole when those changed and it is a
// week old. Nothing is sent.

const COMMUNICATION_STYLE_PROMPT = "memory-communication-style.v2";
/** The newest messages a style reads, per kind: enough to hear how each writes, whatever the years behind them. */
const SAMPLE = { chat: 120, mail: 30 } as const;
/** The most of one message shown: a mail's text can run on into quoted history. */
const MESSAGE_CHARS = { chat: 500, mail: 800 } as const;
/** How old a style gets before new messages rebuild it: style moves slowly, a call a night per person would not. */
const REBUILD_AFTER = 7 * DAY;
/** The most calls a night makes (the newest messages first): a first run over everyone spreads over nights. */
const STYLE_CALLS = 200;

const readStyle = (ref: string) => {
  const p = CommunicationStyle.safeParse(readJson(communicationStylePath(ref)));
  return p.success ? p.data : null;
};

/** A style's lines a reader shows, none when there is none (or it is in the 6 Nov shape). */
export const readCommunicationStyle = (ref: string) =>
  readStyle(ref)?.lines ?? [];

/** Style lines as `now` shows them: each writer's, with its first quote. Nothing when there is none. */
export const communicationStyleBlock = (lines: CommunicationStyleLine[]) =>
  lines.length > 0
    ? [
        `How you write to them and how they write to you (read every ${REBUILD_AFTER / DAY} days from your latest 1:1 messages; follow yours when drafting):`,
        ...lines.map((l) => {
          const [q] = l.quotes;
          return `- ${l.writer === "owner" ? "you" : "they"}${l.kind ? `, ${l.kind}` : ""}${l.source ? ` (${l.source})` : ""}: ${l.text}${q ? ` E.g. "${q.text}"` : ""}`;
        }),
        "",
      ]
    : [];

/**
 * The communication styles of `refs` (people), each headed by the person's name (`nameOf`): what an agent drafting to
 * them follows (a matter's read, an agent's packet, `read_chats` with one `who`). Nothing for one with no style.
 */
export const communicationStylesOf = (
  refs: readonly string[],
  nameOf: (ref: string) => string
) =>
  refs.flatMap((ref) => {
    const block = communicationStyleBlock(readCommunicationStyle(ref));
    return block.length > 0 ? [`With ${nameOf(ref)}:`, ...block] : [];
  });

/** One message of a sample as the call is shown it. */
interface Shown {
  at: string;
  fromMe: boolean;
  source: SourceEvent["source"];
  text: string;
  /** Its chat-day (`dayUnitId`): what the call read, as its `reads` count. */
  unit: string;
}

/** A message as a sent draft is keyed: its source, its chat and its text. */
const draftKeyOf = (source: string, chat: string, text: string) =>
  `${source}|${chat}|${text.trim()}`;

/** The drafts Life sent for him from a card (`answerDecision`), keyed as his messages coming back from the chat are. */
export const sentDraftsOf = (list: Decision[]) =>
  new Set(
    list.flatMap((d) =>
      d.drafts.flatMap((x, i) =>
        sendOf(d.sends, i) && x.chat && x.channel && x.text
          ? [draftKeyOf(x.channel, x.chat, x.text)]
          : []
      )
    )
  );

/**
 * Their 1:1 messages a style reads: both ways, the newest `SAMPLE` of each kind, oldest first. Life's own output, the
 * drafts Life sent for him (`sent`, his words everywhere else) and the agent's reports are never writing (drafts must
 * not learn from drafts), nor is a call.
 */
export function styleSampleOf(direct: SourceEvent[], sent = new Set<string>()) {
  const writing = direct.filter(
    (e) =>
      !(
        e.phoneCall ||
        e.bulk ||
        isLifeOutput(e) ||
        e.source === AGENT_WORD ||
        (e.fromMe && sent.has(draftKeyOf(e.source, e.chat, e.text)))
      ) && e.text.trim() !== ""
  );
  const newest = (kind: "chat" | "mail"): Shown[] =>
    writing
      .filter((e) => kindOf(e.source) === kind)
      .toSorted((a, b) => a.at.localeCompare(b.at))
      .slice(-SAMPLE[kind])
      .map((e) => ({
        at: e.at,
        fromMe: e.fromMe,
        source: e.source,
        text: clip(textOf(e), MESSAGE_CHARS[kind]),
        unit: dayUnitId(e),
      }));
  return { chat: newest("chat"), mail: newest("mail") };
}

/** The sample as the prompt reads it: `him` or `them` on each message. */
export const inputOf = (
  person: string,
  sample: ReturnType<typeof styleSampleOf>
) => {
  const shown = (m: Shown) => ({
    at: localTime(m.at),
    source: m.source,
    text: m.text,
    who: m.fromMe ? "him" : "them",
  });
  return {
    chat: sample.chat.map(shown),
    mail: sample.mail.map(shown),
    person,
  };
};

const ReplyLine = z.object({
  kind: z.string().nullish(),
  quotes: z.array(z.string()).catch([]),
  source: z.string().nullish(),
  text: z.string(),
  writer: z.string(),
});

/**
 * The reply's lines, each quote kept only as words found in a chat message that writer sent in the sample (a mail's text
 * holds quoted history), with the message's time. A line of no known shape goes; a `source` not shown goes.
 */
export function styleLines(
  reply: unknown,
  sample: ReturnType<typeof styleSampleOf>
) {
  const sources = new Set(
    [...sample.chat, ...sample.mail].map((m) => m.source)
  );
  return replyLines(reply, ReplyLine).flatMap((r) => {
    const quotes = foundQuotesAt(
      r.quotes,
      sample.chat.filter((m) => m.fromMe === (r.writer === "owner"))
    );
    const { kind, source, text, writer } = r;
    const l = CommunicationStyleLine.safeParse({
      kind: kind ?? null,
      quotes,
      text,
      writer,
      ...(source && sources.has(source as SourceEvent["source"]) && { source }),
    });
    return l.success ? [l.data] : [];
  });
}

/** Each paged person's sample, those with any 1:1 chat or mail only. */
export const communicationStyleTargetsOf = (
  paged: Set<string>,
  direct: Map<string, SourceEvent[]>,
  sent = new Set<string>()
) =>
  [...paged].flatMap((ref) => {
    const sample = styleSampleOf(
      ref === OWNER ? [] : (direct.get(ref) ?? []),
      sent
    );
    return sample.chat.length + sample.mail.length > 0 ? [{ ref, sample }] : [];
  });

export async function communicationStyles({ events, failed }: WithPeople) {
  const step = await begin("communication-style", "main", {
    prompt: COMMUNICATION_STYLE_PROMPT,
  });
  // A source that could not be read would look like they stopped writing there: nothing is written or removed.
  if (failed.length > 0) {
    return step.end({ unread: failed, written: 0 });
  }
  const people = await readPeople();
  const direct = directChats(events, people.resolve);
  const targets = communicationStyleTargetsOf(
    await pagedNow(people),
    direct,
    sentDraftsOf(decisionsNow())
  ).map((t) => {
    const input = inputOf(people.nameOf(t.ref), t.sample);
    return { ...t, input, inputs: inputsOf(COMMUNICATION_STYLE_PROMPT, input) };
  });
  const newest = (t: (typeof targets)[number]) =>
    [...t.sample.chat, ...t.sample.mail]
      .map((m) => m.at)
      .sort()
      .at(-1) ?? "";
  const due = newestWithin(
    targets.filter((t) =>
      isDue(readStyle(t.ref), t.inputs, step.now, REBUILD_AFTER)
    ),
    STYLE_CALLS,
    { at: newest, size: () => 1 }
  );
  let written = 0;
  await inBatches(due, step, (t, dir) =>
    step.attempt(
      async () => {
        const reply = await step.ask({
          context: meContext(people.truth),
          dir,
          input: t.input,
          prompt: COMMUNICATION_STYLE_PROMPT,
          reads: readsOf(
            [...t.sample.chat, ...t.sample.mail].map((m) => ({
              source: m.source,
              unit: m.unit,
            }))
          ),
        });
        const lines = styleLines(reply, t.sample);
        // A reply with no line is a failed call: the last style stays, the next run retries.
        if (lines.length === 0) {
          throw new Error("no style line");
        }
        const style: CommunicationStyle = {
          built: step.now.toISOString(),
          inputs: t.inputs,
          lines,
          madeBy: step.madeBy(COMMUNICATION_STYLE_PROMPT),
          page: t.ref,
          schemaVersion: 2,
        };
        await Bun.write(
          communicationStylePath(t.ref),
          `${JSON.stringify(style, null, 1)}\n`
        );
        written += 1;
      },
      { page: t.ref }
    )
  );
  // A file is only overwritten when its person is due, never removed.
  return step.end({ styles: targets.length, written });
}
