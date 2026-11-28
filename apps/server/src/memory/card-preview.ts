import { createHash } from "node:crypto";
import type { z } from "zod";
import { type Ask, CARD_SELF_CHECK } from "./card-request";
import { onlyDraftOf, type StoredDraft } from "./draft";
import { needLineOf } from "./needs";

// The card preview: a card as his phone shows it, in text, handed to the asking agent before it is asked (the door's
// `request_decision`, his word of 22 Nov 2026: put yourself in his shoes, then ask whether that is the lightest way to
// put it). It follows his app's order (the push: `CardNotification.swift`; the card: `CheckCard.swift`, `DraftBlock.swift`)
// without its clipping, so the asker reads every word he could. Nothing is stored: the asker repeats the card with the
// digest (`previewed`) to ask it, and any change to the card or its chat previews again.

/** The card's preview, refused in place of its ask until the asker repeats it with `digest` (`askCard`). */
export class CardPreview extends Error {
  readonly preview: string;
  readonly digest: string;
  constructor(preview: string, digest: string) {
    super(`Not asked yet: ${preview}`);
    this.preview = preview;
    this.digest = digest;
  }
}

/** The digest of a checked card and its drafts as Life resolved them (their chats' last messages included). */
export const cardDigestOf = (ask: z.infer<typeof Ask>, drafts: StoredDraft[]) =>
  createHash("sha256")
    .update(JSON.stringify([ask, drafts]))
    .digest("hex")
    .slice(0, 12);

/** The draft as its block shows it: the chat, its last messages, the message replied to, then the draft. */
const draftLinesOf = (d: StoredDraft) => [
  `Draft to ${d.to}${d.people ? ` (${d.people} people)` : ""} on ${d.channel}:`,
  ...(d.recent ?? []).map(
    (m) =>
      `  ${m.sender.name}, ${m.at.slice(0, 16)}: ${m.text ?? m.file?.name ?? ""}`
  ),
  ...(d.quoted ? [`  replying to ${d.quoted.sender}: ${d.quoted.text}`] : []),
  ...(d.subject ? [`  Subject: ${d.subject}`] : []),
  ...(d.file ? [`  File: ${d.file.name}`] : []),
  `  > ${d.reaction ?? d.text ?? ""}`,
];

/** The card in text, in his app's order, then the self-check and how to ask it. */
export function cardPreviewOf(
  ask: z.infer<typeof Ask>,
  drafts: StoredDraft[],
  digest: string
) {
  const draft = onlyDraftOf({ drafts });
  const [first, ...rest] = ask.options;
  const tile = [
    ...(ask.plan ?? []).map(
      (p, i) =>
        `${i + 1}. ${p.text} (${p.by === "owner" ? "you" : "Life"})${p.when ? `, ${p.when}` : ""}`
    ),
    ...drafts.flatMap(draftLinesOf),
    ...(ask.needs ?? []).map(needLineOf),
  ];
  return [
    "Here is the card as he will see it. Nothing is asked yet.",
    `Push: ${ask.title} / ${draft ? (draft.reaction ?? draft.text ?? "") : ask.question}`,
    `Card: ${ask.question}`,
    ...(tile.length > 0
      ? [...tile, `"Why?" opens: ${ask.context}`]
      : [ask.context]),
    `Answers: [${first?.label}] ${rest.map((o) => `[${o.label}]`).join(" ")} [Tell the agent…]`,
    CARD_SELF_CHECK,
    `Ask it as it is: call \`request_decision\` again with the same card and \`previewed: "${digest}"\`. Better put another way: change it and call again, and you see it again.`,
  ].join("\n");
}
