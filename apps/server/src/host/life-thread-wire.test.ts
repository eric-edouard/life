import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { rmSync } from "node:fs";
import { DAY } from "../core/clock";
import { appendJsonl } from "../core/files";
import { setSettings } from "../core/settings";
import { decisionCardOf } from "../memory/checks";
import { recordDelivered } from "../memory/decision-delivery";
import { DECISIONS, Withdrawn, withdrawnOf } from "../memory/decision-lines";
import { requestDecision } from "../memory/decisions";
import { answerWithResult } from "./answer-result";
import { expectWire } from "./http/wire-fixture";
import { readThread } from "./life-thread";

// The thread as the phone's end-to-end tests read it (`apps/lifelog/apps/ios/E2E`): one made-up draft card in each state.
// Made-up people and chats throughout.

const spies: ReturnType<typeof spyOn>[] = [];
const OPTIONS = [
  { id: "send", label: "Send it", outgoing: true as const },
  { id: "wait", label: "Wait" },
];
const card = async (channel: string, title: string) => {
  const draft = { channel, text: "Can you come Friday?", to: "Kit" };
  const { id } = await requestDecision(
    "planner",
    {
      context: "A made-up reason to ask.",
      deadline: new Date(Date.now() + 2 * DAY).toISOString(),
      draft,
      follow: [],
      onSilence: "wait",
      options: OPTIONS,
      question: "Send Kit the message?",
      recommended: "send",
      title,
    },
    new Date(Date.now() - 3_600_000),
    () =>
      Promise.resolve({
        ...draft,
        chat: "155@s.whatsapp.net",
        to: "Kit Moreau",
      })
  );
  recordDelivered(
    id,
    { rules: ["good moment"], verdict: "deliver" },
    new Date(Date.now() - 3_600_000)
  );
  return id;
};

/** The ids of the cards the inbox holds open now. */
let open: string[] = [];

/** `read_thread` with the cards of `open` as the inbox holds them (`decisionCardOf`: the card's own part). */
const thread = async () => {
  const page = (await readThread()) as { items: unknown[] };
  return { ...page, version: "fixed" };
};

beforeEach(async () => {
  open = [];
  spies.push(
    spyOn(await import("./inbox"), "openChecksNow").mockImplementation(
      async () => {
        const { decisionsNow } = await import("../memory/decisions");
        return decisionsNow()
          .filter((d) => open.includes(d.id))
          .map(
            (d) =>
              ({
                about: [],
                agent: null,
                asker: d.asker,
                at: d.at,
                clips: [],
                context: d.context || null,
                deadline: d.deadline,
                draft: d.draft ?? null,
                group: "decision",
                isPlan: false,
                kind: "decision",
                likelyPeople: [],
                links: [],
                onMatters: [],
                onSilence: d.onSilence,
                ...decisionCardOf(d),
                pushId: `push-${d.id}`,
                question: d.question,
                ref: d.id,
                title: d.title,
                urgency: "blocks",
              }) as never
          );
      }
    ),
    spyOn(await import("../memory/who"), "readPeople").mockResolvedValue(
      {} as never
    ),
    spyOn(
      await import("../memory/matters"),
      "readMatterBook"
    ).mockResolvedValue([]),
    spyOn(await import("../memory/draft-send"), "sendDraft").mockResolvedValue(
      "$ev1"
    ),
    spyOn(await import("../memory/checks"), "checksNow").mockResolvedValue([])
  );
  rmSync(DECISIONS, { force: true });
  setSettings({ desk: { defaultRuntime: "claude", runtimes: { claude: {} } } });
});
afterEach(() => {
  for (const s of spies.splice(0)) {
    s.mockRestore();
  }
  setSettings({ desk: null });
  rmSync(DECISIONS, { force: true });
});

test("an open draft card, a sent iMessage draft with no Undo and a card that went outdated, as read_thread gives them", async () => {
  open = [await card("whatsapp", "Ask Kit")];
  expectWire("read_thread_draft", await thread(), true);
  rmSync(DECISIONS, { force: true });
  const sent = await card("imessage", "Ask Kit");
  open = [sent];
  await answerWithResult(
    sent,
    { options: ["send"] },
    { answerKey: "tap-1", report: () => undefined }
  );
  open = [];
  const settled = await thread();
  expect(JSON.stringify(settled)).toContain('"settled"');
  expect(JSON.stringify(settled)).toContain('"undo":null');
  expectWire("read_thread_settled_imessage", settled, true);
  rmSync(DECISIONS, { force: true });
  const gone = await card("whatsapp", "Ask Kit");
  appendJsonl(DECISIONS, Withdrawn, [
    withdrawnOf(gone, new Date(), "Kit wrote since"),
  ]);
  const outdated = await thread();
  expect(JSON.stringify(outdated)).toContain('"outdated"');
  expectWire("read_thread_outdated", outdated, true);
});
