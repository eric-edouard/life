import { realpath, stat } from "node:fs/promises";
import { basename } from "node:path";
import { clock, DAY } from "../core/clock";
import { digest } from "../core/hash";
import type { SourceName } from "../core/names";
import { redact } from "../core/redact";
import type { SourceEvent } from "../records/source";
import type { Descriptor, Outgoing, SendPath } from "../sources/contract";
import { directOf } from "./closeness";
import {
  draftProblemOf,
  isSendable,
  type MessageDraft,
  type StoredDraft,
} from "./draft";
import { OWNER } from "./read-truth";
import { enabledSources, sourceOf } from "./sources";
import { oneLineOf } from "./units";
import { type People, readPeople } from "./who";

// A card's draft, sent (AGENTS.md, "Life sends only…"): which chat a draft names and what of it the chat takes, checked
// and stamped when the card is asked, and the send itself, on his answer to its outgoing option (`answerDecision`, the
// only caller of `sendDraft`). A source sends through its send path (`Descriptor.send`).

/** How far back a draft's chat is looked for. ponytail: a chat silent for a year is unknown; widen it if one bites. */
const KNOWN_FOR = 365 * DAY;

/**
 * The largest file a draft may carry. It is read whole into memory, twice (asked, then sent), and a send with one
 * waits up to 60 s to upload and 60 s to be confirmed: a long upload may outlast the connector's call, and the outcome
 * then lands in `decision.answered` (`sendOf`, decisions.ts). ponytail: 100 MB; stream it if a bigger one is ever asked.
 */
const FILE_MAX = 100_000_000;

/** A draft's file as the card stamps it: read once, its bytes hashed. Throws `Not done: …` for a file it can't carry. */
async function stampFile(path: string) {
  const real = await realpath(path).catch(() => {
    throw new Error(`Not done: no file at ${path}.`);
  });
  const info = await stat(real);
  if (!info.isFile() || info.size > FILE_MAX) {
    throw new Error(
      `Not done: ${path} isn't a file Life can send (a regular file of at most ${FILE_MAX / 1e6} MB).`
    );
  }
  const bytes = await Bun.file(real).bytes();
  return {
    bytes,
    stamp: {
      mime: Bun.file(real).type.split(";")[0] as string,
      name: basename(path),
      path: real,
      sha256: digest("sha256", Buffer.from(bytes), 64),
      size: bytes.length,
    },
  };
}

/** A `not sent:` that his next tap would meet again (the file, the chat or the channel is not there): the outcome stores `canRetry: false`. */
const never = (why: string) =>
  Object.assign(new Error(`not sent: ${why}`), { canRetry: false as const });

/** The bytes of a stamped file, read now: only the ones he saw (the stamp's digest), else `not sent`. */
async function readVerifiedFile(file: NonNullable<StoredDraft["file"]>) {
  const bytes = await Bun.file(file.path)
    .bytes()
    .catch(() => {
      throw never("the file is gone");
    });
  if (digest("sha256", Buffer.from(bytes), 64) !== file.sha256) {
    throw never("the file changed since the card was asked");
  }
  return bytes;
}

/** The draft as a send path takes it. */
const outgoingOf = (d: StoredDraft, bytes?: Uint8Array): Outgoing => ({
  ...(d.cc ? { cc: d.cc } : {}),
  chat: d.chat ?? d.to,
  ...(d.file && bytes
    ? { file: { bytes, mime: d.file.mime, name: d.file.name } }
    : {}),
  ...(d.from ? { from: d.from, to: d.to } : {}),
  ...(d.mentions ? { mentions: d.mentions } : {}),
  ...(d.onMessage ? { onMessage: d.onMessage } : {}),
  ...(d.reaction ? { reaction: d.reaction } : {}),
  ...(d.subject ? { subject: d.subject } : {}),
  ...(d.text ? { text: d.text } : {}),
});

