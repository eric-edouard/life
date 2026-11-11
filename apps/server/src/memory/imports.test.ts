import { beforeEach, expect, spyOn, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendJsonl } from "../core/files";
import { setSettings, settings } from "../core/settings";
import { Imported } from "../records/observation";
import { conversationsOf, exportsDir } from "../sources/assistants";
import { dryRun, importExport, parseJudged, readExport } from "./imports";
import { IMPORTED } from "./ledger";

beforeEach(() =>
  rmSync(exportsDir("claude"), { force: true, recursive: true })
);

// A made-up claude.ai export: one conversation about his life, one only code.
const exportOf = (text: string) => [
  {
    chat_messages: [
      {
        created_at: "2026-03-02T09:15:00.000Z",
        sender: "human",
        text,
        uuid: "m1",
      },
    ],
    name: "Ada's move",
    uuid: "imp1",
  },
  {
    chat_messages: [
      {
        created_at: "2026-03-03T10:00:00.000Z",
        sender: "human",
        text: "```ts\nthrow new Error()\n```",
        uuid: "m2",
      },
    ],
    name: "A bug",
    uuid: "imp2",
  },
];

const folderWith = (json: unknown) => {
  const dir = mkdtempSync(join(tmpdir(), "export-"));
  writeFileSync(join(dir, "conversations.json"), JSON.stringify(json));
  return dir;
};

test("the dry run counts an export's conversations and days", () => {
  const s = dryRun(folderWith(exportOf("My sister Ada moves to Lyon in May.")));
  expect([
    s.source,
    s.conversations,
    s.messages,
    s.days,
    s.from,
    s.calls,
  ]).toEqual(["claude", { all: 2, kept: 1 }, 1, 1, "2026-03-02", 1]);
});

// ChatGPT's own shape: a tree of messages, his the `user` ones.
const chatgptConversation = (id: string, text: string) => ({
  conversation_id: id,
  create_time: 1_772_442_900,
  current_node: "n1",
  mapping: {
    n1: {
      message: {
        author: { role: "user" },
        content: { content_type: "text", parts: [text] },
        create_time: 1_772_442_900,
        id: `${id}-m1`,
      },
    },
  },
  title: id,
});

test("a ChatGPT export split into numbered files is one export, in the files' order", () => {
  const dir = mkdtempSync(join(tmpdir(), "export-"));
  const [first, second] = [
    chatgptConversation("c1", "My sister Ada moves to Lyon in May."),
    chatgptConversation("c2", "I will visit Ada after her move."),
  ];
  // Written out of order, beside the export's other files; 1000 comes after 999, by number and not by letters.
  writeFileSync(join(dir, "conversations-1000.json"), JSON.stringify([second]));
  writeFileSync(join(dir, "conversations-999.json"), JSON.stringify([first]));
  writeFileSync(join(dir, "conversation_asset_file_names.json"), "{}");
  const read = readExport(dir);
  expect([read.source, read.conversations.map((c) => c.id)]).toEqual([
    "chatgpt",
    ["c1", "c2"],
  ]);
  // What Life keeps is the two as one file, the same bytes on every read: a repeated import is not another export.
  expect(JSON.parse(read.copy.toString())).toEqual([first, second]);
  expect(readExport(dir).copy.equals(read.copy)).toBe(true);
});

test("a judging reply is checked: one line per conversation asked about", () => {
  const judged = parseJudged(
    {
      conversations: [
        { id: "c1", keep: true, why: "His sister's move." },
        { id: "c1", keep: false, why: "Again." },
        { id: "zz", keep: true, why: "Not asked." },
      ],
    },
    new Map([["c1", "h1"]]),
    {
      at: "2026-10-21T00:00:00.000Z",
      madeBy: { engine: "codex", model: "m", prompt: "import.v1", run: "r" },
      source: "claude",
    }
  );
  expect(judged.invalid).toBe(2);
  expect(judged.records.map((r) => [r.conversation, r.keep, r.hash])).toEqual([
    ["claude:c1", true, "h1"],
  ]);
});

