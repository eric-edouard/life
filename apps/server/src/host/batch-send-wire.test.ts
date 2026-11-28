import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { rmSync } from "node:fs";
import { DAY, HOUR } from "../core/clock";
import { appendJsonl } from "../core/files";
import { DECISIONS, DECISIONS_VERSION, Line } from "../memory/decision-lines";
import { answerDecision } from "../memory/decisions";
import type { sendDraft } from "../memory/draft-send";
import { decisionCursorOf, pollDecisions } from "./events";

// A batch's outcome as its asker hears it (the owner's decision of 28 Nov 2026): each draft's, in order, so it can ask
// a new card for those that did not go.

const NOW = new Date("2026-11-18T09:00:00.000Z");
const ID = "dec_0000000000b2";
const chats = ["111@s.whatsapp.net", "222@s.whatsapp.net"];

beforeEach(() => rmSync(DECISIONS, { force: true }));
afterEach(() => setSystemTime());

test("a partly sent batch: its asker hears `sends`, each draft's event or why not, and no `send`", async () => {
  appendJsonl(DECISIONS, Line, [
    {
      asker: "planner",
      at: NOW.toISOString(),
      context: "",
      deadline: new Date(NOW.getTime() + 2 * DAY).toISOString(),
      drafts: chats.map((chat, i) => ({
        channel: "whatsapp",
        chat,
        text: `Party on Saturday? (${i})`,
        to: `Guest ${i}`,
      })),
      id: ID,
      kind: "asked",
      links: [],
      onSilence: null,
      options: [
        { id: "send", label: "Send all", outgoing: true },
        { id: "no", label: "Not now" },
      ],
      question: "Send the two invites?",
      schemaVersion: DECISIONS_VERSION,
      title: "Invite to the party",
    },
  ]);
  const at = new Date(NOW.getTime() + HOUR);
  setSystemTime(at);
  const deliver: typeof sendDraft = (d) =>
    d.chat === chats[0]
      ? Promise.resolve("$a")
      : Promise.reject(new Error("not sent: someone wrote since"));
  await answerDecision(ID, ["send"], undefined, {
    deliver,
    now: at,
    via: "connector",
  });
  setSystemTime(new Date(at.getTime() + HOUR));
  const { events } = pollDecisions(
    "decision.answered",
    decisionCursorOf(NOW),
    "planner"
  );
  expect(events.map((e) => e.data)).toMatchObject([
    {
      id: ID,
      sends: [{ eventId: "$a" }, { error: "not sent: someone wrote since" }],
    },
  ]);
  expect(events[0]?.data).not.toHaveProperty("send");
});
