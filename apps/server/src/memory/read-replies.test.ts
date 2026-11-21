import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stamp } from "../models/llm";
import type { ReadReply } from "../records/read-reply";
import { READS, readConfirmedArrivals, storeReply } from "./read-replies";

let dir = "";
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "read-replies-"));
});
afterAll(() => rm(dir, { force: true, recursive: true }));

test("a confirm filed in last month's file (its first message's month) is still read just after midnight UTC", () => {
  const where = join(dir, "month-edge");
  storeReply(
    {
      at: "2026-11-01T00:10:00.000Z",
      madeBy: stamp(
        { engine: "codex", model: "test" },
        READS.arrival_confirm.prompt,
        "r1"
      ),
      messages: ["whatsapp|whatsapp:edge"],
      people: [],
      promptDigest: "0123456789abcdef",
      read: "arrival_confirm",
      reply: { isActionable: true },
      schemaVersion: 1,
      starts: [0],
      unit: "unit_0000000000ed",
    } as ReadReply,
    "2026-10-31T23:50:00.000Z",
    where
  );
  expect(
    readConfirmedArrivals("2026-11-01T00:00:00.000Z", where).map((a) => a.unit)
  ).toEqual(["unit_0000000000ed"]);
});

test("an older prompt's confirm still keeps its unit for the night (a bump before the night lost a kept promise); one confirm per newest message, the newest by time, whatever its month file", () => {
  const where = join(dir, "older-prompt");
  const confirm = (
    prompt: string,
    at: string,
    isActionable: boolean,
    chats: string[],
    firstAt = at
  ) =>
    storeReply(
      {
        at,
        madeBy: { engine: "codex", model: "test", prompt, run: "r1" },
        messages: chats.map((c) => `whatsapp|whatsapp:${c}`),
        people: [],
        promptDigest: "0123456789abcdef",
        read: "arrival_confirm",
        reply: { isActionable },
        schemaVersion: 1,
        starts: [0],
        unit: `unit_00000000${chats.at(-1)}`,
      } as ReadReply,
      firstAt,
      where
    );
  const older = "2026-11-01T01:00:00.000Z";
  const newer = "2026-11-01T02:00:00.000Z";
  const current = READS.arrival_confirm.prompt;
  confirm("memory-arrival-confirm.v1", older, true, ["aaaa"]);
  // A later no never takes back a yes: the unit stays read.
  confirm("memory-arrival-confirm.v1", older, true, ["cccc", "bbbb"]);
  confirm(current, newer, false, ["bbbb"]);
  // The newer read wins though its first line files it in last month's file, read first.
  confirm("memory-arrival-confirm.v1", older, true, ["eeee"]);
  confirm(current, newer, true, ["dddd", "eeee"], "2026-10-31T23:50:00.000Z");
  expect(
    readConfirmedArrivals("2026-11-01T00:00:00.000Z", where).map((a) => [
      a.unit,
      a.messages.length,
    ])
  ).toEqual([
    ["unit_00000000aaaa", 1],
    ["unit_00000000bbbb", 2],
    ["unit_00000000eeee", 2],
  ]);
});
