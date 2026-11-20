import { expect, spyOn, test } from "bun:test";
import type { Correction } from "../records/observation";
import type { Unit } from "../records/unit";
// biome-ignore lint/performance/noNamespaceImport: a test spies on its functions
import * as lifelogVoices from "../sources/lifelog-voices";
import {
  type NameRow,
  nameGroupsOf,
  readNameContexts,
} from "./check-sentences";
import { checksOf } from "./checks";
import { inputs, line, nameRow, stepsOf } from "./checks-test-inputs";
// biome-ignore lint/performance/noNamespaceImport: a test spies on its functions
import * as files from "./memory-files";
import { holdsName } from "./units";
import type { People } from "./who";
// biome-ignore lint/performance/noNamespaceImport: a test spies on its functions
import * as words from "./words";

const people = {
  nameOf: (r: string) => r.replace("unknown:", ""),
  resolve: () => null,
  truth: {},
} as unknown as People;

const unit = (over: Partial<Unit> = {}) =>
  ({
    hash: "h1",
    id: "unit_000000000001",
    key: "chat-1",
    source: "whatsapp",
    title: "Kitchen crew",
    ...over,
  }) as Unit;

const turnOf = (i: number, speaker: string, text: string) => ({
  at: `2026-11-01T09:0${i}:00.000Z`,
  ref: `m${i}`,
  speaker,
  text,
});
const chat = [
  turnOf(0, "unknown:Dana", "one"),
  turnOf(1, "unknown:Dana", "two"),
  turnOf(2, "unknown:Dana", "three"),
  turnOf(3, "unknown:Dana", "four"),
  turnOf(4, "unknown:Dana", "Bastien comes Thursday, are you in?"),
  turnOf(5, "person:me", "Yes."),
  turnOf(6, "unknown:Dana", "six"),
  turnOf(7, "unknown:Dana", "seven"),
  turnOf(8, "unknown:Dana", "eight"),
  turnOf(9, "unknown:Dana", "nine"),
];
const wanted = [
  {
    key: "bastien",
    line: {
      id: "obs_000000000001",
      quote: "Bastien comes Thursday, are you in?",
      unit: "unit_000000000001",
    },
    names: ["Bastien"],
  },
];

test("a name matches whole words, ignoring case and accents", () => {
  expect(holdsName("Bastien comes", ["bastien"])).toBe(true);
  expect(holdsName("Sébastien comes", ["Bastien"])).toBe(false);
  expect(holdsName("Chez Odile ce soir", ["odile"])).toBe(true);
});

test("a name's sentence is the unit's own line holding it, who said it and where; a repeat read of an unchanged unit reads nothing", async () => {
  const units = spyOn(files, "readUnitsFor").mockReturnValue([unit()]);
  const read = spyOn(words, "unitLines").mockResolvedValue({
    built: {},
    lines: chat,
  } as never);
  try {
    const [context] = [...(await readNameContexts(wanted, people)).values()];
    expect(context?.said).toEqual({
      at: "2026-11-01T09:04:00.000Z",
      by: "Dana",
      channel: "whatsapp",
      text: "Bastien comes Thursday, are you in?",
      to: "Kitchen crew",
    });
    expect(context?.clips).toEqual([]);
    await readNameContexts(wanted, people);
    expect(read).toHaveBeenCalledTimes(1);
    // The unit changed (a new hash): read again.
    units.mockReturnValue([unit({ hash: "h2" })]);
    await readNameContexts(wanted, people);
    expect(read).toHaveBeenCalledTimes(2);
  } finally {
    units.mockRestore();
    read.mockRestore();
  }
});

test("a spoken sentence carries its clip; a clip lifelog cannot give leaves the sentence, and a unit that cannot be read leaves no context", async () => {
  const units = spyOn(files, "readUnitsFor").mockReturnValue([
    unit({ hash: "h3", key: "conv-1", source: "lifelog", title: "conv-1" }),
  ]);
  const spoken = spyOn(words, "spokenLines").mockResolvedValue(
    new Map([
      [
        "unit_000000000001",
        [turnOf(0, "unknown:speaker", "ask Bastien about the tiles")],
      ],
    ]) as never
  );
  const clip = {
    at: "2026-11-01T09:00:00.000Z",
    audio: { end: 4, jobId: "job-1", start: 1 },
    text: "ask Bastien about the tiles",
    until: null,
    words: [[0, 300, 3]],
  };
  const lifelog = spyOn(lifelogVoices, "readTurnClip");
  try {
    lifelog.mockResolvedValue(clip);
    spoken.mockResolvedValue(
      new Map([
        [
          "unit_000000000001",
          [
            {
              ...turnOf(0, "unknown:speaker", "ask Bastien about the tiles"),
              ref: "job-1:0@2026-11-01T09:00:00.000Z",
            },
          ],
        ],
      ]) as never
    );
    const [withClip] = [...(await readNameContexts(wanted, people)).values()];
    expect(withClip?.clips).toEqual([clip]);
    expect(withClip?.said.to).toBeNull();
    lifelog.mockRejectedValue(new Error("down"));
    units.mockReturnValue([
      unit({ hash: "h4", key: "conv-1", source: "lifelog", title: "conv-1" }),
    ]);
    const [noClip] = [...(await readNameContexts(wanted, people)).values()];
    expect(noClip?.clips).toEqual([]);
    expect(noClip?.said.text).toBe("ask Bastien about the tiles");
    spoken.mockRejectedValue(new Error("lifelog down"));
    units.mockReturnValue([
      unit({ hash: "h5", key: "conv-1", source: "lifelog", title: "conv-1" }),
    ]);
    expect((await readNameContexts(wanted, people)).size).toBe(0);
  } finally {
    units.mockRestore();
    spoken.mockRestore();
    lifelog.mockRestore();
  }
});

