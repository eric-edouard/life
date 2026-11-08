import { expect, test } from "bun:test";
import type { LedgerEntry } from "../records/ledger-entry";
import { linked, pickCompared } from "./linked";

const action = (over: Partial<LedgerEntry>): LedgerEntry => ({
  after: {},
  at: "2026-10-15T10:00:00.000Z",
  id: "entry_0123456789ab",
  kind: "add",
  result: "ok",
  schemaVersion: 1,
  target: "reminder:12",
  via: "session",
  why: "he asked",
  ...over,
});

// life#242 step 1: Life's record keeps what only Life writes (section, recurrence, subtasks), never compared.
test("the fold keeps section, recurrence and every subtask written; 'clear' stops a recurrence; inbound compares none", () => {
  const add = action({
    after: {
      list: "Travel",
      recurrence: "weekly mon",
      section: "Visa",
      subtasks: [{ title: "Photos" }],
      title: "Renew visa",
    },
  });
  const more = action({
    after: { subtasks: [{ title: "Form" }] },
    at: "2026-10-15T11:00:00.000Z",
    id: "entry_0123456789ac",
    kind: "edit",
  });
  const stop = action({
    after: { recurrence: "clear" },
    at: "2026-10-15T12:00:00.000Z",
    id: "entry_0123456789ad",
    kind: "edit",
  });
  const kept = linked([add, more]).get("reminder:12")?.fields;
  expect(kept).toMatchObject({
    recurrence: "weekly mon",
    section: "Visa",
    subtasks: [{ title: "Photos" }, { title: "Form" }],
  });
  expect(
    linked([add, more, stop]).get("reminder:12")?.fields.recurrence
  ).toBeNull();
  expect(
    pickCompared({
      recurrence: { frequency: "daily" },
      section: "Visa",
      subtasks: [],
      title: "x",
    })
  ).toEqual({ title: "x" });
});
