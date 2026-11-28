import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { DAY } from "../core/clock";
import { DESK_STORE } from "../core/paths";
import { setSettings } from "../core/settings";
import type { Decision } from "../memory/decision-lines";
import { DECISIONS } from "../memory/decision-lines";
import {
  answerDecision,
  decisionsNow,
  requestDecision,
} from "../memory/decisions";
import { undoAnswer, undoOf } from "./answer-result";

// His Undo (`undoAnswer`): made-up cards and chats throughout.

const OPTIONS = [
  { id: "send", label: "Send it", outgoing: true as const },
  { id: "wait", label: "Wait" },
];
const card = () =>
  requestDecision(
    "desk",
    {
      agent: "agt_0123456789ab",
      context: "A made-up reason to ask.",
      deadline: new Date(Date.now() + 2 * DAY).toISOString(),
      draft: { channel: "whatsapp", text: "Can you come Friday?", to: "Kit" },
      onSilence: "wait",
      options: OPTIONS,
      question: "Send Kit the message?",
      title: "Ask Kit",
    },
    undefined,
    () =>
      Promise.resolve({
        channel: "whatsapp",
        chat: "155@s.whatsapp.net",
        text: "Can you come Friday?",
        to: "Kit Moreau",
      })
  );
const read = (id: string) =>
  decisionsNow().find((d) => d.id === id) as Decision;

beforeEach(() => rmSync(DECISIONS, { force: true }));
afterEach(() => {
  setSettings({ desk: null });
  rmSync(dirname(DESK_STORE), { force: true, recursive: true });
  rmSync(DECISIONS, { force: true });
});

test("Undo before its agent acted: the answer is withdrawn and the card open again, his next answer the first; after, refused with nothing written", async () => {
  const { id } = await card();
  await answerDecision(id, ["wait"]);
  expect(undoOf(read(id))).toEqual({ line: null });
  const r = await undoAnswer(id);
  expect(r.changed).toMatchObject({ deleted: false, state: "open" });
  expect(read(id).state).toBe("open");
  expect(read(id).voided?.at(-1)?.undone?.kind).toBe("answer-withdrawn");
  await answerDecision(id, ["wait"]);
  expect(read(id).state).toBe("answered");
  // Its agent's turn took the answer: no Undo.
  setSettings({ desk: { defaultRuntime: "claude", runtimes: { claude: {} } } });
  mkdirSync(dirname(DESK_STORE), { recursive: true });
  const db = new Database(DESK_STORE, { create: true, strict: true });
  db.run(
    "create table event (assignment_id text, event_id text, name text, payload text, received_at text, handed integer, consumed_at text, dropped_at text)"
  );
  db.run(
    "insert into event values ('asg_test', ?, 'decision.answered', '{}', '2026-11-18T09:00:00.000Z', 1, null, null)",
    [`${id}.answered`]
  );
  try {
    const before = readFileSync(DECISIONS, "utf8");
    expect(undoOf(read(id))).toBeNull();
    await expect(undoAnswer(id)).rejects.toThrow("already acted");
    expect(readFileSync(DECISIONS, "utf8")).toBe(before);
  } finally {
    db.close();
  }
});

test("Undo of a sent draft: refused where the chat allows no delete, nothing tried", async () => {
  const { id } = await card();
  await answerDecision(id, ["send"], undefined, {
    deliver: () => Promise.resolve("whatsapp:155/1"),
    via: "connector",
  });
  expect(read(id).sends[0]?.kind).toBe("sent");
  // No source in this test deletes: none is offered, and none is tried.
  expect(undoOf(read(id))).toBeNull();
  await expect(undoAnswer(id)).rejects.toThrow("doesn't let Life delete");
  expect(read(id).state).toBe("answered");
});

test("Undo while the send his answer started is under way: refused with nothing written, so it can never send twice", async () => {
  const { id } = await card();
  let deliver = (_: string) => undefined as unknown;
  const handed = new Promise<string>((r) => {
    deliver = r as never;
  });
  let started = () => undefined as unknown;
  const delivering = new Promise((r) => {
    started = r as never;
  });
  const sending = answerDecision(id, ["send"], undefined, {
    deliver: () => {
      started();
      return handed;
    },
    via: "connector",
  });
  await delivering;
  expect(read(id).state).toBe("answered");
  expect(read(id).sends).toEqual([]);
  const before = readFileSync(DECISIONS, "utf8");
  expect(undoOf(read(id))).toBeNull();
  await expect(undoAnswer(id)).rejects.toThrow("under way");
  expect(readFileSync(DECISIONS, "utf8")).toBe(before);
  deliver("whatsapp:155/1");
  await sending;
  expect(read(id).sends[0]?.kind).toBe("sent");
});
