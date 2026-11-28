import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { DESK_STORE } from "../core/paths";
import { setSettings } from "../core/settings";
import type { PausedImport } from "../host/paused-imports";
import { receivePausedImports } from "./complaint-intake";
import { type Desk, openDesk } from "./desk-store";
import { fakeRuntime } from "./runtimes/fake-runtime";

// The caretaker's intake of an export Life cannot read: one event per paused import, ever, its payload facts only.

const fake = fakeRuntime();
let desk: Desk;

/** A made-up paused import: a shape report with no words of his in it. */
const PAUSED: PausedImport = {
  digest: "abc123def456",
  report: {
    counts: { lines: 12 },
    files: ["<12 hex>.txt"],
    format: "whatsapp-export",
    keys: ["messages"],
  },
  source: "whatsapp",
};

/** The desk's event rows, oldest first. */
const events = () =>
  desk.db
    .query<{ event_id: string; name: string; payload: string }, []>(
      "select event_id, name, payload from event order by rowid"
    )
    .all();

beforeAll(() => {
  rmSync(dirname(DESK_STORE), { force: true, recursive: true });
  setSettings({ desk: { runtimes: {} } });
  desk = { db: openDesk(), runtimes: { pi: fake.runtime } };
});

afterAll(() => {
  rmSync(dirname(DESK_STORE), { force: true, recursive: true });
  setSettings({ desk: null });
});

test("a paused import queues one event on the caretaker's assignment, its payload the shape report and source only", async () => {
  const spy = spyOn(
    await import("../host/paused-imports"),
    "pausedImportsNow"
  ).mockResolvedValue([PAUSED]);
  try {
    await receivePausedImports(desk);
    const rows = events();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      event_id: "import-paused:abc123def456",
      name: "import.paused",
    });
    const payload = JSON.parse(rows[0]?.payload ?? "{}");
    expect(Object.keys(payload).sort()).toEqual(["report", "source"]);
    expect(payload).toEqual({ report: PAUSED.report, source: "whatsapp" });
    // Received once ever: the next tick queues nothing more.
    await receivePausedImports(desk);
    expect(events()).toHaveLength(1);
  } finally {
    spy.mockRestore();
  }
});

test("a stopped caretaker leaves a paused import for a later tick", async () => {
  const stopped = desk.db
    .query<{ id: string }, []>("select id from agent where role = 'caretaker'")
    .get();
  if (stopped) {
    desk.db.run("update agent set status = 'stopped' where id = ?", [
      stopped.id,
    ]);
  }
  const spy = spyOn(
    await import("../host/paused-imports"),
    "pausedImportsNow"
  ).mockResolvedValue([{ ...PAUSED, digest: "fedcba654321" }]);
  try {
    await receivePausedImports(desk);
    expect(events()).toHaveLength(1);
  } finally {
    spy.mockRestore();
  }
});