test("a name's card shows a line that holds the name, never the newest line when it does not; who it could be, the matters it rides on, its sentence's lines", () => {
  const held = line({
    date: "2026-10-01",
    id: "obs_000000000091",
    quote: "Bastien said he comes Thursday",
    speaker: "person:dana",
  });
  const newer = line({
    date: "2026-10-05",
    id: "obs_000000000092",
    quote: "The quote is ready",
  });
  const rows = [nameRow("Bastien", held.id), nameRow("bastien", newer.id)];
  const matter = {
    id: "matter_aaaaaaaaaaaa",
    lone: false,
    name: "Kitchen quote",
    open: true,
    owedTo: [],
    projects: [] as string[],
    status: "moving" as const,
    steps: stepsOf(held.id),
    waitingOn: [],
    with: [],
  };
  const said = {
    at: "2026-10-01T09:00:00.000Z",
    by: "Dana",
    channel: "whatsapp" as const,
    text: "Bastien said he comes Thursday, are you in?",
    to: "Kitchen crew",
  };
  const base = inputs([held, newer], {
    matters: [matter],
    unresolved: rows,
  });
  // Without the unit read: the quote of the newest line that holds the name, not the newest line.
  const [plain] = checksOf(base);
  expect(plain).toMatchObject({
    evidence: { quote: "Bastien said he comes Thursday" },
    question: 'Who is "Bastien / bastien"?',
    said: { by: "Dana", text: "Bastien said he comes Thursday" },
  });
  expect(plain?.onMatters).toEqual([
    { id: "matter_aaaaaaaaaaaa", name: "Kitchen quote" },
  ]);
  // With it: the unit's own line, its neighbours, the clip, the people it could be with one line each.
  const clip = {
    at: said.at,
    audio: { end: 3, jobId: "job-9", start: 1 },
    text: said.text,
    until: null,
    words: [[0, 300, 7]],
  };
  const [read] = checksOf({
    ...base,
    nameContexts: new Map([
      [
        "bastien",
        {
          after: [{ ...said, by: "You", text: "Yes." }],
          before: [{ ...said, text: "Morning." }],
          clips: [clip],
          said,
        },
      ],
    ]),
    people: {
      ...base.people,
      candidatesFor: () => ["person:bastien"],
    },
  });
  expect(read).toMatchObject({
    clips: [clip],
    likelyPeople: [{ ref: "person:bastien" }],
    said,
  });
});

test("a name shows the observation's own sentence, not an earlier line that also names the person", async () => {
  const units = spyOn(files, "readUnitsFor").mockReturnValue([
    unit({ hash: "h6" }),
  ]);
  const read = spyOn(words, "unitLines").mockResolvedValue({
    built: {},
    lines: [
      turnOf(0, "unknown:Dana", "Bastien called earlier."),
      ...chat.slice(1),
    ],
  } as never);
  try {
    const [context] = [...(await readNameContexts(wanted, people)).values()];
    expect(context?.said.text).toBe("Bastien comes Thursday, are you in?");
  } finally {
    units.mockRestore();
    read.mockRestore();
  }
});

test("a name is asked only while the person matters: an exchange or 3 days; never a description, nor a name he said not to name (life#724)", () => {
  const seen = line({ quote: "Bastien passes by" });
  const groups = (
    rows: NameRow[],
    over: { corrections?: Correction[]; spokeWithHim?: boolean } = {}
  ) =>
    nameGroupsOf({
      hisUnitsOf: (units) => new Set(over.spokeWithHim ? units : []),
      kept: new Set([seen.id]),
      lines: [seen],
      people: { corrections: over.corrections ?? [], resolve: () => null },
      unresolved: rows,
    }).map((g: { key: string }) => g.key);
  const onDays = (
    name: string,
    days: string[],
    via: NameRow["via"] = "model"
  ) => days.map((date) => nameRow(name, seen.id, { date, via }));
  // Mentioned on 2 days: a name in passing; on 3: asked.
  expect(groups(onDays("Bastien", ["2026-10-01", "2026-10-02"]))).toEqual([]);
  expect(
    groups(onDays("Bastien", ["2026-10-01", "2026-10-02", "2026-10-05"]))
  ).toEqual(["bastien"]);
  // Once, but they wrote in a chat where he wrote too: asked; where he did not: not.
  const once = onDays("Bastien", ["2026-10-01"], "speaker");
  expect(groups(once, { spokeWithHim: true })).toEqual(["bastien"]);
  expect(groups(once)).toEqual([]);
  // A mention is never an exchange, even in a unit holding his words.
  expect(
    groups(onDays("Bastien", ["2026-10-01"]), { spokeWithHim: true })
  ).toEqual([]);
  // A description, however often: never asked.
  expect(
    groups(onDays("la nounou", ["2026-10-01", "2026-10-02", "2026-10-05"]))
  ).toEqual([]);
  // A lowercase handle that wrote to him is a name, not a description.
  expect(
    groups(onDays("bastien", ["2026-10-01"], "speaker"), { spokeWithHim: true })
  ).toEqual(["bastien"]);
  // His "Don't name": never asked again.
  expect(
    groups(onDays("Bastien", ["2026-10-01", "2026-10-02", "2026-10-05"]), {
      corrections: [
        {
          at: "2026-10-06T09:00:00.000Z",
          kind: "not-worth-naming",
          nameOrHandle: "Bastien",
          schemaVersion: 1,
        } as Correction,
      ],
    })
  ).toEqual([]);
});
