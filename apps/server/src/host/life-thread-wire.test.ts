import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { rmSync } from "node:fs";
import { DAY } from "../core/clock";
import { appendJsonl } from "../core/files";
import { setSettings } from "../core/settings";
import { decisionCardOf } from "../memory/checks";
import { recordDelivered } from "../memory/decision-delivery";
import { DECISIONS, Withdrawn, withdrawnOf } from "../memory/decision-lines";
import { requestDecision } from "../memory/decisions";
import { withNetworkIdentity } from "../memory/network-identity";
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
        recent: [
          {
            at: new Date(Date.now() - 7_200_000).toISOString(),
            sender: KIT,
            text: "Are you around this week?",
          },
        ],
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

const KIT = {
  kind: "person" as const,
  name: "Kit Moreau",
  ref: "person:inf_kit",
};
/** Who the cards' chats resolve to, as the inbox's `withNetworkIdentities` reads them. */
const PEOPLE = {
  nameOf: () => "Sam",
  partyOf: () => KIT,
  resolve: () => KIT.ref,
} as never;

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
          .map((d) =>
            withNetworkIdentity(
              {
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
                confirm: [],
                pushId: `push-${d.id}`,
                question: d.question,
                ref: d.id,
                title: d.title,
                urgency: "blocks",
              } as never,
              new Map(),
              PEOPLE
            )
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

test("an open card his Later holds is later, with the day it comes back", async () => {
  const held = await card("whatsapp", "Ask Kit");
  open = [held];
  const later = spyOn(
    await import("../memory/matters"),
    "laterUntilOf"
  ).mockReturnValue("2026-11-19T09:00:00.000Z");
  const page = await thread();
  later.mockRestore();
  expect(JSON.stringify(page)).toContain('"later"');
  expectWire("read_thread_later", page, true);
});
