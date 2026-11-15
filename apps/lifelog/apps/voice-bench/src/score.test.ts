import { expect, test } from "bun:test";
import { draw, lengthOf } from "./sample";
import { blendOf, callsOf, equalErrorOf, type Heard, pointAt } from "./score";
import { parseAnswers, truthOf } from "./truth";

// Made-up voices: each person is an axis; a clip is its person's axis plus a little noise.
const DIM = 8;
let seed = 7;
const random = () => {
  seed = (seed * 16_807) % 2_147_483_647;
  return seed / 2_147_483_647;
};
const unit = (v: number[]) => {
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm);
};
const voice = (axis: number | null, noise: number) =>
  unit(
    Array.from(
      { length: DIM },
      (_, i) => (i === axis ? 1 : 0) + noise * (random() - 0.5)
    )
  );

function heard(noise: number, blind = false): Heard[] {
  return Array.from({ length: 240 }, (_, n) => {
    const person = n % 4;
    // The fourth voice is nobody he knows, pointing somewhere else each time.
    const known = person < 3;
    return {
      conversationId: `conversation-${n % 12}`,
      id: `turn-${n}`,
      jobId: `job-${n % 12}`,
      seconds: 4,
      truth: known
        ? { kind: "person", personId: `person-${person}` }
        : { kind: "unknown" },
      vector: voice(blind || !known ? null : person, blind ? 2 : noise),
    };
  });
}

test("a model that separates the voices names them all at 1% wrong; a blind one names almost none", () => {
  const clear = heard(0.2);
  const calls = callsOf(clear, clear);
  expect(pointAt(calls, 0.01).namedRight).toBe(1);
  expect(equalErrorOf(calls)).toBeLessThan(0.02);
  const blind = heard(0, true);
  expect(pointAt(callsOf(blind, blind), 0.01).namedRight).toBeLessThan(0.1);
});

test("a turn is never judged against its own conversation's evidence", () => {
  const alone: Heard[] = [
    {
      conversationId: "only",
      id: "a",
      jobId: "job",
      seconds: 4,
      truth: { kind: "person", personId: "person" },
      vector: voice(0, 0),
    },
  ];
  expect(callsOf(alone, alone)[0]?.best).toBeNull();
});

test("a blend of two noisy models that err apart names more voices than either", () => {
  const [one, two] = [heard(1.6), heard(1.6)].map((h) => callsOf(h, h));
  const blend = blendOf([one ?? [], two ?? []]);
  expect(blend).toHaveLength(240);
  const named = (calls: typeof blend) => pointAt(calls, 0.01).namedRight;
  expect(named(blend)).toBeGreaterThan(
    Math.max(named(one ?? []), named(two ?? []))
  );
});

test("the bench's answer wins over the archive's, a skip does not, media and several people leave the scoring", () => {
  const archive = { personId: "ada", status: "person" };
  const answers = parseAnswers(
    [
      { at: "1", id: "t", kind: "person", personId: "grace" },
      { at: "2", id: "t", kind: "several" },
      { at: "1", id: "u", kind: "skipped" },
    ]
      .map((a) => JSON.stringify(a))
      .join("\n")
  );
  expect(truthOf(answers.get("t"), archive)).toEqual({ kind: "excluded" });
  expect(truthOf(answers.get("u"), archive)).toEqual({
    kind: "person",
    personId: "ada",
  });
  expect(truthOf(undefined, { personId: null, status: "unknown" })).toEqual({
    kind: "unknown",
  });
  expect(truthOf(undefined, { personId: null, status: "media" })).toEqual({
    kind: "excluded",
  });
  expect(truthOf(undefined, undefined)).toBeUndefined();
});

test("the draw is the same for a seed, and takes at most three turns of a voice", () => {
  const rows = Array.from({ length: 60 }, (_, n) => ({
    conversationId: "c",
    durationSeconds: 2,
    id: `turn-${n}`,
    jobId: `job-${n % 5}`,
    speakerLabel: "speaker_0",
    turnIndex: n,
  }));
  const drawn = draw(rows, 40, "1");
  expect(drawn).toEqual(draw(rows, 40, "1"));
  expect(drawn).not.toEqual(draw(rows, 40, "2"));
  expect(drawn).toHaveLength(15);
  expect([1, 3, 6, 20].map(lengthOf)).toEqual([
    "under 3 s",
    "3 to 6 s",
    "6 to 15 s",
    "over 15 s",
  ]);
});