test("an import without a historical engine stops before copying or any model work", async () => {
  const folder = folderWith(exportOf("An older export."));
  const before = settings().backfillEngine;
  try {
    setSettings({ backfillEngine: null });
    await expect(importExport(folder)).rejects.toThrow("set backfillEngine");
    expect(dryRun(folder).source).toBe("claude");
    expect(existsSync(exportsDir("claude"))).toBe(false);
  } finally {
    setSettings({ backfillEngine: before ?? null });
  }
});

test("imports route quota and calls to the historical engine and keep import.v1 judgments across engines", async () => {
  const json = exportOf("My sister Ada moves to Lyon in May.");
  const first = json.at(0);
  if (!first) {
    throw new Error("missing fixture conversation");
  }
  first.uuid = "already";
  const next = {
    ...first,
    chat_messages: [
      {
        created_at: "2026-03-02T10:15:00.000Z",
        sender: "human",
        text: "I will visit Ada after her move.",
        uuid: "next",
      },
    ],
    uuid: "remaining",
  };
  json.push(next, {
    ...first,
    chat_messages: [
      {
        created_at: "2001-01-01T23:30:00.000Z",
        sender: "human",
        text: "Explain these general design options.",
        uuid: "old-message",
      },
    ],
    uuid: "ancient-unkept",
  });
  const folder = folderWith(json);
  mkdirSync(exportsDir("claude"), { recursive: true });
  writeFileSync(
    join(exportsDir("claude"), "conversations.json"),
    JSON.stringify(json)
  );
  appendJsonl(IMPORTED, Imported, [
    {
      at: "2026-03-04T00:00:00Z",
      conversation: "claude:ancient-unkept",
      keep: false,
      madeBy: {
        engine: "claude",
        model: "old",
        prompt: "import.v1",
        run: "old",
      },
      schemaVersion: 1,
      why: "General work, still searchable.",
    },
    {
      at: "2026-03-04T00:00:00Z",
      conversation: "claude:already",
      keep: true,
      madeBy: {
        engine: "claude",
        model: "old",
        prompt: "import.v1",
        run: "old",
      },
      schemaVersion: 1,
      why: "About family.",
    },
  ]);
  const before = settings().backfillEngine;
  const schedule = await import("./schedule");
  const models = await import("../models/llm");
  const zones = await import("./zones");
  const localDay = spyOn(zones, "localDate").mockImplementation(
    (at) => zones.wall(at, "Pacific/Kiritimati").day
  );
  const quota = spyOn(schedule, "spareQuota").mockResolvedValue();
  const ask = spyOn(models, "askOnce")
    .mockRejectedValueOnce(new Error("Codex unavailable"))
    .mockResolvedValue({
      conversations: [{ id: "remaining", keep: true, why: "About family." }],
    });
  try {
    setSettings({ backfillEngine: "codex" });
    const deferred = await importExport(folder);
    expect(deferred).toMatchObject({ asked: 1, failed: 1, unjudged: 1 });
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask.mock.calls[0]?.[0].llm.engine).toBe("codex");
    const result = await importExport(folder);
    expect(quota).toHaveBeenCalledWith("codex");
    expect(ask).toHaveBeenCalledTimes(2);
    expect(ask.mock.calls[1]?.[0].llm.engine).toBe("codex");
    expect(result).toMatchObject({
      asked: 1,
      failed: 0,
      kept: 2,
      // Only the conversation judged now: the two with lines from before are neither new nor changed.
      units: { days: 1, from: "2026-03-02", to: "2026-03-02" },
      unjudged: 0,
    });
    expect(result.read.from).toBe("2001-01-02");
    expect(result.read.to).toBe("2026-03-03");
    const again = await importExport(folder);
    expect(again.asked).toBe(0);
    expect(ask).toHaveBeenCalledTimes(2);
  } finally {
    ask.mockRestore();
    quota.mockRestore();
    localDay.mockRestore();
    setSettings({ backfillEngine: before ?? null });
  }
});

