import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { Episode } from "../records/episode";
import { ReadReply } from "../records/read-reply";
import { eventKey, type SourceEvent } from "../records/source";
import { Person } from "../records/truth";
import { episodeText } from "./doubts";
import { READS, storeReply } from "./exchange-reads";
import { MENTIONS, mentionsPath, READ_REPLIES } from "./memory-files";
import { placementOf } from "./mention-placement";
import {
  type Mention,
  mentionsOf,
  readMentions,
  readMentionsOn,
  talkedAboutOf,
  writeMentions,
} from "./mentions";
import { OWNER } from "./read-truth";
import { said } from "./record-fixtures";
import { tiesNow } from "./ties";
import { dayUnitId } from "./units";
import { foldsOf } from "./who";

const place = (
  m: Parameters<typeof placementOf>[0],
  p: Parameters<typeof tiesNow>[0] & Parameters<typeof placementOf>[1]
) => placementOf(m, p, tiesNow(p));
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
  expect(place(first, alone)).toEqual({
    proof: "name",
    ref: "person:alma",
  });
  // "Lena's sister" is no one's name: the whole words must resolve, never a part of them.
  const lenaCard = Person.parse({ aliases: [], id: "lena", name: "Lena" });
  const lena = {
    ...foldsOf([lenaCard], [], [], []),
    truth: { people: [lenaCard] },
  };
  expect(place(possessive, lena)).toBeNull();
  // A name that resolves but is not on the line (the model's words are not the message's) is left unknown.
  expect(place({ ...first, line: "great", who: "Alma" }, alone)).toBeNull();
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
  expect(place(first, folded)?.ref).toBe("person:alma-rey");
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
    expect(writeMentions({ events: [...chat, nov], failed: [] })).toEqual({
      failed: 0,
      mentions: 3,
    });
    expect(readdirSync(MENTIONS).sort()).toEqual([
      "2026-10.json",
      "2026-11.json",
    ]);
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
const saying = (who: string, by = OWNER) => ({
  at: chat[0]?.at as string,
  by,
  line: `${who} called`,
  quote: `${who} called`,
  unit: "unit_000000000001",
  who,
});

test("his relation word places a person when exactly one of his ties is that relation: two fathers, a text that only contains the word, a possessive and another speaker leave it unknown", () => {
  const one = directory(hugo);
  expect(place(saying("my father"), one)).toEqual({
    proof: "relation_word",
    ref: "person:hugo",
  });
  // French, a synonym and the bare word say the same relation.
  expect(place(saying("mon père"), one)?.ref).toBe("person:hugo");
  expect(place(saying("Dad"), one)?.ref).toBe("person:hugo");
  // "dad" and "father" are two of his ties to one relation.
  expect(place(saying("my father"), directory(hugo, ivan))).toBeNull();
  // "father of Lena" is not "father"; "Paul's father" is not his.
  expect(place(saying("my father"), directory(nina))).toBeNull();
  expect(place(saying("Paul's father"), one)).toBeNull();
  // Words that do not name one person by their nature are never placed, one in the directory or not.
  const friend = Person.parse({
    aliases: [],
    id: "fred",
    name: "Fred",
    relation: "friend",
  });
  const brother = Person.parse({
    aliases: [],
    id: "bo",
    name: "Bo",
    relation: "brother",
  });
  const girlfriend = Person.parse({
    aliases: [],
    id: "gigi",
    name: "Gigi",
    relation: "girlfriend",
  });
  expect(place(saying("my friend"), directory(friend))).toBeNull();
  expect(place(saying("my brother"), directory(brother))).toBeNull();
  expect(place(saying("ma copine"), directory(girlfriend))?.ref).toBe(
    "person:gigi"
  );
  // Not his tie: someone else saying it, or another relation.
  expect(place(saying("my father", "+1"), one)).toBeNull();
  expect(place(saying("my mother"), one)).toBeNull();
  // A name still wins, and the words must be on the line.
  expect(place(saying("Hugo"), one)?.proof).toBe("name");
  expect(place({ ...saying("my father"), line: "hello" }, one)).toBeNull();
});

test("a message he sent is his by fromMe, whatever address the source names as sender", () => {
  const mail: SourceEvent = {
    ...msg(0, true, "Dinner with my father tonight"),
    sender: "owner@example.com",
    source: "mail",
  };
  const [got] = mentionsOf(
    [
      stored(
        READS.mentions.prompt,
        [mail],
        [mention(0, "my father", "my father")]
      ),
    ],
    new Map([[eventKey(mail), mail]])
  ) as [Mention];
  expect(got.by).toBe(OWNER);
  expect(place(got, directory(hugo))).toEqual({
    proof: "relation_word",
    ref: "person:hugo",
  });
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
    talkedAboutOf(episode, talk, (m) => place(m, people)?.ref, people.canon)
  ).toEqual(["person:hugo"]);
  // Someone else saying his own name places a mention on him: not talked about.
  const himself = Person.parse({ aliases: [], id: "me", name: "Owen" });
  const withHim = directory(hugo, himself);
  expect(place(saying("Owen", "+1"), withHim)?.ref).toBe("person:me");
  expect(
    talkedAboutOf(
      episode,
      [saying("Owen", "+1")],
      (m) => place(m, withHim)?.ref,
      withHim.canon
    )
  ).toEqual([]);
  // The memory line never holds it.
  expect(episodeText(episode, (ref) => ref)).toBe("Dinner; with person:ivan.");
});

test("a wording that picks keeps the pick and the earlier line's words in the mention; the live prompt's lines stay as before", () => {
  const picking = stored("memory-mentions.v2", chat, [
    {
      ...mention(2, "it", "Lena's sister is moving"),
      namedOn: 0,
      ref: "person:alma",
    },
    // A line later than the move is no earlier naming.
    { ...mention(0, "she", "Dinner with Alma"), namedOn: 2, ref: "x" },
  ]);
  const [late, pick] = mentionsOf([picking], events, "memory-mentions.v2");
  expect(pick?.ref).toBe("person:alma");
  expect(pick?.namedOn).toEqual({ by: "+1", line: chat[0]?.text ?? "" });
  expect(late?.namedOn).toBeUndefined();
  // The night's call keeps its own prompt: this one's lines are not its.
  expect(mentionsOf([picking], events)).toEqual([]);
  expect(
    mentionsOf([stored(READS.mentions.prompt)], events)[0]
  ).not.toHaveProperty("ref");
});
