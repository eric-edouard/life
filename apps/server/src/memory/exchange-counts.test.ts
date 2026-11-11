import { expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import type { SourceEvent } from "../records/source";
import { lastYearsOf } from "./closeness";
import {
  exchangeCountsOf,
  pairCountsOf,
  readExchangeCounts,
  writeExchangeCounts,
} from "./exchange-counts";
import { EXCHANGE_COUNTS } from "./ledger";
import { exchangeCountsBlock } from "./read-person-page";

const msg = (
  day: string,
  minute: number,
  fromMe: boolean,
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
  text: "x",
  ...extra,
});
const resolve = (s: string) => (s === "+1" ? "person:ann" : null);

const october = [
  msg("2026-10-01", 0, false),
  msg("2026-10-01", 10, true),
  msg("2026-10-01", 12, false, { deleted: true }),
  msg("2026-10-01", 600, true),
  msg("2026-10-02", 0, true),
];

test("counts: messages and deletions each way, who opens after 6 hours of quiet, median answer minutes", () => {
  const c = pairCountsOf(exchangeCountsOf(october));
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
  // The persona's input hashes this text (`inputsOf`): a moved key would rebuild every persona.
  expect(Object.keys(c)).toEqual([
    "got",
    "gotDeleted",
    "heOpened",
    "sent",
    "sentDeleted",
    "theyOpened",
    "days",
    "heAnswersIn",
    "theyAnswerIn",
  ]);
});

test("rows fold to the same counts over any span: a year alone, and every year together", () => {
  const older = [msg("2025-03-01", 0, true), msg("2025-03-01", 30, false)];
  const rows = exchangeCountsOf([...older, ...october]);
  expect(rows.map((r) => r.start.slice(0, 4))).toEqual([
    "2025",
    "2026",
    "2026",
    "2026",
  ]);
  expect(pairCountsOf(rows.slice(1))).toEqual(
    pairCountsOf(exchangeCountsOf(october))
  );
  expect(pairCountsOf(rows)).toMatchObject({
    days: 3,
    got: 3,
    heOpened: 3,
    sent: 4,
    theyAnswerIn: 30,
  });
});

test("the last years of a longer read are what a read from there gives", () => {
  const old = msg("2019-01-01", 0, true);
  const all = { events: [old, ...october], failed: [], since: new Date(0) };
  expect(lastYearsOf(all).events).toEqual(october);
  expect(lastYearsOf(all).since.getTime()).toBeGreaterThan(Date.parse(old.at));
});

test("the file is rewritten whole; a failed source or an unreadable message leaves the last one; another shape reads as none", () => {
  try {
    expect(readExchangeCounts()).toBeNull();
    expect(
      writeExchangeCounts({ events: october, failed: [] }, resolve)
    ).toEqual({ exchanges: 3, failed: 0 });
    const first = readExchangeCounts();
    expect(first?.people["person:ann"]).toHaveLength(3);
    expect(first?.sources).toContain("told"); // the test data's one source with people
    // A source that could not be read: nothing is written, the counts never miss a source.
    expect(
      writeExchangeCounts({ events: [], failed: ["mail"] }, resolve)
    ).toEqual({ exchanges: 0, failed: 1 });
    expect(readExchangeCounts()).toEqual(first);
    // A message whose time no one can read: logged, never thrown (the night goes on), and the last file stands.
    expect(
      writeExchangeCounts(
        { events: [{ ...msg("2026-10-03", 0, true), at: "soon" }], failed: [] },
        resolve
      )
    ).toEqual({ exchanges: 0, failed: 1 });
    expect(readExchangeCounts()).toEqual(first);
    writeFileSync(EXCHANGE_COUNTS, JSON.stringify({ people: {} }));
    expect(readExchangeCounts()).toBeNull();
  } finally {
    rmSync(EXCHANGE_COUNTS, { force: true });
  }
});

test("the person read shows all years then each year, newest first; nothing when none was counted", () => {
  const rows = exchangeCountsOf([
    msg("2025-03-01", 0, true),
    msg("2025-03-01", 30, false),
    ...october,
  ]);
  const counted = {
    built: "2026-11-11T22:30:00.000Z",
    rows,
    sources: ["whatsapp", "mail"],
  };
  const block = exchangeCountsBlock(counted);
  expect(block[0]).toStartWith(
    "Counted by code between them and him, through 2026-11-1"
  );
  expect(block[0]).toContain("whatsapp, mail");
  expect(block[0]).toContain("until 6 hours of quiet");
  expect(block.slice(1)).toEqual([
    "- all years: messages on 3 days; he sent 4 (0 deleted), they sent 3 (1 deleted); exchanges opened: he 3, they 1; median answer: he 10 min, they 30 min",
    "- 2026: messages on 2 days; he sent 3 (0 deleted), they sent 2 (1 deleted); exchanges opened: he 2, they 1; median answer: he 10 min, they 2 min",
    "- 2025: messages on 1 days; he sent 1 (0 deleted), they sent 1 (0 deleted); exchanges opened: he 1, they 0; median answer: he none, they 30 min",
    "",
  ]);
  expect(exchangeCountsBlock({ ...counted, rows: [] })).toEqual([]);
  expect(exchangeCountsBlock(null)).toEqual([]);
});
