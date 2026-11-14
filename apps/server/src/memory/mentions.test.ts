import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { Episode } from "../records/episode";
import { ReadReply } from "../records/read-reply";
import { eventKey, type SourceEvent } from "../records/source";
import { Person } from "../records/truth";
import { episodeText } from "./doubts";
import { READS, storeReply } from "./exchange-reads";
import { MENTIONS, mentionsPath, READ_REPLIES } from "./memory-files";
import {
  type Mention,
  mentionsOf,
  readMentions,
  readMentionsOn,
  talkedAboutOf,
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
const stored = (prompt: string, held = chat, moves?: unknown[]) =>
  ReadReply.parse({
    at: "2026-10-09T00:00:00.000Z",
    madeBy: { engine: "codex", model: "m", prompt, run: "r" },
    messages: held.map(eventKey),
    promptDigest: "a".repeat(16),
    read: "mentions",
    reply: {
      exchanges: [
        {
          exchange: 0,
          moves: moves ?? [
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

test("an exchange read again after it grew counts once, from its newest line", () => {
  const before = stored(READS.mentions.prompt, chat.slice(0, 2), [
    mention(0, "Old", "Dinner with Alma"),
  ]);
  const grown = stored(READS.mentions.prompt);
  expect(mentionsOf([before], events).map((m) => m.who)).toEqual(["Old"]);
  expect(mentionsOf([before, grown], events).map((m) => m.who)).toEqual([
    "Alma",
    "Lena's sister",
  ]);
});

test("a name is placed; a possessive and a name not on the line are not; a fold moves the person with no rewrite", () => {
  const alma = Person.parse({ aliases: [], id: "alma", name: "Alma" });
  const almaB = Person.parse({ aliases: [], id: "alma-rey", name: "Alma Rey" });
  const [first, possessive] = mentionsOf(
    [stored(READS.mentions.prompt)],
    events
  ) as [Mention, Mention];
  const alone = { ...foldsOf([alma], [], [], []), truth: { people: [alma] } };
  expect(placementOf(first, alone)).toEqual({
    proof: "name",
    ref: "person:alma",
  });
  // "Lena's sister" is no one's name: the whole words must resolve, never a part of them.
  const lenaCard = Person.parse({ aliases: [], id: "lena", name: "Lena" });
  const lena = {
    ...foldsOf([lenaCard], [], [], []),
    truth: { people: [lenaCard] },
  };
  expect(placementOf(possessive, lena)).toBeNull();
  // A name that resolves but is not on the line (the model's words are not the message's) is left unknown.
  expect(
    placementOf({ ...first, line: "great", who: "Alma" }, alone)
  ).toBeNull();
  const folded = {
    ...foldsOf(
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
    ),
    truth: { people: [alma, almaB] },
  };
  expect(placementOf(first, folded)?.ref).toBe("person:alma-rey");
});

test("the night keeps mentions one file a month, with no person in them; a month with none left goes; a failed source leaves the files standing", () => {
  const nov = {
    ...msg(0, false, "Dinner with Zoe"),
    at: "2026-11-05T12:00:00.000Z",
    id: "+1:9",
  };
  try {
    storeReply(stored(READS.mentions.prompt), chat[0]?.at ?? "");
    storeReply(
      stored(
        READS.mentions.prompt,
        [nov],
        [mention(0, "Zoe", "Dinner with Zoe")]
      ),
      nov.at
    );
    // The file of before the months is gone with the first night.
    mkdirSync(dirname(MENTIONS), { recursive: true });
    writeFileSync(`${MENTIONS}.json`, "{}");
    expect(writeMentions({ events: [...chat, nov], failed: [] })).toEqual({
      failed: 0,
      mentions: 3,
    });
    expect(readdirSync(MENTIONS).sort()).toEqual([
      "2026-10.json",
      "2026-11.json",
    ]);
    expect(existsSync(`${MENTIONS}.json`)).toBe(false);
    expect(Object.keys(readMentions() ?? {})).toEqual([
      "2026-10-01",
      "2026-10-03",
      "2026-11-05",
    ]);
    expect(readMentionsOn("2026-11-05").map((m) => m.who)).toEqual(["Zoe"]);
    expect(readMentionsOn("2026-12-01")).toEqual([]);
    expect(readFileSync(mentionsPath("2026-10"), "utf8")).not.toContain(
      "person:"
    );
    const kept = readFileSync(mentionsPath("2026-10"), "utf8");
    expect(writeMentions({ events: [], failed: ["mail"] })).toEqual({
      failed: 1,
      mentions: 0,
    });
    expect(readFileSync(mentionsPath("2026-10"), "utf8")).toBe(kept);
    expect(existsSync(mentionsPath("2026-11"))).toBe(true);
    // The November message gone from the sources: its month's file goes.
    writeMentions({ events: chat, failed: [] });
    expect(readdirSync(MENTIONS)).toEqual(["2026-10.json"]);
  } finally {
    rmSync(MENTIONS, { force: true, recursive: true });
    rmSync(READ_REPLIES, { force: true, recursive: true });
  }
});

const hugo = Person.parse({
  aliases: [],
  id: "hugo",
  name: "Hugo",
  relation: "father, lives in Lyon",
});
const ivan = Person.parse({
  aliases: [],
  id: "ivan",
  name: "Ivan",
  relation: "dad",
});
const nina = Person.parse({
  aliases: [],
  id: "nina",
  name: "Nina",
  relation: "father of Lena",
});
const directory = (...people: Person[]) => ({
  ...foldsOf(people, [], [], []),
  truth: { people },
});
const saying = (who: string, by = "me") => ({
  at: chat[0]?.at as string,
  by,
  line: `${who} called`,
  quote: `${who} called`,
  unit: "unit_000000000001",
  who,
});

test("his relation word places a person when exactly one of his ties is that relation: two fathers, a text that only contains the word, a possessive and another speaker leave it unknown", () => {
  const one = directory(hugo);
  expect(placementOf(saying("my father"), one)).toEqual({
    proof: "relation_word",
    ref: "person:hugo",
  });
  // French, a synonym and the bare word say the same relation.
  expect(placementOf(saying("mon père"), one)?.ref).toBe("person:hugo");
  expect(placementOf(saying("Dad"), one)?.ref).toBe("person:hugo");
  // "dad" and "father" are two of his ties to one relation.
  expect(placementOf(saying("my father"), directory(hugo, ivan))).toBeNull();
  // "father of Lena" is not "father"; "Paul's father" is not his.
  expect(placementOf(saying("my father"), directory(nina))).toBeNull();
  expect(placementOf(saying("Paul's father"), one)).toBeNull();
  // Not his tie: someone else saying it, or another relation.
  expect(placementOf(saying("my father", "+1"), one)).toBeNull();
  expect(placementOf(saying("my mother"), one)).toBeNull();
  // A name still wins, and the words must be on the line.
  expect(placementOf(saying("Hugo"), one)?.proof).toBe("name");
  expect(
    placementOf({ ...saying("my father"), line: "hello" }, one)
  ).toBeNull();
});

test("who an episode talked about: those its units placed, never those taking part or him", () => {
  const episode = Episode.parse({
    copies: [],
    day: "2026-10-01",
    end: null,
    id: "ep_000000000001",
    importance: 2,
    madeBy: { engine: "codex", model: "m", prompt: "p", run: "r" },
    people: [{ ref: "person:ivan", role: "with" }],
    place: null,
    schemaVersion: 1,
    start: null,
    title: "Dinner",
    units: ["unit_000000000001"],
    what: "",
    within: null,
  });
  const people = directory(hugo, ivan);
  const talk = [
    saying("my father"),
    saying("Ivan"),
    saying("Hugo"),
    { ...saying("Nina"), unit: "unit_000000000002" },
  ];
  expect(
    talkedAboutOf(
      episode,
      talk,
      (m) => placementOf(m, people)?.ref,
      people.canon
    )
  ).toEqual(["person:hugo"]);
  // The memory line never holds it.
  expect(episodeText(episode, (ref) => ref)).toBe("Dinner; with person:ivan.");
});
