import { expect, test } from "bun:test";
import type { LinkBatch } from "../records/link";
import type { Observation } from "../records/observation";
import { endingsOf, keptLinks, nightOf, subjectWorkOf } from "./links";

const ann = "person:ann";
const obs = (n: number, at: string, quote: string): Observation =>
  ({
    at,
    date: at.slice(0, 10),
    id: `obs_${String(n).padStart(12, "0")}`,
    quote,
    speaker: "person:me",
    subjects: [ann],
    text: quote,
    type: "promise",
  }) as Observation;
const promise = obs(
  1,
  "2026-10-01T10:00:00.000Z",
  "I'll send you the contract"
);
const sent = obs(
  2,
  "2026-10-03T09:00:00.000Z",
  "Contract sent this morning, check your mail"
);
const unrelated = obs(
  3,
  "2026-10-04T09:00:00.000Z",
  "See you at the gym on Friday"
);
const batch = (
  open: Observation[],
  offered: Observation[],
  links: LinkBatch["links"] = []
): LinkBatch => ({
  at: "2026-10-05T22:00:00.000Z",
  links,
  madeBy: { engine: "claude", model: "m", prompt: "p", run: "r" },
  offered: offered.map((o) => o.id),
  open: open.map((o) => o.id),
  schemaVersion: 1,
  subject: ann,
});

test("a link is kept only when both ends were shown, the later one is later, and its words are found in its own quote", () => {
  const call = { later: [sent, unrelated], open: [promise] };
  const link = (earlier: string, later: string, quote: string) => ({
    earlier,
    later,
    quote,
  });
  expect(
    keptLinks(
      {
        links: [
          link(promise.id, sent.id, "contract sent this morning"),
          // Words the later observation never held.
          link(promise.id, unrelated.id, "he sent the contract"),
          // An end that was not shown.
          link("obs_00000000dead", sent.id, "Contract sent this morning"),
          // The wrong way round: nothing ends before it was said.
          link(sent.id, promise.id, "I'll send you the contract"),
        ],
      },
      call
    )
  ).toEqual([
    {
      earlier: promise.id,
      later: sent.id,
      quote: "Contract sent this morning",
      relation: "ends",
    },
  ]);
  expect(
    keptLinks(
      { links: [link(promise.id, sent.id, "Contract sent this morning")] },
      { later: [{ ...sent, at: promise.at }], open: [promise] }
    )
  ).toEqual([]);
  expect(keptLinks({}, call)).toEqual([]);
});

test("a pair is judged once: a later observation is due until a batch holds it with that open thing", () => {
  const work = subjectWorkOf(ann, [promise], [unrelated, sent], []);
  // Oldest first; an observation from before the open thing is never due for it.
  expect(work?.chunks).toEqual([[sent, unrelated]]);
  expect(work?.open).toEqual([promise]);
  expect(
    subjectWorkOf(
      ann,
      [promise],
      [
        sent,
        { ...sent, at: "2026-09-01T00:00:00.000Z", id: "obs_000000000009" },
      ],
      [batch([promise], [sent])]
    )
  ).toBeNull();
  // A promise made after that batch was never judged against the same later observations.
  const second = obs(4, "2026-10-02T10:00:00.000Z", "and the invoice too");
  const again = subjectWorkOf(
    ann,
    [promise, second],
    [sent, unrelated],
    [batch([promise], [sent, unrelated])]
  );
  expect(again?.open).toEqual([second]);
  expect(again?.chunks).toEqual([[sent, unrelated]]);
});

test("what ends a thing is its first link whose two ends are both current", () => {
  const first = {
    earlier: promise.id,
    later: unrelated.id,
    quote: "x",
    relation: "ends" as const,
  };
  const then = {
    earlier: promise.id,
    later: sent.id,
    quote: "y",
    relation: "ends" as const,
  };
  const batches = [
    batch([promise], [unrelated], [first]),
    batch([promise], [sent], [then]),
  ];
  expect(endingsOf(batches, () => true).get(promise.id)?.later).toBe(
    unrelated.id
  );
  // Its later end was re-read away: the link counts for nothing, the next one stands.
  expect(
    endingsOf(batches, (id) => id !== unrelated.id).get(promise.id)?.later
  ).toBe(sent.id);
  // The open thing itself re-read away: no ending under its old id.
  expect(endingsOf(batches, (id) => id !== promise.id).size).toBe(0);
});

test("a night takes the oldest due work first and caps each person, so a long backlog neither starves nor is starved", () => {
  const chunk = (at: string) => [obs(7, at, "q")];
  const big = {
    chunks: Array.from({ length: 30 }, () => chunk("2026-01-01T00:00:00.000Z")),
    open: [promise],
    subject: "person:big",
  };
  const small = {
    chunks: [chunk("2026-10-01T00:00:00.000Z")],
    open: [promise],
    subject: ann,
  };
  const night = nightOf([small, big]);
  expect(night.map((w) => [w.subject, w.chunks.length])).toEqual([
    ["person:big", 10],
    [ann, 1],
  ]);
  // Someone whose open things need more calls a chunk than a person's share still gets one chunk a night.
  const many = {
    chunks: [
      chunk("2026-01-01T00:00:00.000Z"),
      chunk("2026-01-02T00:00:00.000Z"),
    ],
    open: Array.from({ length: 450 }, () => promise),
    subject: "person:many",
  };
  expect(nightOf([many]).map((w) => w.chunks.length)).toEqual([1]);
});
