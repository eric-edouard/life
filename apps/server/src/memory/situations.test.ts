import { afterEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { writeJson } from "../core/files";
import { LIFE_CODE_DIR, OWNER_DATA_DIR } from "../core/paths";
import { setSettings, settings } from "../core/settings";
import { MAY_KEEP, promptNameOf, promptText } from "../models/prompt-parts";
import type { Episode } from "../records/episode";
import { situationPath } from "./memory-files";
import { OWNER } from "./read-truth";
import { inputsOf } from "./run";
import { situationBlock } from "./situation-parts";
import {
  readSituationNow,
  situationEpisodesOf,
  situationInputOf,
  targetsOf,
} from "./situations";

const MARKERS = /<!-- \/?part(:\w+)? -->/g;
const MAY_KEEP_PART = /<!-- part:mayKeep -->.*?<!-- \/part -->/;
const RELATIONSHIP_WORDS = /jealous|couple|Between us|get along|close: true/;
const REF = "person:test-ana";
const A = "ep_aaaaaaaaaaaa";
const B = "ep_bbbbbbbbbbbb";

afterEach(() => rm(situationPath(REF), { force: true }));

test("a reader shows only parts whose episodes are still live; the page and the story always stand", () => {
  writeJson(situationPath(REF), {
    built: "2026-11-05T00:00:00.000Z",
    inputs: "0123456789abcdef",
    madeBy: {
      engine: "claude",
      model: "m",
      prompt: promptNameOf("memory-situation.v4"),
      run: "r",
    },
    parts: [
      { cites: [A], markdown: "Ana stays at your flat since 20 Mar." },
      { cites: [B], markdown: "An episode since re-read away." },
      { cites: [REF, `${REF}/story`], markdown: "Friends since 2019." },
    ],
    schemaVersion: 2,
    subject: REF,
  });
  const withAna = { id: A, people: [{ ref: REF }] };
  const same = (r: string) => r;
  expect(
    situationBlock("Situation", readSituationNow(REF, [withAna], same))
  ).toEqual([
    'Situation (Life\'s reading, written to Test as "you"):',
    `Ana stays at your flat since 20 Mar. [${A}]`,
    `Friends since 2019. [${REF}, ${REF}/story]`,
    "",
  ]);
  // An episode still standing but no longer with her: her part on it goes.
  expect(
    readSituationNow(REF, [{ id: A, people: [] }], same).map((p) => p.markdown)
  ).toEqual(["Friends since 2019."]);
});

test("his own situation may cite any standing episode: his episodes leave him out of their people", () => {
  writeJson(situationPath(OWNER), {
    built: "2026-11-05T00:00:00.000Z",
    inputs: "0123456789abcdef",
    madeBy: {
      engine: "claude",
      model: "m",
      prompt: promptNameOf("memory-situation.v4"),
      run: "r",
    },
    parts: [{ cites: [A], markdown: "He moves flats in March." }],
    schemaVersion: 2,
    subject: OWNER,
  });
  expect(
    readSituationNow(OWNER, [{ id: A, people: [] }], (r) => r).map(
      (p) => p.markdown
    )
  ).toEqual(["He moves flats in March."]);
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
  // Today moving changes nothing: the digest never holds the clock.
  // A low-importance episode of hers, or an episode of someone else, changes nothing.
  expect(digest([...all, ep(5, "2026-11-01", ana, 1)])).toBe(before);
  expect(digest([...all, ep(6, "2026-11-12", "person:bo")])).toBe(before);
  // A new weighty episode of hers does.
  expect(digest([...all, ep(7, "2026-11-12", ana)])).not.toBe(before);
});

test("everyone with a page or an organization keeps a situation, however old their newest episode; one with none gets no call", () => {
  const all = [
    ep(1, "2026-11-10", "person:client"),
    ep(2, "2026-08-01", "person:old"),
  ];
  // He has one too, once, however many times the pages name him.
  const { kept, targets } = targetsOf(
    ["person:client", "person:old", "person:nobody", "person:me"],
    all,
    (r) => r
  );
  expect(kept).toEqual([
    "person:me",
    "person:client",
    "person:old",
    "person:nobody",
  ]);
  expect(targets.map((t) => t.ref)).toEqual([
    "person:me",
    "person:client",
    "person:old",
  ]);
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
      madeBy: { engine: "claude", model: "m", prompt, run: "r" },
      parts: [
        { cites: [A], markdown: "The builder owes a quote since 3 Nov." },
      ],
      schemaVersion: 2,
      subject: REF,
    });
  try {
    setSettings({ personal: { aboutMe: {}, personas: {}, relationships: {} } });
    stored("memory-situation.v4");
    expect(
      readSituationNow(REF, [{ id: A, people: [{ ref: REF }] }], (r) => r)
    ).toHaveLength(1);
    setSettings({ personal: null });
    // Switched off: the stored one hides at once; one made under that variant shows.
    expect(
      readSituationNow(REF, [{ id: A, people: [{ ref: REF }] }], (r) => r)
    ).toEqual([]);
    stored(promptNameOf("memory-situation.v4"));
    expect(promptNameOf("memory-situation.v4")).toBe(
      "memory-situation.v4-without-aboutMe-personas-relationships"
    );
    expect(
      readSituationNow(REF, [{ id: A, people: [{ ref: REF }] }], (r) => r)
    ).toHaveLength(1);
  } finally {
    setSettings({ personal: was ?? null });
  }
});

