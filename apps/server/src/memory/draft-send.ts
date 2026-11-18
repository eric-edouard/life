import { clock, DAY } from "../core/clock";
import type { Descriptor } from "../sources/contract";
import { isBridgeAdded, readBlock, sendText } from "../sources/matrix";
import { directOf } from "./closeness";
import { enabledSources } from "./sources";
import { readPeople } from "./who";

// A card's draft, sent (AGENTS.md, "Life sends only…"): which chat a draft names, checked when the card is asked, and
// the send itself, on his answer to its outgoing option (`answerDecision`, the only caller of `sendDraft`). A source
// sends when it has a room for the chat (`roomOf`) and the bridge of its name is added and linked.

/** How far back a draft's chat is looked for. ponytail: a chat silent for a year is unknown; widen it if one bites. */
const KNOWN_FOR = 365 * DAY;

/** Why a source can't send now, from the bridge itself; none when it can. */
async function sendBlockOf(s: Descriptor) {
  if (!s.roomOf) {
    return `${s.label} doesn't send`;
  }
  if (!isBridgeAdded(s.name)) {
    return `${s.label}'s bridge isn't on this Mac`;
  }
  return await readBlock(s.name);
}

/**
 * The one chat a draft names, on the source `channel` names: `to` a chat key there, or a person with exactly one 1:1
 * chat there the bridge holds a room for. Throws `Not done: …` in words the asking agent can fix.
 */
export async function readDraftChat(
  draft: { channel?: string; to: string },
  now = clock(),
  sources = enabledSources()
) {
  const sending = sources.filter((s) => s.roomOf && s.kind === "chat");
  const s = sending.find((x) => x.name === draft.channel);
  if (!(s?.roomOf && s.kind === "chat")) {
    throw new Error(
      `Not done: a draft's \`channel\` is the source it goes through: one of ${sending.map((x) => x.name).join(", ") || "none on this Mac"}.`
    );
  }
  const block = await sendBlockOf(s);
  if (block) {
    throw new Error(`Not done: ${block}.`);
  }
  const events = s.read(new Date(now.getTime() - KNOWN_FOR));
  const byKey = events.filter((e) => e.chat === draft.to);
  const [person] = byKey.length
    ? []
    : directOf([draft.to], events, await readPeople());
  const chats = [
    ...new Set((person?.messages ?? byKey).map((e) => e.chat)),
  ].filter((c) => s.roomOf?.(c));
  if (chats.length !== 1) {
    throw new Error(
      chats.length
        ? `Not done: ${draft.to} has ${chats.length} chats on ${s.name}: give one as \`to\` (${chats.join(", ")}).`
        : `Not done: no chat of ${draft.to} on ${s.name} that its bridge holds: give a chat key from \`read_chats\` or a person's name.`
    );
  }
  const chat = chats[0] as string;
  const name = events.findLast((e) => e.chat === chat)?.chatName ?? draft.to;
  return { chat, name, source: s.name };
}

/** Sends a card's `text` into `chat` on `source`, once per `txn` (its decision); returns the Matrix event. Throws why not. */
export async function sendDraft(
  source: string,
  chat: string,
  text: string,
  txn: string
) {
  const s = enabledSources().find((x) => x.name === source);
  const block = s ? await sendBlockOf(s) : `${source} is off`;
  const room = s?.roomOf?.(chat);
  if (block || !(s && room)) {
    throw new Error(`not sent: ${block ?? "no bridge room for this chat"}`);
  }
  return sendText(s.name, room, text, txn);
}
