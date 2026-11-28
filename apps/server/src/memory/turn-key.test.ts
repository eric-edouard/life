import { expect, test } from "bun:test";
import { MIN } from "../core/clock";
import type { LifelogConversation } from "../sources/voice-server";
import { lifelogUnits, turnKey } from "./units";

const said = (
  n: number,
  name: string | null,
  owner = false,
  personId = null as string | null
) => ({
  at: new Date(Date.parse("2026-10-25T10:00:00.000Z") + n * MIN).toISOString(),
  end: null,
  jobId: "job-1",
  marks: [] as string[],
  name,
  owner,
  personId,
  seen: null,
  turnIndex: n,
});

test("a conversation-day's hash is pinned: thousands of cached model outputs are keyed by it", () => {
  const turns = [
    said(0, null, true),
    said(5, "Gaston", false, "p-1"),
    said(30, "Jean (Me)"),
    said(31, null),
  ];
  const conversation: LifelogConversation = {
    closed: false,
    endedAt: "2026-10-25T10:40:00.000Z",
    id: "c1",
    startedAt: "2026-10-25T10:00:00.000Z",
    turns,
  };
  expect(lifelogUnits([conversation], new Set())[0]?.unit.hash).toBe(
    "f6c993ea98f6ff08"
  );
  expect(turnKey(turns[1] as (typeof turns)[number])).toBe(
    "job-1:5@2026-10-25T10:05:00.000Z p-1"
  );
});
