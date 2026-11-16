import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { writeJson } from "../core/files";
import { LIFE_CODE_DIR } from "../core/paths";
import { setSettings, settings } from "../core/settings";
import { promptNameOf, promptText } from "../models/prompt-parts";
import type { Episode } from "../records/episode";
import { situationPath } from "./memory-files";
import { inputsOf } from "./run";
import {
  isRecent,
  readSituationNow,
  shownLines,
  situationBlock,
  situationEpisodesOf,
  situationInputOf,
  targetsOf,
} from "./situations";

const MARKERS = /<!-- \/?part(:\w+)? -->/g;
const RELATIONSHIP_WORDS = /jealous|couple|Between us|get along|close: true/;
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
    madeBy: {
      engine: "claude",
      model: "m",
      prompt: promptNameOf("memory-situation.v3"),
      run: "r",
    },
    page: REF,
    schemaVersion: 1,
  });
  expect(
    situationBlock("Situation", readSituationNow(REF, new Set([A])))
  ).toEqual([
    "Situation (where things stand, read each night from the 30 days up to their newest episode):",
    `- Ana stays at his flat since 20 Mar. [${A}]`,
    "",
  ]);
  expect(situationBlock("Situation", readSituationNow(REF, new Set()))).toEqual(
    []
  );
});

const ep = (n: number, day: string, who: string, importance = 2) =>
  ({
    copies: [],
    day,
    id: `ep_${String(n).padStart(12, "a")}`,
    importance,
    people: [{ ref: who, role: "with" }],
    start: day,
    title: `Title ${n}`,
    units: [],
    what: `What ${n}.`,
  }) as unknown as Episode;

test("a situation's digest is its subject's weighty episodes ending at their newest: the clock changes nothing, a new episode of theirs does", () => {
  const ana = "person:ana";
  const digest = (list: Episode[]) =>
    inputsOf(
      "p",
      situationInputOf(
        situationEpisodesOf(list, (m) => m.people[0]?.ref === ana),
        (ref) => ref
      )
    );
  const all = [
    ep(1, "2026-08-01", ana),
    ep(2, "2026-10-20", ana),
    ep(3, "2026-10-25", ana),
    ep(4, "2026-11-10", "person:bo"),
  ];
  const before = digest(all);
  // The window of 30 days ends at her newest episode: the August one is out of it, and stays out as days pass.
  expect(
    situationEpisodesOf(all, (m) => m.people[0]?.ref === ana).map((m) => m.day)
  ).toEqual(["2026-10-20", "2026-10-25"]);
  // Today moving 40 days: the same episodes, so the same digest; only who has a situation looks at the date.
  const eps = situationEpisodesOf(all, (m) => m.people[0]?.ref === ana);
  expect(isRecent(eps, "2026-11-14")).toBe(true);
  expect(isRecent(eps, "2026-12-25")).toBe(false);
  // A low-importance episode of hers, or an episode of someone else, changes nothing.
  expect(digest([...all, ep(5, "2026-11-01", ana, 1)])).toBe(before);
  expect(digest([...all, ep(6, "2026-11-12", "person:bo")])).toBe(before);
  // A new weighty episode of hers does.
  expect(digest([...all, ep(7, "2026-11-12", ana)])).not.toBe(before);
});

test("everyone with a page and a recent episode gets a situation, whoever is close; a page with none gets none", () => {
  const all = [
    ep(1, "2026-11-10", "person:client"),
    ep(2, "2026-08-01", "person:old"),
  ];
  const ids = (paged: string[]) =>
    targetsOf(paged, all, (r) => r, "2026-11-14").map((t) => t.ref);
  // He has one too, once, however many times the pages name him.
  expect(
    ids(["person:client", "person:old", "person:nobody", "person:me"])
  ).toEqual(["person:me", "person:client"]);
});

test("the digest follows the page and, only while given, the persona; the persona's backing is no part of it", () => {
  const eps = [ep(1, "2026-11-10", "person:ana")];
  const of = (page: string, persona: { text: string; backing?: string }[]) =>
    inputsOf(
      "p",
      situationInputOf(
        eps,
        (r) => r,
        page,
        persona.map((l) => ({
          backing: l.backing ?? "solid",
          facet: "traits",
          text: l.text,
        }))
      )
    );
  expect(of("a", [])).not.toBe(of("b", []));
  expect(of("a", [])).not.toBe(of("a", [{ text: "x" }]));
  expect(of("a", [{ text: "x" }])).toBe(
    of("a", [{ backing: "old", text: "x" }])
  );
});

test("a situation is shown only while it was made by the variant the add-ons choose now", () => {
  const was = settings().personal;
  const stored = (prompt: string) =>
    writeJson(situationPath(REF), {
      built: "2026-11-05T00:00:00.000Z",
      inputs: "0123456789abcdef",
      lines: [{ cites: [A], text: "The builder owes a quote since 3 Nov." }],
      madeBy: { engine: "claude", model: "m", prompt, run: "r" },
      page: REF,
      schemaVersion: 1,
    });
  try {
    setSettings({ personal: { aboutMe: {}, personas: {}, relationships: {} } });
    stored("memory-situation.v3");
    expect(readSituationNow(REF, new Set([A]))).toHaveLength(1);
    setSettings({ personal: null });
    // Switched off: the stored one hides at once; one made under that variant shows.
    expect(readSituationNow(REF, new Set([A]))).toEqual([]);
    stored(promptNameOf("memory-situation.v3"));
    expect(promptNameOf("memory-situation.v3")).toBe(
      "memory-situation.v3-without-aboutMe-personas-relationships"
    );
    expect(readSituationNow(REF, new Set([A]))).toHaveLength(1);
  } finally {
    setSettings({ personal: was ?? null });
  }
});

test("with every part on the situation prompt is its file bar the markers; with relationships off no relationship text is shown", () => {
  const was = settings().personal;
  const file = readFileSync(
    join(LIFE_CODE_DIR, "prompts", "memory-situation.v3.md"),
    "utf8"
  );
  try {
    setSettings({ personal: { aboutMe: {}, personas: {}, relationships: {} } });
    const all = promptText("memory-situation.v3");
    expect(all).toBe(file.replace(MARKERS, ""));
    expect(new Bun.CryptoHasher("sha256").update(all).digest("hex")).toBe(
      "4cac9fed7f0ebe257223157cc55c9e3656addc3457a88df863b8144a321ae37c"
    );
    setSettings({ personal: { aboutMe: {}, personas: {} } });
    const without = promptText("memory-situation.v3");
    expect(without).not.toMatch(RELATIONSHIP_WORDS);
    expect(without).toContain("what is open between them");
    expect(promptNameOf("memory-situation.v3")).toBe(
      "memory-situation.v3-without-relationships"
    );
  } finally {
    setSettings({ personal: was ?? null });
  }
});
