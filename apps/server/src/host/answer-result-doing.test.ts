import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { rmSync } from "node:fs";
import { DAY } from "../core/clock";
import { setSettings } from "../core/settings";
import { DECISIONS } from "../memory/decision-lines";
import { decisionsNow, requestDecision } from "../memory/decisions";
import { CORRECTIONS } from "../memory/memory-files";
import { afterAnswer, answerWithResult } from "./answer-result";
import { expectWire } from "./http/wire-fixture";

// What his pick of an `adds` or `runs` option and his mark on a card write: made-up ids throughout.
let listed: ReturnType<typeof spyOn>;
beforeEach(async () => {
  rmSync(DECISIONS, { force: true });
  rmSync(CORRECTIONS, { force: true });
  listed = spyOn(
    await import("../memory/checks"),
    "checksNow"
  ).mockImplementation(async () =>
    decisionsNow()
      .filter((d) => d.state === "open")
      .map(
        (d) =>
          ({
            about: [],
            deadline: d.deadline,
            group: "decision",
            matter: null,
            pushId: "",
            ref: d.id,
          }) as never
      )
  );
});
afterEach(() => listed.mockRestore());
afterAll(() => {
  rmSync(DECISIONS, { force: true });
  rmSync(CORRECTIONS, { force: true });
});

const call = (ref: string, options: string[], answerKey: string) =>
  answerWithResult(ref, { options }, { answerKey, report: () => undefined });

/** A card whose one option does something beyond his answer (`adds`, `runs`): the proof holds its outcome line. */
const doing = (flag: "adds" | "runs", need: object) =>
  requestDecision("planner", {
    context: "A made-up reason to ask.",
    deadline: new Date(Date.now() + 2 * DAY).toISOString(),
    needs: [need as never],
    onSilence: null,
    options: [
      { id: "go", label: "Do it", [flag]: true },
      { id: "no", label: "Not now" },
    ],
    question: "Do it?",
    title: "Made-up ask",
  });

test("his `adds` pick writes the event once: the proof holds the added line", async () => {
  setSettings({
    appointmentsCalendar: { account: "me@example.com", calendar: "Life" },
  });
  const add = spyOn(
    await import("./card-event-calendar"),
    "addEventByHisWord"
  ).mockResolvedValue("evt_made_up");
  const { id } = await doing("adds", {
    end: new Date(Date.now() + 3 * DAY + 3_600_000).toISOString(),
    kind: "event",
    reminders: [60],
    start: new Date(Date.now() + 3 * DAY).toISOString(),
    title: "Dive course",
  });
  const r = await call(id, ["go"], "tap-add");
  add.mockRestore();
  setSettings({ appointmentsCalendar: null });
  expect(JSON.stringify(r.done)).toContain('"kind":"added"');
  expectWire("answer_check_added", r, true);
});

test("his `runs` pick starts the run once: the proof holds the ran line", async () => {
  const run = spyOn(
    await import("./card-apify-run"),
    "runApifyByHisWord"
  ).mockResolvedValue("run_made_up");
  const { id } = await doing("runs", {
    actor: "made/up-actor",
    estimateUsd: 0.1,
    input: { query: "clinics" },
    kind: "apify",
    maxUsd: 0.5,
    what: "20 clinics",
  });
  const r = await call(id, ["go"], "tap-run");
  run.mockRestore();
  expect(JSON.stringify(r.done)).toContain('"kind":"ran"');
  expectWire("answer_check_ran", r, true);
});

test("his mark on an answered card is one rated line", async () => {
  const { id } = await requestDecision("planner", {
    context: "A made-up reason to ask.",
    deadline: new Date(Date.now() + 2 * DAY).toISOString(),
    onSilence: null,
    options: [
      { id: "go", label: "Do it" },
      { id: "no", label: "Not now" },
    ],
    question: "Do it?",
    title: "Made-up ask",
  });
  await call(id, ["no"], "tap-rate");
  const r = await afterAnswer(id, { rate: "good" });
  expect(r.done.at(-1)).toMatchObject({ kind: "rated", mark: "good" });
  expectWire("answer_check_rated", r, true);
});