test("with every part on the situation prompt is its file bar the markers; with relationships off no relationship text is shown", () => {
  const was = settings().personal;
  const file = readFileSync(
    join(LIFE_CODE_DIR, "prompts", "memory-situation.v4.md"),
    "utf8"
  );
  try {
    setSettings({ personal: { aboutMe: {}, personas: {}, relationships: {} } });
    const all = promptText("memory-situation.v4");
    expect(all).toEndWith(
      file
        .replace(MAY_KEEP_PART, "")
        .replace(MARKERS, "")
        .replaceAll("{{owner}}", "Test")
        .replaceAll("{{language}}", "English")
    );
    setSettings({ personal: { aboutMe: {}, personas: {} } });
    const without = promptText("memory-situation.v4");
    expect(without).not.toMatch(RELATIONSHIP_WORDS);
    expect(without).toContain("Where things stand now");
    expect(promptNameOf("memory-situation.v4")).toBe(
      "memory-situation.v4-without-relationships"
    );
  } finally {
    setSettings({ personal: was ?? null });
  }
});

test("a reader shows the situation made under the variant now: with his words on what Life may keep, only the one stamped -with-mayKeep", () => {
  const me = join(OWNER_DATA_DIR, "truth", "me.md");
  const was = readFileSync(me, "utf8");
  const madeUnder = (mayKeep: boolean) => {
    writeJson(situationPath(REF), {
      built: "2026-11-05T00:00:00.000Z",
      inputs: "0123456789abcdef",
      madeBy: {
        engine: "claude",
        model: "m",
        prompt: promptNameOf("memory-situation.v4", mayKeep ? [MAY_KEEP] : []),
        run: "r",
      },
      parts: [{ cites: [A], markdown: "Ana stays at his flat since 20 Mar." }],
      schemaVersion: 2,
      subject: REF,
    });
    return readSituationNow(REF, [{ id: A, people: [{ ref: REF }] }], (r) => r)
      .length;
  };
  try {
    expect([madeUnder(false), madeUnder(true)]).toEqual([1, 0]);
    writeFileSync(
      me,
      `${was}\n## What Life may keep\nNothing about my health.\n`
    );
    expect([madeUnder(false), madeUnder(true)]).toEqual([0, 1]);
  } finally {
    writeFileSync(me, was);
  }
});
