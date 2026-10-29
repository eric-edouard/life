import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { decisionsNow, writeDecision } from "./decisions";
import { DECISIONS } from "./ledger";

const NOW = Date.parse("2026-10-29T10:00:00.000Z");
const ask = {
  loop: "asks",
  options: [
    { id: "send", label: "Send it" },
    { id: "later", label: "Not now" },
  ],
  question: "Send the reply to the plumber?",
};
const id = "asks-20261029100000-1";

test("a decision goes open, answered, taken, done; each step only from the state before it", () => {
  rmSync(DECISIONS, { force: true });
  try {
    writeDecision([{ data: ask, decision: id, run: "r1", step: "asked" }], NOW);
    expect(() => writeDecision([{ decision: id, step: "taken" }], NOW)).toThrow(
      "is open"
    );
    writeDecision(
      [
        {
          data: { answer: "send", note: "after 6 pm" },
          decision: id,
          step: "answered",
        },
      ],
      NOW
    );
    expect(decisionsNow().get(id)).toMatchObject({
      answer: "send",
      note: "after 6 pm",
      status: "answered",
    });
    writeDecision([{ decision: id, run: "r2", step: "taken" }], NOW);
    // His tap after a loop took it is refused: the loop is already acting on his first answer.
    expect(() =>
      writeDecision(
        [
          {
            data: { answer: "later", note: "" },
            decision: id,
            step: "answered",
          },
        ],
        NOW
      )
    ).toThrow("is taken");
    expect(() => writeDecision([{ decision: id, step: "done" }], NOW)).toThrow(
      "needs result"
    );
    writeDecision(
      [{ data: { result: "sent at 18:05" }, decision: id, step: "done" }],
      NOW
    );
    expect(decisionsNow().get(id)).toMatchObject({
      result: "sent at 18:05",
      status: "done",
    });
    expect(() =>
      writeDecision([{ data: ask, decision: id, step: "asked" }], NOW)
    ).toThrow("exists");
  } finally {
    rmSync(DECISIONS, { force: true });
  }
});

test("an answer is one of its options, a note or nothing; clearing it reopens; a loop may reopen or withdraw", () => {
  rmSync(DECISIONS, { force: true });
  try {
    writeDecision(
      [
        {
          data: { ...ask, deadline: "2026-10-30T10:00:00.000Z" },
          decision: id,
          step: "asked",
        },
        { data: ask, decision: id, step: "revised" },
      ],
      NOW
    );
    // A revision is the whole decision again: the deadline it dropped is gone.
    expect(decisionsNow().get(id)?.deadline).toBeUndefined();
    expect(() =>
      writeDecision(
        [{ data: { answer: "maybe" }, decision: id, step: "answered" }],
        NOW
      )
    ).toThrow("one of its options");
    writeDecision(
      [{ data: { answer: null, note: "" }, decision: id, step: "answered" }],
      NOW
    );
    expect(decisionsNow().get(id)?.status).toBe("open");
    writeDecision(
      [
        {
          data: { answer: "note", note: "ask him first" },
          decision: id,
          step: "answered",
        },
      ],
      NOW
    );
    writeDecision(
      [
        {
          data: { result: "he changed his mind: ask again" },
          decision: id,
          step: "reopened",
        },
      ],
      NOW
    );
    expect(decisionsNow().get(id)).toMatchObject({
      answer: null,
      note: "",
      status: "open",
    });
    expect(() =>
      writeDecision(
        [{ data: { result: "late" }, decision: id, step: "expired" }],
        NOW
      )
    ).toThrow("not past its deadline");
    writeDecision(
      [
        {
          data: { result: "the reply came first" },
          decision: id,
          step: "withdrawn",
        },
      ],
      NOW
    );
    expect(() =>
      writeDecision([{ decision: id, step: "context" }], NOW)
    ).toThrow("withdrawn");
  } finally {
    rmSync(DECISIONS, { force: true });
  }
});

test("only a done grant is revoked, a request is taken unanswered, and a malformed ask is refused with why", () => {
  rmSync(DECISIONS, { force: true });
  try {
    const grant = "lynx-store-20261029100000-1";
    writeDecision(
      [
        {
          data: { ...ask, kind: "grant", loop: "lynx-store" },
          decision: grant,
          step: "asked",
        },
      ],
      NOW
    );
    writeDecision(
      [
        {
          data: { answer: "send", note: "" },
          decision: grant,
          step: "answered",
        },
        { decision: grant, step: "taken" },
        {
          data: { result: "on", scope: "ads within €150" },
          decision: grant,
          step: "done",
        },
      ],
      NOW
    );
    expect(decisionsNow().get(grant)?.active).toBe(true);
    writeDecision([{ decision: grant, step: "revoked" }], NOW);
    expect(decisionsNow().get(grant)?.active).toBe(false);
    // A request has no options: nothing for him to answer, so its loop takes it open.
    const request = "audit-20261029100000000-1";
    writeDecision(
      [
        {
          data: {
            kind: "audit",
            loop: "audit",
            options: [],
            question: "Why did the reply go twice?",
          },
          decision: request,
          step: "asked",
        },
        { decision: request, step: "taken" },
      ],
      NOW
    );
    expect(decisionsNow().get(grant)?.revokedAt).toBeDefined();
    expect(() =>
      writeDecision(
        [
          {
            data: { loop: "x", options: [] },
            decision: "x-20261029100000-1",
            step: "asked",
          },
        ],
        NOW
      )
    ).toThrow("question");
  } finally {
    rmSync(DECISIONS, { force: true });
  }
});

test("a decision carries its loop's goal rank, the page's order", () => {
  rmSync(DECISIONS, { force: true });
  const [d] = writeDecision(
    [{ data: { ...ask, rank: 2 }, decision: id, step: "asked" }],
    NOW
  );
  expect(d?.rank).toBe(2);
  expect(() =>
    writeDecision(
      [
        {
          data: { ...ask, rank: -1 },
          decision: "asks-20261029100000-2",
          step: "asked",
        },
      ],
      NOW
    )
  ).toThrow();
});
