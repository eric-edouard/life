import { afterEach, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { writeJson } from "../core/files";
import { situationPath } from "./memory-files";
import { readSituationNow, shownLines, situationBlock } from "./situations";

const REF = "person:test-ana";
const A = "ep_aaaaaaaaaaaa";
const B = "ep_bbbbbbbbbbbb";

afterEach(() => rm(situationPath(REF), { force: true }));

test("a reply keeps only lines citing episodes it was shown", () => {
  const reply = {
    lines: [
      { cites: [A], text: "Ana and the owner broke up before 3 Mar." },
      { cites: [A, B], text: "Cites one episode it was not shown." },
      { cites: [], text: "Cites nothing." },
      { text: "No cites at all." },
    ],
  };
  expect(shownLines(reply, new Set([A]))).toEqual([
    { cites: [A], text: "Ana and the owner broke up before 3 Mar." },
  ]);
  expect(shownLines("not json", new Set([A]))).toEqual([]);
});

test("a reader shows only lines whose episodes are still live", () => {
  writeJson(situationPath(REF), {
    built: "2026-11-05T00:00:00.000Z",
    inputs: "0123456789abcdef",
    lines: [
      { cites: [A], text: "Ana stays at his flat since 20 Mar." },
      { cites: [B], text: "An episode since re-read away." },
    ],
    madeBy: { engine: "claude", model: "m", prompt: "p", run: "r" },
    page: REF,
    schemaVersion: 1,
  });
  expect(
    situationBlock("Situation", readSituationNow(REF, new Set([A])))
  ).toEqual([
    "Situation (where things stand, read each night from the last 30 days):",
    `- Ana stays at his flat since 20 Mar. [${A}]`,
    "",
  ]);
  expect(situationBlock("Situation", readSituationNow(REF, new Set()))).toEqual(
    []
  );
});
