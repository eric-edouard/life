import { beforeEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import type { CardPreview } from "./card-preview";
import { DECISIONS } from "./decision-lines";
import { decisionsNow, requestDecision } from "./decisions";

const NOW = new Date("2026-11-18T09:00:00.000Z");
const card = {
  context: "Kit's quote came in at 400 euros.",
  deadline: new Date(NOW.getTime() + 2 * 86_400_000).toISOString(),
  draft: { channel: "whatsapp", text: "Can you come Friday?", to: "Kit" },
  onSilence: "wait",
  options: [
    { id: "send", label: "Send it", outgoing: true },
    { id: "wait", label: "Wait" },
  ],
  question: "Ask Kit to come Friday?",
  title: "Fix the boiler",
};
/** Life's reading of the draft's chat, made up: Kit's one WhatsApp chat, its last message `text`. */
const chatWith = (text: string) => () =>
  Promise.resolve({
    ...card.draft,
    chat: "155@s.whatsapp.net",
    recent: [
      {
        at: NOW.toISOString(),
        sender: {
          kind: "person" as const,
          name: "Kit Moreau",
          ref: "person:kit",
        },
        text,
      },
    ],
    to: "Kit Moreau",
  });
/** The preview the card comes back as, given the digest the asker saw; none once it is asked. */
const previewOf = (text: string, seen: string | null) =>
  requestDecision("planner", card, NOW, chatWith(text), { seen }).then(
    () => undefined,
    (e: CardPreview) => e
  );

beforeEach(() => rmSync(DECISIONS, { force: true }));

// His load (22 Nov 2026): a card the door previews shows its draft with the chat's last messages, and a new message
// in that chat previews it again, nothing asked meanwhile.
test("a previewed draft card shows its chat and draft; a new message in the chat previews it again", async () => {
  const first = await previewOf("Friday works?", null);
  expect(first?.preview).toContain("Draft to Kit Moreau on whatsapp:");
  expect(first?.preview).toContain(
    "Kit Moreau, 2026-11-18T09:00: Friday works?"
  );
  expect(first?.preview).toContain("> Can you come Friday?");
  const again = await previewOf("Or Monday?", first?.digest ?? "");
  expect(again?.digest).not.toBe(first?.digest);
  expect(decisionsNow(NOW)).toHaveLength(0);
  expect(await previewOf("Or Monday?", again?.digest ?? "")).toBeUndefined();
  expect(decisionsNow(NOW)).toHaveLength(1);
});
