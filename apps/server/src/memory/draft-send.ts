import { clock, DAY } from "../core/clock";
import { directOf } from "./closeness";
import { enabledSources } from "./sources";
import { readPeople } from "./who";

// A card's draft, sent (AGENTS.md, "Life sends only…"): which chat a draft names, checked when the card is asked, and
// the send itself, on his answer to its outgoing option (`answerDecision`, the only caller of `sendDraft`). A source
// sends through its send path (`Descriptor.send`).

/** How far back a draft's chat is looked for. ponytail: a chat silent for a year is unknown; widen it if one bites. */
const KNOWN_FOR = 365 * DAY;

/**
 * The one chat a draft names, on the source `channel` names: `to` a chat key there, or a person with exactly one 1:1
 * chat there the source can send into, else a chat the source can open (a new 1:1 chat by its id). Throws `Not done: …`
 * in words the asking agent can fix.
 */
export async function readDraftChat(
  draft: { channel?: string; to: string },
  now = clock(),
  sources = enabledSources()
) {
  const sending = sources.filter((x) => x.send && x.kind === "chat");
  const s = sending.find((x) => x.name === draft.channel);
  if (!(s?.send && s.kind === "chat")) {
    throw new Error(
      `Not done: a draft's \`channel\` is the source it goes through: one of ${sending.map((x) => x.name).join(", ") || "none on this Mac"}.`
    );
  }
  const block = await s.send.block();
  if (block) {
    throw new Error(`Not done: ${block}.`);
  }
  const events = s.read(new Date(now.getTime() - KNOWN_FOR));
  const byKey = events.filter((e) => e.chat === draft.to);
  const [person] = byKey.length
    ? []
    : directOf([draft.to], events, await readPeople());
  const chats = s.send.holds([
    ...new Set((person?.messages ?? byKey).map((e) => e.chat)),
  ]);
  if (chats.length === 0) {
    const name = await s.send.opens?.(draft.to).catch((e: Error) => {
      throw new Error(
        `Not done: ${s.name} couldn't say whether ${draft.to} exists: ${e.message}.`
      );
    });
    if (name) {
      // The id beside the name its owner gave himself: his card shows which account it goes to.
      return { chat: draft.to, name: `${name} (${draft.to})`, source: s.name };
    }
  }
  if (chats.length !== 1) {
    throw new Error(
      chats.length
        ? `Not done: ${draft.to} has ${chats.length} chats on ${s.name}: give one as \`to\` (${chats.join(", ")}).`
        : `Not done: no chat of ${draft.to} on ${s.name} that it can send into: give a chat key from \`read_chats\` or a person's name${s.send.opens ? ", or a new person's id as <digits>@s.whatsapp.net (a group it never saw can't be opened)" : ""}.`
    );
  }
  const chat = chats[0] as string;
  const name = events.findLast((e) => e.chat === chat)?.chatName ?? draft.to;
  return { chat, name, source: s.name };
}

/** Sends a card's `text` into `chat` on `source`, once per `txn` (its decision); returns the sent message's id. Throws why not. */
export async function sendDraft(
  source: string,
  chat: string,
  text: string,
  txn: string
) {
  const s = enabledSources().find((x) => x.name === source);
  if (!s?.send) {
    throw new Error(
      `not sent: ${s ? `${s.label} doesn't send` : `${source} is off`}`
    );
  }
  const block = await s.send.block();
  if (block) {
    throw new Error(`not sent: ${block}`);
  }
  return s.send.send({ chat, text }, txn);
}