// A made-up claude.ai conversation: its messages as [id, text, instant].
const chat = (
  uuid: string,
  updated: string,
  ...turns: [string, string, string][]
) => ({
  chat_messages: turns.map(([id, text, at]) => ({
    created_at: at,
    sender: "human",
    text,
    uuid: id,
  })),
  name: uuid,
  updated_at: updated,
  uuid,
});

test("a newer export lands beside the older and only what changed is asked, read and collected", async () => {
  const long = `My sister Ada moves to Lyon in May. ${"We talk about it. ".repeat(180)}`;
  const older = [
    chat("g1", "2026-03-02T10:00:00.000Z", [
      "a",
      long,
      "2026-03-02T09:00:00.000Z",
    ]),
    chat("g2", "2026-03-02T10:00:00.000Z", [
      "b",
      "Bo's dinner is on Friday.",
      "2026-03-02T09:30:00.000Z",
    ]),
    chat("g5", "2026-02-10T10:00:00.000Z", [
      "c",
      "Plan the Sunday lunch.",
      "2026-02-10T09:00:00.000Z",
    ]),
  ];
  const newer = [
    chat(
      "g1",
      "2026-05-01T10:00:00.000Z",
      ["a", long, "2026-03-02T09:00:00.000Z"],
      ["d", "Ada has moved.", "2026-05-01T09:00:00.000Z"]
    ),
    chat("g5", "2026-03-04T10:00:00.000Z", [
      "c",
      "Plan the Monday lunch.",
      "2026-03-04T09:00:00.000Z",
    ]),
    chat("g3", "2026-04-10T10:00:00.000Z", [
      "e",
      "Book the train to Lyon.",
      "2026-04-10T09:00:00.000Z",
    ]),
  ];
  const before = settings().backfillEngine;
  const schedule = await import("./schedule");
  const models = await import("../models/llm");
  const quota = spyOn(schedule, "spareQuota").mockResolvedValue();
  const ask = spyOn(models, "askOnce").mockImplementation(async (opts) => ({
    conversations: (
      opts.input as { conversations: { id: string }[] }
    ).conversations.map((c) => ({
      id: c.id,
      keep: true,
      why: "About family.",
    })),
  }));
  const asked = () =>
    ask.mock.calls
      .flatMap(
        (c) => (c[0].input as { conversations: { id: string }[] }).conversations
      )
      .map((c) => c.id);
  try {
    setSettings({ backfillEngine: "codex" });
    await importExport(folderWith(older));
    expect(asked()).toEqual(["g1", "g2", "g5"]);
    const newerFolder = folderWith(newer);
    const dry = dryRun(newerFolder);
    expect(dry.new).toEqual({ changed: 2, conversations: 1, messages: 3 });
    expect(dry.calls).toBe(1);
    const result = await importExport(newerFolder);
    // g1 grew past its gist: not asked again. g5's words changed and g3 is new.
    expect(asked().slice(3)).toEqual(["g5", "g3"]);
    // g5's old day (its edited message moved) is collected too, with every day a change touched.
    expect(result.units).toEqual({
      days: 5,
      from: "2026-02-10",
      to: "2026-05-01",
    });
    // g2 is missing from the newer export and still read; the new turn and conversation are read.
    expect(
      conversationsOf("claude").map((c) => [c.id, c.messages.length])
    ).toEqual([
      ["g1", 2],
      ["g2", 1],
      ["g5", 1],
      ["g3", 1],
    ]);
    expect(readdirSync(exportsDir("claude"))).toHaveLength(2);
    // The same export again adds no copy and asks nothing.
    const again = await importExport(newerFolder);
    expect(again).toMatchObject({ asked: 0, units: { days: 0 } });
    expect(readdirSync(exportsDir("claude"))).toHaveLength(2);
    expect(asked()).toHaveLength(5);
  } finally {
    ask.mockRestore();
    quota.mockRestore();
    setSettings({ backfillEngine: before ?? null });
  }
});
