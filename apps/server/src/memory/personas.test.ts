import { expect, test } from "bun:test";
import type { SourceEvent } from "../records/source";
import {
  isDue,
  pairCountsOf,
  personaBlock,
  personaLines,
  sampleOf,
  supportOf,
} from "./personas";

// Noon UTC: the same local day in any zone a test runs in.
const msg = (
  day: string,
  minute: number,
  fromMe: boolean,
  text: string,
  extra: Partial<SourceEvent> = {}
): SourceEvent => ({
  at: new Date(
    Date.parse(`${day}T12:00:00.000Z`) + minute * 60_000
  ).toISOString(),
  chat: "+1",
  fromMe,
  id: `${day}:${minute}`,
  sender: fromMe ? "me" : "+1",
  source: "whatsapp",
  text,
  ...extra,
});

test("a sample keeps the newest days, the eventful ones and some across the years, oldest first, within its budget", () => {
  const quiet = Array.from({ length: 40 }, (_, i) =>
    msg(
      `2024-${String(1 + (i % 12)).padStart(2, "0")}-${String(1 + Math.floor(i / 12)).padStart(2, "0")}`,
      0,
      true,
      "x".repeat(80)
    )
  );
  const fight = [0, 1, 2, 3, 4].map((m) =>
    msg("2023-06-10", m, m % 2 === 0, "y".repeat(80), { deleted: m > 2 })
  );
  const newest = msg("2026-11-01", 0, false, "z".repeat(80));
  const days = sampleOf([...quiet, ...fight, newest], () => "Ana", 2000);
  const shown = days.map((d) => d.day);
  expect(shown.at(-1)).toBe("2026-11-01");
  expect(shown).toContain("2023-06-10");
  expect(shown).toEqual(shown.toSorted());
  const chars = days
    .flatMap((d) => d.messages)
    .reduce((n, m) => n + m.text.length + 20, 0);
  expect(chars).toBeLessThanOrEqual(2000);
  expect(days.find((d) => d.day === "2023-06-10")?.messages[4]?.deleted).toBe(
    true
  );
});

test("a quote stays only as words in a chat message shown, a writing line's only from that writer, with the message's time", () => {
  const days = sampleOf(
    [
      msg("2026-10-01", 0, false, "C'est encore de ta faute !"),
      msg("2026-10-01", 1, true, "Ok ça marche, à demain"),
      msg("2026-10-02", 0, false, "Pardon mon fils", { source: "mail" }),
    ],
    () => "Dad"
  );
  const reply = {
    lines: [
      {
        facet: "pattern",
        quotes: ["c'est encore de ta faute", "pardon mon fils", "never said"],
        text: "He blames, then apologises.",
        writer: null,
      },
      {
        facet: "writes",
        kind: "chat",
        quotes: ["ok ca marche", "de ta faute"],
        source: "line",
        text: "Short, warm.",
        writer: "owner",
      },
      { facet: "offers", quotes: [], text: "Gives time when asked." },
      { facet: "horoscope", quotes: [], text: "Not a kind." },
    ],
  };
  expect(personaLines(reply, days)).toEqual([
    {
      facet: "pattern",
      quotes: [
        { at: "2026-10-01T12:00:00.000Z", text: "C'est encore de ta faute" },
      ],
      text: "He blames, then apologises.",
    },
    {
      facet: "writes",
      kind: "chat",
      quotes: [{ at: "2026-10-01T12:01:00.000Z", text: "Ok ça marche" }],
      text: "Short, warm.",
      writer: "owner",
    },
    { facet: "offers", quotes: [], text: "Gives time when asked." },
  ]);
  expect(personaLines("not json", days)).toEqual([]);
});

test("a line is solid on 3 days, thin on fewer, old when its newest quote is over a year old", () => {
  const q = (day: string) => ({ at: `${day}T12:00:00.000Z`, text: "x" });
  const today = "2026-11-08";
  expect(
    supportOf([q("2026-01-01"), q("2026-02-01"), q("2026-03-01")], today)
  ).toBe("solid");
  expect(supportOf([q("2026-01-01"), q("2026-01-01")], today)).toBe("thin");
  expect(supportOf([], today)).toBe("thin");
  expect(
    supportOf([q("2024-01-01"), q("2024-02-01"), q("2025-01-01")], today)
  ).toBe("old");
});

test("counts: messages and deletions each way, who opens after 6 hours of quiet, median answer minutes", () => {
  const c = pairCountsOf([
    msg("2026-10-01", 0, false, "a"),
    msg("2026-10-01", 10, true, "b"),
    msg("2026-10-01", 12, false, "c", { deleted: true }),
    msg("2026-10-01", 600, true, "d"),
    msg("2026-10-02", 0, true, "e"),
  ]);
  expect(c).toEqual({
    days: 2,
    got: 2,
    gotDeleted: 1,
    heAnswersIn: 10,
    heOpened: 2,
    sent: 3,
    sentDeleted: 0,
    theyAnswerIn: 2,
    theyOpened: 1,
  });
});

test("a persona is rebuilt when there is none, or 3 days old with new messages", () => {
  const now = new Date("2026-11-08T00:00:00.000Z");
  const last = { built: "2026-11-06T00:00:00.000Z", inputs: "a" };
  expect(isDue(null, "a", now)).toBe(true);
  expect(isDue(last, "b", now)).toBe(false);
  expect(isDue({ ...last, built: "2026-11-05T00:00:00.000Z" }, "b", now)).toBe(
    true
  );
  expect(isDue({ ...last, built: "2026-11-05T00:00:00.000Z" }, "a", now)).toBe(
    false
  );
});

test("a reader shows the readings with their support, and the writing lines under Communication style", () => {
  const q = { at: "2026-11-01T12:00:00.000Z", text: "haha ok" };
  const block = personaBlock(
    [
      { facet: "reacts", quotes: [q], text: "Goes quiet when pressed." },
      {
        facet: "writes",
        kind: "chat",
        quotes: [q],
        source: "whatsapp",
        text: "Short.",
        writer: "them",
      },
    ],
    "2026-11-08"
  );
  expect(block[1]).toBe(
    '- reacts (thin): Goes quiet when pressed. E.g. "haha ok" (2026-11-01)'
  );
  expect(block[4]).toBe(
    '- they write, chat (whatsapp): Short. E.g. "haha ok" (2026-11-01)'
  );
  expect(personaBlock([], "2026-11-08")).toEqual([]);
});