/**
 * The steps a send of `draft` reports, in order, the one place that decides them: a chat is checked for anyone
 * writing since (`chat_checked`), a mail has no chat; then the network takes it (`handed`) and it is seen (`confirmed`).
 */
export const sendStepsOf = (draft: StoredDraft, sources = enabledSources()) => [
  ...(isChat(sources.find((x) => x.name === draft.channel))
    ? [STEP.chatChecked]
    : []),
  STEP.handed,
  STEP.confirmed,
];

/** The names of a send's steps, as `onStep` hears them and the progress plan lists them: written here only. */
const STEP = {
  chatChecked: "chat_checked",
  confirmed: "confirmed",
  handed: "handed",
} as const;

/** Whether a send goes into a chat (checked for writing since), not a mail: the one test the steps and the check share. */
const isChat = (s?: Descriptor): s is Descriptor & { kind: "chat" } =>
  s?.kind === "chat";

/** A source whose messages a draft goes into: chat or mail. */
type Sending = Descriptor & { kind: "chat" | "mail" };

interface ChatSource {
  name: string;
  read: (since: Date) => SourceEvent[];
}

/** The one chat a draft names on source `s`, and the events read to find it. Throws `Not done: …`. */
async function chatOf(
  draft: MessageDraft,
  s: ChatSource,
  send: SendPath,
  now: Date
) {
  const events = s.read(new Date(now.getTime() - KNOWN_FOR));
  const byKey = events.filter((e) => e.chat === draft.to);
  const [person] = byKey.length
    ? []
    : directOf([draft.to], events, await readPeople());
  const chats = send.holds([
    ...new Set((person?.messages ?? byKey).map((e) => e.chat)),
  ]);
  let chat = chats[0] as string;
  let name = events.findLast((e) => e.chat === chat)?.chatName ?? draft.to;
  const opened = chats.length
    ? undefined
    : await send.opens?.(draft.to).catch((e: Error) => {
        throw new Error(
          `Not done: ${s.name} couldn't say whether ${draft.to} exists: ${e.message}.`
        );
      });
  if (opened) {
    // The id beside the name its owner gave himself: his card shows which account it goes to.
    chat = draft.to;
    name = `${opened} (${draft.to})`;
  } else if (chats.length !== 1) {
    throw new Error(
      chats.length
        ? `Not done: ${draft.to} has ${chats.length} chats on ${s.name}: give one as \`to\` (${chats.join(", ")}).`
        : `Not done: no chat of ${draft.to} on ${s.name} that it can send into: give a chat key from \`read_chats\` or a person's name${send.opensHint ? `, or ${send.opensHint}` : ""}.`
    );
  }
  return { chat, events, name };
}

/**
 * Where a draft goes and the message it answers: a chat's (`chatOf`), or a mail's, which has no chat (`to` is
 * addresses) and reads the source only for the message a reply quotes. `there` are the events a mention may name.
 */
async function readWhere(
  draft: MessageDraft,
  s: Sending,
  send: SendPath,
  now: Date
) {
  const mail = s.kind === "mail";
  const { chat, events, name } = mail
    ? {
        chat: undefined,
        events: draft.onMessage
          ? s.read(new Date(now.getTime() - KNOWN_FOR))
          : [],
        name: draft.to,
      }
    : await chatOf(draft, s, send, now);
  const there = mail ? events : events.filter((e) => e.chat === chat);
  const found = there.find((e) => e.id === draft.onMessage);
  if (draft.onMessage && !found) {
    throw new Error(
      `Not done: \`onMessage\` ${draft.onMessage} isn't a message of ${mail ? s.label : name}: give an id from \`read_chats\` for that ${mail ? "mail" : "chat"}.`
    );
  }
  const stranger = draft.mentions?.find(
    (m) => !there.some((e) => !e.fromMe && e.sender === m.sender)
  );
  if (stranger) {
    throw new Error(
      `Not done: ${stranger.sender} never wrote in ${name}: \`mentions\` takes the \`sender\` of a message there.`
    );
  }
  const quoted = found && {
    sender: found.sender,
    ...(mail && found.chatName ? { subject: found.chatName } : {}),
    text: found.text.slice(0, 300),
  };
  return { chat, name, quoted };
}

