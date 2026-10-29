import { expect, test } from "bun:test";
import { costs, fitLogistic, type Row, thaiIn } from "./context";

const word = (start: number, text: string) => ({
  end: start + 0.4,
  start,
  text,
});

test("a turn is Thai by the share of Scribe's words whose middle is in it", () => {
  const words = [word(0, "สวัสดี"), word(1, "ok"), word(2, "ครับ"), word(9, "ไป")];
  expect(thaiIn({ end: 3, start: 0 }, words)).toBe(true);
  expect(thaiIn({ end: 3, start: 0.9 }, [word(1, "ok"), word(2, "yes")])).toBe(
    false
  );
  // The word at 9 has its middle past the turn's end.
  expect(thaiIn({ end: 9.1, start: 5 }, words)).toBeNull();
});

test("costs are in seconds: Thai left local, English or French sent, speech sent", () => {
  const row = (seconds: number, thai: boolean | null): Row => ({
    day: "d",
    features: [],
    home: true,
    job: "j",
    seconds,
    thai,
  });
  expect(
    costs([
      { row: row(3, true), sent: false },
      { row: row(1, true), sent: true },
      { row: row(10, false), sent: true },
      { row: row(30, false), sent: false },
      { row: row(6, null), sent: false },
    ])
  ).toEqual({ missed: "75.0%", sent: "25.0%", toScribe: "22.0%" });
});

test("the fit separates two classes along the feature that tells them apart", () => {
  const xs = Array.from({ length: 200 }, (_, i) => [
    i % 2 === 0 ? 2 : -2,
    (i * 7) % 5,
  ]);
  const ys = xs.map(([a]) => (a ?? 0) > 0);
  const { bias, weights } = fitLogistic(xs, ys);
  expect(weights[0]).toBeGreaterThan(1);
  expect(Math.abs(weights[1] ?? 0)).toBeLessThan(0.5);
  expect(Math.abs(bias)).toBeLessThan(1);
});
