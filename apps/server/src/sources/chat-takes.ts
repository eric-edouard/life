import type { ChatTakes, Outgoing } from "./contract";

// What a chat takes besides text (a file, mentions, a reaction, a reply), as its send path knows it: a bridge's room
// features (`chatTakesOf`, matrix-content.ts), else the app's own limits. One rule refuses a draft by it
// (`takesProblemOf`, in every send path's `refusal`) and `read_chats` shows it to the agent drafting: they never disagree.

/** What of a draft the chat can't take, in words for the asking agent; none when it takes all of it. */
export function takesProblemOf(d: Outgoing, t: ChatTakes) {
  if (d.reaction) {
    if (!t.reaction) {
      return "this chat takes no reactions";
    }
    if (Array.isArray(t.reaction) && !t.reaction.includes(d.reaction)) {
      return `this chat takes only these reactions: ${t.reaction.join(" ")}`;
    }
  } else if (d.onMessage && !t.reply) {
    return "this chat takes no replies";
  }
  if (d.mentions && !t.mentions) {
    return "this chat takes no mentions";
  }
  return d.file && !t.file ? "this chat takes no files" : undefined;
}

/** What a chat takes, in words for the agent drafting into it (`read_chats` with its chat). */
export const takesWordsOf = (t: ChatTakes) =>
  `a draft into this chat takes text${t.file ? ", a file" : ""}${t.reply ? ", a reply (`onMessage`)" : ""}${t.reaction ? `, a reaction (an emoji on \`onMessage\`${Array.isArray(t.reaction) ? `: only ${t.reaction.join(" ")}` : ""})` : ""}${t.mentions ? ", mentions" : ""}; nothing else`;