/**
 * The draft as it is stored when its card is asked: the one chat it names, on the source `channel` names (`to` a chat
 * key there, or a person with exactly one 1:1 chat there the source can send into, else a chat the source can open: a
 * new 1:1 chat by its id), the message it replies to or reacts to, its file as read now, the chat's own refusal of
 * anything it can't take. Throws `Not done: …` in words the asking agent can fix.
 */
export async function resolveDraft(
  draft: MessageDraft,
  now = clock(),
  sources = enabledSources()
): Promise<StoredDraft> {
  const sending = sources.filter(
    (x): x is Sending =>
      Boolean(x.send) && (x.kind === "chat" || x.kind === "mail")
  );
  const s = sending.find((x) => x.name === draft.channel);
  if (!s?.send) {
    throw new Error(
      `Not done: a draft's \`channel\` is the source it goes through: one of ${sending.map((x) => x.name).join(", ") || "none on this Mac"}.`
    );
  }
  const problem = draftProblemOf(
    draft,
    s.kind === "mail" ? "mail" : "chat",
    Boolean(s.send.opensWithSubject)
  );
  if (problem) {
    throw new Error(`Not done: ${problem}.`);
  }
  const block = await s.send.block();
  if (block) {
    throw new Error(`Not done: ${block}.`);
  }
  const { chat, name, quoted } = await readWhere(draft, s, s.send, now);
  const { file: path, ...fields } = draft;
  const file = path ? await stampFile(path) : undefined;
  const stored: StoredDraft = {
    ...fields,
    channel: s.name,
    ...(chat ? { chat } : {}),
    ...(file ? { file: file.stamp } : {}),
    ...(quoted ? { quoted } : {}),
    to: name,
  };
  const refusal = await s.send.refusal(outgoingOf(stored, file?.bytes));
  if (refusal) {
    throw new Error(`Not done: ${s.label} can't send this: ${refusal}.`);
  }
  return stored;
}

type OnStep = (step: string, detail?: Record<string, unknown>) => void;

/**
 * What was written in each card's draft chat after its `since`, oldest first, his own messages too: the one test of
 * "someone wrote since" (the send's refusal, and `withdrawDraftsAnsweredInChat`). None for a mail or a draft with no
 * chat. Each channel is read once, from its earliest `since`.
 * ponytail: the archive's copy can trail the network by its copier's interval, so a message written seconds ago may be missed.
 */
export function wroteSince(
  cards: { draft: StoredDraft; since: Date }[],
  sources = enabledSources()
) {
  const read = new Map<string | undefined, SourceEvent[]>(
    sources.filter(isChat).flatMap((s) => {
      const since = cards
        .filter((c) => c.draft.channel === s.name && c.draft.chat)
        .map((c) => c.since.getTime());
      return since.length > 0
        ? [[s.name, s.read(new Date(Math.min(...since)))] as const]
        : [];
    })
  );
  return cards.map(({ draft, since }) =>
    (read.get(draft.channel) ?? [])
      .filter((e) => e.chat === draft.chat && e.at > since.toISOString())
      .toSorted((a, b) => a.at.localeCompare(b.at))
  );
}

