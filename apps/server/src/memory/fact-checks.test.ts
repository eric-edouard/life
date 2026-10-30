import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { appendJsonl } from "../core/files";
import { Statement } from "../records/statement";
import { decisionsNow, writeDecision } from "./decisions";
import { askFactChecks, factCheckAsk, recordFactCheck } from "./fact-checks";
import { DECISIONS, RATINGS, readRatings, STATEMENTS } from "./ledger";

const NOW = Date.parse("2026-10-30T10:00:00.000Z");
const statement = (ref: string, text = `Zoé runs the bakery ${ref}.`) => ({
  at: "2026-10-29T10:00:00.000Z",
  date: "2026-10-28",
  group: "events" as const,
  kind: "fact" as const,
  ref,
  schemaVersion: 1 as const,
  source: "whatsapp" as const,
  text,
  units: ["unit_000000000000"],
});
const fresh = () => {
  for (const f of [DECISIONS, RATINGS, STATEMENTS]) {
    rmSync(f, { force: true });
  }
};
const ofLoop = () =>
  [...decisionsNow().values()].filter((d) => d.loop === "fact-checks");

test("a fact check asks the statement word for word, its full text in the context when the question is cut", () => {
  const long = factCheckAsk(statement("obs_000000000001", "x".repeat(250)), [
    "guessed-person",
  ]);
  expect(long.question).toHaveLength(200);
  expect(long.context).toStartWith("x".repeat(250));
  expect(long.context).toContain("who it's about is only guessed");
  expect(long.options.map((o) => o.id)).toEqual(["true", "partly", "false"]);
});

test("Life asks what was drawn but never asked, records his tap, and closes an expired one as skipped", async () => {
  fresh();
  try {
    // Drawn by an earlier run whose ask never landed: asked now, no new draw (the room is taken by them up to 5).
    const refs = [1, 2, 3, 4, 5].map((n) => `obs_00000000000${n}`);
    await appendJsonl(
      STATEMENTS,
      Statement,
      refs.map((r) => statement(r))
    );
    expect(await askFactChecks(NOW)).toBe(5);
    expect(ofLoop().map((d) => d.ref)).toEqual(refs);
    expect(await askFactChecks(NOW)).toBe(0);

    const [first, second] = ofLoop();
    const [tapped] = writeDecision(
      [
        {
          data: { answer: "false", note: "she sold it" },
          decision: `${first?.id}`,
          step: "answered",
        },
      ],
      NOW
    );
    recordFactCheck(tapped as NonNullable<typeof tapped>);
    expect(readRatings().get(refs[0] as string)).toMatchObject({
      answer: "false",
      note: "she sold it",
    });
    // A note with no tap, left answered (the page's record failed): the next run records it as Partly.
    writeDecision(
      [
        {
          data: { answer: "note", note: "not quite" },
          decision: `${second?.id}`,
          step: "answered",
        },
      ],
      NOW
    );
    // Eight days on: the three left open expire as skipped.
    await askFactChecks(NOW + 8 * 86_400_000);
    expect(readRatings().get(refs[1] as string)?.answer).toBe("partly");
    expect(readRatings().get(refs[4] as string)?.answer).toBe("skip");
    expect(ofLoop().map((d) => d.status)).toEqual([
      "done",
      "done",
      "expired",
      "expired",
      "expired",
    ]);
  } finally {
    fresh();
  }
});

test("a card that can't be recorded is left and logged; more than 5 open asks none", async () => {
  fresh();
  try {
    const refs = [1, 2, 3, 4, 5, 6].map((n) => `obs_00000000001${n}`);
    // Six open, one answered about a claim never drawn (its rating is refused).
    writeDecision(
      refs.map((ref, n) => ({
        data: factCheckAsk(statement(ref), [], undefined, NOW),
        decision: `fact-checks-20261030090000-${n + 1}`,
        step: "asked" as const,
      })),
      NOW
    );
    writeDecision(
      [
        {
          data: { answer: "true", note: "" },
          decision: "fact-checks-20261030090000-1",
          step: "answered",
        },
      ],
      NOW
    );
    await appendJsonl(STATEMENTS, Statement, [statement("obs_000000000099")]);
    expect(await askFactChecks(NOW)).toBe(0);
    expect(ofLoop()[0]?.status).toBe("answered");
  } finally {
    fresh();
  }
});
