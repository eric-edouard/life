import { z } from "zod";
import { isoDateTime } from "../records/fields";
import { mentionsAt } from "../sources/matrix-content";
import { Party } from "./party";

// A card's draft (AGENTS.md, "Life sends only…"): what an agent gives (`MessageDraft`), what Life stores beside it when
// the card is asked (`StoredDraft`), and the rules both go by. Resolving and sending it is `draft-send.ts`.

const ONE_LINE = /^[^\n]*$/;
const EMOJI = /^\p{RGI_Emoji}$/v;
/** One line of at most `max` characters, shown whole on his card. */
export const oneLine = (max: number) =>
  z.string().min(1).max(max).regex(ONE_LINE, "one line");

/**
 * The exact message he approves, shown in full on his card (`resolveDraft`). Chat: `to`, then `text`, a `file`, or a
 * `reaction` (an emoji on `onMessage`, nothing else); `onMessage` alone is a reply; each `mentions` name is an `@name`
 * of `text`, in its order. Mail only: `from`, `subject`, `cc` (`to` then holds addresses).
 */
export const MessageDraft = z
  .object({
    cc: oneLine(400).optional(),
    /** The source it goes through (`whatsapp`, `instagram`…). */
    channel: z.string().min(1).max(40).optional(),
    /** An absolute path: Life sends the bytes it read when the card was asked (`StoredDraft.file`). */
    file: z.string().startsWith("/").max(1000).optional(),
    from: oneLine(200).optional(),
    mentions: z
      .array(
        z
          .object({
            name: oneLine(80),
            /** A message's sender in the chat, as `read_chats` gives it. */
            sender: oneLine(200),
          })
          .strict()
      )
      .max(10)
      .optional(),
    /** A message of the chat, by its id in `read_chats`: replied to, or reacted to. */
    onMessage: oneLine(300).optional(),
    /** One emoji (a joined one counts as one): Life sends only it. A refine, not a pattern: a tool's JSON schema can't carry the `v` flag. */
    reaction: z
      .string()
      .refine((s) => EMOJI.test(s), "one emoji")
      .optional(),
    subject: oneLine(200).optional(),
    text: z.string().min(1).max(4000).optional(),
    /** A chat key on `channel`, or a person with one 1:1 chat there; stored as the chat's name. */
    to: oneLine(400),
  })
  .strict();

export type MessageDraft = z.infer<typeof MessageDraft>;

/** One of the chat's last messages before a card was asked, as his card shows it above the draft: a mail's is its first line. */
export const RecentMessage = z
  .object({
    at: isoDateTime,
    /** Its first file; `size` when the file is on this Mac. */
    file: z
      .object({
        /** `fileKindOf`: photo, video, audio, pdf or document. */
        kind: z.string(),
        name: z.string(),
        size: z.int().min(0).optional(),
      })
      .strict()
      .optional(),
    sender: Party,
    text: z.string().optional(),
  })
  .strict();
export type RecentMessage = z.infer<typeof RecentMessage>;

/** What Life stamps on an `asked` line: the chat it resolved, the file as it read it, the message quoted, the chat's last messages. A card asked before has none and sends nothing. */
export const StoredDraft = MessageDraft.extend({
  chat: z.string().optional(),
  file: z
    .object({
      mime: z.string().min(1),
      name: z.string().min(1),
      /** Its real path (links followed). */
      path: z.string().startsWith("/"),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
      size: z.int().min(0),
    })
    .strict()
    .optional(),
  /** The message `onMessage` names: its sender, its first 300 characters and, for mail, its subject. */
  quoted: z
    .object({
      sender: z.string(),
      subject: z.string().optional(),
      text: z.string(),
    })
    .strict()
    .optional(),
  /** As asked: a card asked before reactions had to be one emoji still reads. */
  reaction: oneLine(16).optional(),
  /** The chat's last 3 messages within 90 days before the card was asked, oldest first (a mail's: the replied thread's last); empty for a new chat. Cards asked before 21 Nov 2026 have none. */
  recent: z.array(RecentMessage).max(3).optional(),
}).strict();
export type StoredDraft = z.infer<typeof StoredDraft>;

/** Whether a stored draft is one Life can send: it resolved a source and a chat (or, for mail, a sender). */
export const isSendable = (d?: StoredDraft): d is StoredDraft =>
  Boolean(d?.channel && (d.chat ?? d.from));

/** What breaks a draft's rules for chat or mail only; `subject` is a chat's when it opens with one (a new issue's title). */
function kindProblemOf(d: MessageDraft, mail: boolean, takesSubject: boolean) {
  if (!mail) {
    if (d.from || d.cc || (d.subject && !takesSubject)) {
      return `\`from\`${takesSubject ? "" : ", `subject`"} and \`cc\` are for mail: a chat takes none`;
    }
    return;
  }
  return d.from && d.subject
    ? undefined
    : "a mail draft needs `from` and `subject`";
}

/** What breaks the draft's rules beyond its shape, in words the agent can fix; none when nothing does. */
export function draftProblemOf(
  d: MessageDraft,
  kind: "chat" | "mail",
  takesSubject = false
) {
  if (!(d.text || d.file || d.reaction)) {
    return "a draft needs `text`, a `file` or a `reaction`";
  }
  if (d.reaction && !(d.onMessage && !d.text && !d.file && !d.mentions)) {
    return "a `reaction` is an emoji on `onMessage` and nothing else";
  }
  const found = mentionsAt(d.text ?? "", d.mentions ?? []);
  const missing = d.mentions?.find((_, i) => !found[i]);
  if (missing) {
    return `\`mentions\` names ${missing.name}: \`text\` needs \`@${missing.name}\` (whole, as a word), after the mentions before it`;
  }
  return kindProblemOf(d, kind === "mail", takesSubject);
}

const sizeWords = (n: number) =>
  n < 1e6 ? `${Math.ceil(n / 1e3)} kB` : `${(n / 1e6).toFixed(1)} MB`;

/** The draft as lines of words, for the nightly report: to and text first, then each other part it holds. */
export const draftWords = (d: StoredDraft) => [
  `Draft to ${d.to}${d.text ? `: "${d.text}"` : ""}`,
  ...(d.file ? [`File ${d.file.name} (${sizeWords(d.file.size)})`] : []),
  ...(d.quoted
    ? [
        `${d.reaction ? `Reaction ${d.reaction} to` : "Reply to"} ${d.quoted.sender}: "${d.quoted.text}"`,
      ]
    : []),
  ...(d.mentions
    ? [`Mentions ${d.mentions.map((m) => m.name).join(", ")}`]
    : []),
  ...(d.from ? [`From ${d.from}`] : []),
  ...(d.cc ? [`Cc ${d.cc}`] : []),
  ...(d.subject ? [`Subject ${d.subject}`] : []),
];