/** Everything before the hand-off: the draft as its path takes it, and that path, or why nothing goes (`sendDraft`). */
async function readySend(
  draft: StoredDraft,
  { onStep, since }: { onStep?: OnStep; since: Date },
  sources: Descriptor[]
) {
  const s = sources.find((x) => x.name === draft.channel);
  if (!isSendable(draft)) {
    throw never("the card has no chat to send into");
  }
  if (!s?.send) {
    throw never(s ? `${s.label} doesn't send` : `${draft.channel} is off`);
  }
  const block = await s.send.block();
  if (block) {
    throw new Error(`not sent: ${block}`);
  }
  const outgoing = outgoingOf(
    draft,
    draft.file && (await readVerifiedFile(draft.file))
  );
  const refusal = await s.send.refusal(outgoing);
  if (refusal) {
    throw never(refusal);
  }
  if (isChat(s)) {
    const wrote = wroteSince([{ draft, since }], [s])[0]?.at(-1);
    if (wrote) {
      throw Object.assign(
        new Error(
          `not sent: someone wrote in ${draft.to} since this card was asked`
        ),
        {
          wrote: {
            at: wrote.at,
            by: wrote.fromMe ? (await readPeople()).nameOf(OWNER) : draft.to,
            text: oneLineOf(redact(wrote.text), 120),
          },
        }
      );
    }
    onStep?.(STEP.chatChecked);
  }
  return { outgoing, path: s.send };
}

/**
 * Sends a stored draft once per `txn` (its decision), exactly as the card showed it: a file's bytes are read now and
 * must hash to its stamp, and a chat nobody wrote in since `since` (the card's asking, or his last attempt that went
 * nowhere; his own messages count) else nothing goes. `onStep` hears `chat_checked` (a chat only), `handed` (the
 * network took it) and `confirmed` (with the event id). Returns the sent message's id (Life's own where the path knows it). Throws why not:
 * anything that fails before the hand-off is `not sent:` (nothing left), whatever it says.
 */
export async function sendDraft(
  draft: StoredDraft,
  txn: string,
  steps: { onStep?: OnStep; since: Date },
  sources = enabledSources()
) {
  const { outgoing, path } = await readySend(draft, steps, sources).catch(
    (e: Error) => {
      throw e.message.startsWith("not sent:")
        ? e
        : new Error(`not sent: ${e.message}`);
    }
  );
  const id = await path.send(outgoing, txn, () => steps.onStep?.(STEP.handed));
  steps.onStep?.(STEP.confirmed, { eventId: id });
  return id;
}

/** How long sending this card's draft may take, at most (its send path's own waits), 0 for a source that doesn't send. */
export function sendLimitMs(draft: StoredDraft, sources = enabledSources()) {
  return (
    sources
      .find((x) => x.name === draft.channel)
      ?.send?.limitMs(outgoingOf(draft, draft.file && new Uint8Array())) ?? 0
  );
}

/**
 * Who a decision's draft goes to, as a person ref: its stored chat's handle (its source's `handleOf`), or a mail's `to`,
 * read through `resolve`. Null for a source whose chat keys hold no handle, a draft not yet resolved to a chat, or a
 * handle no one has.
 */
function draftPersonOf(people: Pick<People, "resolve">, d: StoredDraft) {
  const source = d.channel ? sourceOf(d.channel as SourceName) : undefined;
  const handle =
    source?.kind === "mail" ? d.to : d.chat && source?.handleOf?.(d.chat);
  return handle && d.channel
    ? people.resolve(handle, d.channel as SourceName)
    : null;
}

/** Each card with its `confirm`: on a decision whose draft goes to someone Life only guesses (`draftPersonOf`), that guess's card, one check asked beside it; none on every other card. */
export function withDraftConfirms<
  C extends { draft?: StoredDraft | null; group: string; ref: string },
>(cards: C[], people: Pick<People, "refOf" | "resolve">) {
  const guessed = new Map(
    cards
      .filter((x) => x.group === "guessed person")
      .map((x) => [people.refOf(x.ref), { ...x, confirm: [] }])
  );
  return cards.map((x) => {
    const person = x.draft && draftPersonOf(people, x.draft);
    const guess = person && guessed.get(people.refOf(person));
    return { ...x, confirm: guess ? [guess] : [] };
  });
}
