import { DAY } from "../core/clock";
import { readJson, removeAllBut } from "../core/files";
import { digest } from "../core/hash";
import { stamp } from "../models/llm";
import {
  CommunicationStyle,
  CommunicationStyleLine,
} from "../records/communication-style";
import type { SourceEvent } from "../records/source";
import { directChats, pagedNow, type WithPeople } from "./closeness";
import { COMMUNICATION_STYLES, communicationStylePath } from "./ledger";
import { locate } from "./observe";
import { OWNER } from "./read-truth";
import { begin, inBatches, meContext } from "./run";
import { kindOf } from "./sources";
import { isLifeOutput } from "./units";
import { readPeople } from "./who";
import { localTime } from "./zones";

// `bun life memory communication-styles`: how the owner writes (docs/architecture.md, "The pipeline"), in general and
// to each person with a page, for an agent drafting a message for him. One call per person reads his latest messages
// to them (the night's `readWithPeople`, never older) and writes the style whole, at most once a week and only when he
// wrote something new. Nothing is sent.

const COMMUNICATION_STYLE_PROMPT = "memory-communication-style.v1";
/** His newest messages a style reads, per kind: enough to hear how he writes, whatever the years behind them. */
const SAMPLE = { chat: 120, mail: 30 } as const;
/** How old a style gets before new messages rebuild it: style moves slowly, a call a night per person would not. */
const REBUILD_AFTER = 7 * DAY;

const readStyle = (ref: string) => {
  const p = CommunicationStyle.safeParse(readJson(communicationStylePath(ref)));
  return p.success ? p.data : null;
};

/** A style's lines a reader shows; none when there is none. */
export const readCommunicationStyle = (ref: string) =>
  readStyle(ref)?.lines ?? [];

/** Style lines as a reader shows them, under `title`; nothing when there is none. */
export const communicationStyleBlock = (
  title: string,
  lines: CommunicationStyleLine[]
) =>
  lines.length > 0
    ? [
        `${title} (how he writes, read weekly from his latest messages; follow it when drafting for him):`,
        ...lines.map(
          (l) =>
            `- ${l.kind ?? "general"}${l.source ? ` (${l.source})` : ""}: ${l.text}${l.examples.length > 0 ? ` E.g. ${l.examples.map((x) => `"${x}"`).join(", ")}` : ""}`
        ),
        "",
      ]
    : [];

/** His newest messages of each kind (`SAMPLE`), oldest first, as the prompt reads them. */
export function sampleOf(sent: SourceEvent[]) {
  const newest = (kind: "chat" | "mail") =>
    sent
      .filter((e) => kindOf(e.source) === kind)
      .toSorted((a, b) => a.at.localeCompare(b.at))
      .slice(-SAMPLE[kind])
      .map((e) => ({ at: localTime(e.at), source: e.source, text: e.text }));
  return { chat: newest("chat"), mail: newest("mail") };
}

/**
 * The reply's lines, each example kept only as his own words in a chat message he was shown (`locate`): a mail's text
 * holds quoted history, never an example. A `source` he wrote nothing in is dropped.
 */
export function styleLines(
  reply: unknown,
  { chat, mail }: ReturnType<typeof sampleOf>
) {
  const list = (reply as { lines?: unknown } | null)?.lines;
  const shown = chat.map((m) => m.text);
  const sources = new Set<string>([...chat, ...mail].map((m) => m.source));
  return (Array.isArray(list) ? list : []).flatMap((raw) => {
    const l = CommunicationStyleLine.safeParse(raw);
    if (!l.success) {
      return [];
    }
    const examples = l.data.examples.flatMap((x) => {
      const found = locate(x, shown);
      return found ? [found.verbatim] : [];
    });
    const { source, ...line } = l.data;
    return [
      {
        ...line,
        examples,
        ...(source && sources.has(source) ? { source } : {}),
      },
    ];
  });
}

/** Whether a style is due: none yet, or a week old with new messages behind it. */
export const isDue = (
  last: { built: string; inputs: string } | null,
  inputs: string,
  now: Date
) =>
  !last ||
  (last.inputs !== inputs &&
    now.getTime() - Date.parse(last.built) >= REBUILD_AFTER);

export async function communicationStyles({ events, failed }: WithPeople) {
  const step = await begin("communication-style", "main", {
    prompt: COMMUNICATION_STYLE_PROMPT,
  });
  // A source that could not be read would look like he stopped writing there: nothing is written or removed.
  if (failed.length > 0) {
    return step.end({ unread: failed, written: 0 });
  }
  const people = await readPeople();
  const paged = await pagedNow(people);
  const sentIn = (list: SourceEvent[]) =>
    list.filter((e) => e.fromMe && !e.bulk && !isLifeOutput(e));
  const direct = directChats(events, people.resolve);
  const targets = [...paged].flatMap((ref) => {
    const sample = sampleOf(
      sentIn(ref === OWNER ? events : (direct.get(ref) ?? []))
    );
    return sample.chat.length + sample.mail.length > 0 ? [{ ref, sample }] : [];
  });
  let written = 0;
  await inBatches(targets, step.dir, (t, dir) =>
    step.attempt(
      async () => {
        const input = {
          person: t.ref === OWNER ? OWNER : (people.names.get(t.ref) ?? t.ref),
          ...t.sample,
        };
        const inputs = digest(
          "sha256",
          `${COMMUNICATION_STYLE_PROMPT}\n${JSON.stringify(input)}`,
          16
        );
        if (!isDue(readStyle(t.ref), inputs, step.now)) {
          return;
        }
        const reply = await step.ask({
          context: meContext(people.truth),
          dir,
          input,
          prompt: COMMUNICATION_STYLE_PROMPT,
        });
        const lines = styleLines(reply, t.sample);
        // A reply with no line is a failed call: the last style stays, the next run retries.
        if (lines.length === 0) {
          throw new Error("no style line");
        }
        const style: CommunicationStyle = {
          built: step.now.toISOString(),
          inputs,
          lines,
          madeBy: stamp(step.llm, COMMUNICATION_STYLE_PROMPT, step.run),
          page: t.ref,
          schemaVersion: 1,
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
  // A style whose person lost their page, or he no longer writes to, goes.
  const gone = await removeAllBut(
    COMMUNICATION_STYLES,
    new Set(targets.map((t) => communicationStylePath(t.ref)))
  );
  return step.end({ gone, styles: targets.length, written });
}
