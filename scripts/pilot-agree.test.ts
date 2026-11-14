import { expect, test } from "bun:test";
import { checkedOf } from "@life/server/src/memory/moves";
import { tiesNow } from "@life/server/src/memory/ties";
import { foldsOf } from "@life/server/src/memory/who";
import { ReadReply } from "@life/server/src/records/read-reply";
import { eventKey, type SourceEvent } from "@life/server/src/records/source";
import { Person } from "@life/server/src/records/truth";
import {
  aimedAtOf,
  byEyeOf,
  type Kept,
  peopleBetween,
  peopleOf,
  rowOf,
} from "./pilot-agree";

const person = (id: string, name: string, aliases: string[]) =>
  Person.parse({ aliases, id, name });
const cast = [
  person("hugo-blanc", "Hugo Blanc", ["Hugo"]),
  person("lea-morel", "Léa Morel", ["Léa"]),
];
const directory = {
  ...foldsOf(cast, [], [], []),
  nameOf: (ref: string) =>
    cast.find((p) => `person:${p.id}` === ref)?.name ?? ref,
  truth: { people: cast },
};
const ties = tiesNow(directory);
const LEA = "person:lea-morel";
const HUGO = "person:hugo-blanc";

const said = (n: number, sender: string, text: string): SourceEvent => ({
  at: `2026-10-01T12:0${n}:00.000Z`,
  chat: "room",
  fromMe: sender === "me",
  id: String(n),
  sender,
  source: "whatsapp",
  text,
});
const room = [
  said(0, "me", "Léa a annulé, Hugo aussi"),
  said(1, "Hugo Blanc", "elle abuse"),
  said(2, "me", "Hugo is late"),
  said(3, "me", "Léa is here"),
];
const events = new Map(room.map((e) => [eventKey(e), e]));
const speakerOf = (e: SourceEvent) => (e.fromMe ? "me" : e.sender);
const mention = (
  line: number,
  who: string,
  quote: string,
  aimedAt: string,
  more: Record<string, unknown>
) => ({
  aimedAt,
  code: "mention",
  kind: "fact",
  line,
  purpose: "informs",
  quote,
  reported: false,
  scope: "act",
  tone: "neutral",
  who,
  ...more,
});
const keptOf = (moves: unknown[]): Kept =>
  checkedOf(
    [
      ReadReply.parse({
        at: "2026-10-02T00:00:00.000Z",
        madeBy: { engine: "codex", model: "m", prompt: "p", run: "r" },
        messages: room.map(eventKey),
        promptDigest: "a".repeat(16),
        read: "mentions",
        reply: { exchanges: [{ exchange: 1, moves }] },
        schemaVersion: 1,
        starts: [1],
      }),
    ],
    "mentions",
    events,
    speakerOf
  );
const one = keptOf([
  mention(1, "elle", "elle abuse", "me", { namedOn: 0, ref: LEA }),
  mention(2, "Hugo", "Hugo is late", "Hugo Blanc", { ref: "unknown" }),
  mention(3, "Léa", "Léa is here", "Hugo Blanc", { ref: HUGO }),
]);
const two = keptOf([
  mention(1, "elle", "elle abuse", "me", { namedOn: 0, ref: HUGO }),
  mention(2, "Hugo", "Hugo is late", "all", { ref: HUGO }),
  mention(3, "Léa", "Léa is here", "Hugo Blanc", { ref: LEA }),
]);

test("whom the moves are aimed at: the pairs both sides list, and how many agree", () => {
  expect(aimedAtOf(one, two, speakerOf)).toEqual({
    moves: 3,
    same: 2,
    share: 0.67,
  });
  expect(aimedAtOf(one, new Map(), speakerOf).moves).toBe(0);
});

test("who is meant, by proof: code's reading is the floor, a pick it contradicts is counted a veto, a name the read answered unknown is counted", () => {
  expect(peopleOf(one, directory, ties)).toEqual({
    agree: 0,
    byCodeAlone: 2,
    byEarlierNaming: 1,
    byName: 2,
    byRelationWord: 0,
    mentions: 3,
    namedOnGiven: 1,
    namedOnPassing: 1,
    picks: 2,
    unknownOverCode: 1,
    vetoed: 1,
  });
  expect(peopleOf(two, directory, ties)).toMatchObject({
    agree: 2,
    picks: 3,
    unknownOverCode: 0,
    vetoed: 0,
  });
});

test("between two readings, the mentions both place are the same person or a different one", () => {
  expect(peopleBetween(one, two, directory, ties)).toEqual({
    bothPlaced: 3,
    differentPerson: 1,
    samePerson: 2,
  });
});

test("the pronouns placed by an earlier naming are listed for a person to read", () => {
  expect(byEyeOf(one, 20, directory, ties)).toEqual([
    {
      earlier: "Léa a annulé, Hugo aussi",
      key: "whatsapp|1",
      line: "elle abuse",
      name: "Léa Morel",
      who: "elle",
    },
  ]);
  expect(byEyeOf(one, 0, directory, ties)).toEqual([]);
});

test("a code holds at the bar given: 0.5 against another family, 0.7 against the same model", () => {
  const read = (yes: boolean) => ({ marks: new Set<string>(yes ? ["m"] : []) });
  // 25 both, 3 and 3 apart, 9 neither: a kappa of 0.64.
  const shared = [
    ...new Array(25).fill([read(true), read(true)]),
    ...new Array(3).fill([read(true), read(false)]),
    ...new Array(3).fill([read(false), read(true)]),
    ...new Array(9).fill([read(false), read(false)]),
  ];
  const has = (r: { marks: Set<string> }) => r.marks.has("m");
  expect(rowOf("m", shared, has, 0.5)).toMatchObject({
    kappa: 0.64,
    result: "holds",
  });
  expect(rowOf("m", shared, has, 0.7).result).toBe("fails");
});
