import { expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { ReadReply } from "../records/read-reply";
import { eventKey, type SourceEvent } from "../records/source";
import { Person } from "../records/truth";
import { READS, storeReply } from "./exchange-reads";
import { MENTIONS, READ_REPLIES } from "./memory-files";
import {
  type Mention,
  mentionsOf,
  readMentions,
  writeMentions,
} from "./mentions";
import { said } from "./record-fixtures";
import { dayUnitId } from "./units";
import { foldsOf, placementOf } from "./who";

const msg = (id: number, fromMe: boolean, text: string): SourceEvent => ({
  at: `2026-10-0${id + 1}T12:00:00.000Z`,
  chat: "+1",
  fromMe,
  id: `+1:${id}`,
  sender: fromMe ? "me" : "+1",
  source: "whatsapp",
  text,
});
const chat = [
  msg(0, false, "Dinner with Alma went well, and Alma's mother came too"),
  msg(1, true, "great"),
  msg(2, false, "Lena's sister is moving"),
];
const events = new Map(chat.map((e) => [eventKey(e), e]));
const mention = (line: number, who: string, quote: string) => ({
  code: "mention",
  kind: "fact",
  line,
  purpose: "informs",
  quote,
  reported: false,
  scope: "act",
  tone: "neutral",
  who,
});
const stored = (prompt: string) =>
  ReadReply.parse({
    at: "2026-10-09T00:00:00.000Z",
    madeBy: { engine: "codex", model: "m", prompt, run: "r" },
    messages: chat.map(eventKey),
    promptDigest: "a".repeat(16),
    read: "mentions",
    reply: {
      exchanges: [
        {
          exchange: 0,
          moves: [
            mention(0, "Alma", "Dinner with Alma"),
            mention(2, "Lena's sister", "Lena's sister is moving"),
            { code: "feels", line: 1, quote: "great", valence: "positive" },
          ],
        },
      ],
    },
    schemaVersion: 1,
    starts: [0],
  });

test("mentions keep the words as written, the day's unit and the sender, never a person; an old prompt's lines are left out", () => {
  const got = mentionsOf(
    [stored(READS.mentions.prompt), stored("memory-mentions.v0")],
    events
  );
  expect(got).toEqual([
    {
      at: chat[0]?.at as string,
      by: "+1",
      line: chat[0]?.text as string,
      quote: "Dinner with Alma",
      unit: dayUnitId(chat[0] as SourceEvent),
      who: "Alma",
    },
    {
      at: chat[2]?.at as string,
      by: "+1",
      line: chat[2]?.text as string,
      quote: "Lena's sister is moving",
      unit: dayUnitId(chat[2] as SourceEvent),
      who: "Lena's sister",
    },
  ]);
  // A message gone from the sources leaves its lines out.
  expect(mentionsOf([stored(READS.mentions.prompt)], new Map())).toEqual([]);
});

test("a name is placed; a possessive and a name not on the line are not; a fold moves the person with no rewrite", () => {
  const alma = Person.parse({ aliases: [], id: "alma", name: "Alma" });
  const almaB = Person.parse({ aliases: [], id: "alma-rey", name: "Alma Rey" });
  const [first, possessive] = mentionsOf(
    [stored(READS.mentions.prompt)],
    events
  ) as [Mention, Mention];
  const alone = foldsOf([alma], [], [], []);
  expect(placementOf(first, alone)).toEqual({
    proof: "name",
    ref: "person:alma",
  });
  // "Lena's sister" is no one's name: the whole words must resolve, never a part of them.
  const lena = foldsOf(
    [Person.parse({ aliases: [], id: "lena", name: "Lena" })],
    [],
    [],
    []
  );
  expect(placementOf(possessive, lena)).toBeNull();
  // A name that resolves but is not on the line (the model's words are not the message's) is left unknown.
  expect(
    placementOf({ ...first, line: "great", who: "Alma" }, alone)
  ).toBeNull();
  const folded = foldsOf(
    [alma, almaB],
    [],
    [
      said({
        from: "person:alma",
        kind: "same-person",
        to: "person:alma-rey",
      }),
    ],
    []
  );
  expect(placementOf(first, folded)?.ref).toBe("person:alma-rey");
});

test("the night keeps mentions by day with no person in the file; a failed source leaves the last file standing", () => {
  try {
    storeReply(stored(READS.mentions.prompt), chat[0]?.at ?? "");
    expect(writeMentions({ events: chat, failed: [] })).toEqual({
      failed: 0,
      mentions: 2,
    });
    expect(Object.keys(readMentions() ?? {})).toEqual([
      "2026-10-01",
      "2026-10-03",
    ]);
    expect(readFileSync(MENTIONS, "utf8")).not.toContain("person:");
    const kept = readFileSync(MENTIONS, "utf8");
    expect(writeMentions({ events: [], failed: ["mail"] })).toEqual({
      failed: 1,
      mentions: 0,
    });
    expect(readFileSync(MENTIONS, "utf8")).toBe(kept);
  } finally {
    rmSync(MENTIONS, { force: true });
    rmSync(READ_REPLIES, { force: true, recursive: true });
  }
});
