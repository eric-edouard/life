import { expect, spyOn, test } from "bun:test";
import type { Embedded, Embedder } from "../core/embedder";
import { MATTER_ICONS, type MatterIconKey } from "../records/matter-icon";
import { ICON_AT, iconNow, lifeIconOf, readLifeIcons } from "./matter-icons";

// Life's pick of a matter's icon, on a made-up embedder: a line is one axis, a matter's text names the key it means
// ("Matter n: key"), a text naming none points nowhere near any.

const KEYS = MATTER_ICONS.map(([key]) => key);
const axis = (i: number) => KEYS.map((_, j) => (i === j ? 1 : 0));
const vectorOf = (text: string, as: Embedded) => {
  const key = as === "passage" ? undefined : text.split(": ")[1];
  const i =
    as === "passage"
      ? MATTER_ICONS.findIndex(([, line]) => line === text)
      : KEYS.indexOf(key as MatterIconKey);
  return i < 0 ? KEYS.map(() => 1) : axis(i);
};

/** A made-up embedder that records its calls; `hold` may delay or fail a call (by its index among calls of its kind). */
function fakeEmbedder(
  hold: (as: Embedded, nth: number) => Promise<void> | void = () => undefined
) {
  const calls: { as: Embedded; texts: string[] }[] = [];
  const embedder: Embedder = {
    embed: async (texts, as) => {
      const nth = calls.filter((c) => c.as === as).length;
      calls.push({ as, texts });
      await hold(as, nth);
      return texts.map((t) => vectorOf(t, as));
    },
    model: "fake",
  };
  const of = (as: Embedded) => calls.filter((c) => c.as === as);
  return { calls, embedder, of };
}

const views = (n: number, key: MatterIconKey = "key", from = 0) =>
  Array.from({ length: n }, (_, i) => ({
    goal: { at: "", by: "life" as const, text: key },
    id: `matter_${String(from + i).padStart(12, "0")}`,
    name: `Matter ${from + i}`,
  }));

test("the nearest line at ICON_AT or above is Life's pick; below, none; the fallback is never picked", () => {
  const lines = [
    ["folder", [1, 0]],
    ["key", [0, 1]],
  ] as const;
  // Exactly at the threshold: picked.
  expect(lifeIconOf([Math.sqrt(1 - ICON_AT ** 2), ICON_AT], lines)).toBe("key");
  expect(lifeIconOf([1, ICON_AT - 0.01], [lines[1]])).toBeNull();
  // Nearest the fallback's line: the next is taken if it is close enough, else none.
  expect(lifeIconOf([1, 0.01], lines)).toBeNull();
});

test("overlapping reads share one line set and embed each distinct text once", async () => {
  const fake = fakeEmbedder();
  const same = views(3);
  const [a, b] = await Promise.all([
    readLifeIcons(same, fake.embedder, 1000),
    readLifeIcons([...same, ...views(1, "gift", 3)], fake.embedder, 1000),
  ]);
  expect([...a.values()]).toEqual(["key", "key", "key"]);
  expect(b.get("matter_000000000003")).toBe("gift");
  expect(fake.of("passage")).toHaveLength(3);
  expect(fake.of("query").flatMap((c) => c.texts)).toHaveLength(4);
  // Settled: no call at all, below-threshold texts included.
  const vague = { id: "matter_vague", name: "Things" };
  expect((await readLifeIcons([vague], fake.embedder, 1000)).size).toBe(0);
  const before = fake.calls.length;
  await readLifeIcons([...same, vague], fake.embedder, 1000);
  expect(fake.calls).toHaveLength(before);
});

test("a failed line batch keeps the batches before it: the next read goes on from the first missing line", async () => {
  let failed = false;
  const fake = fakeEmbedder((as, nth) => {
    if (as === "passage" && nth === 1 && !failed) {
      failed = true;
      throw new Error("the embedder is down");
    }
  });
  expect((await readLifeIcons(views(2), fake.embedder, 1000)).size).toBe(0);
  expect((await readLifeIcons(views(2), fake.embedder, 1000)).size).toBe(2);
  const lines = fake.of("passage").map((c) => c.texts[0]);
  expect(lines).toEqual([
    MATTER_ICONS[0][1],
    MATTER_ICONS[32][1],
    MATTER_ICONS[32][1],
    MATTER_ICONS[64][1],
  ]);
});

test("each query batch shows as it lands; a batch past the deadline that fails is asked again with the batches after it, one that lands shows next read", async () => {
  const { promise: release, resolve } = Promise.withResolvers<void>();
  const fake = fakeEmbedder(async (as, nth) => {
    if (as === "query" && nth === 1) {
      await release;
      throw new Error("the embedder is down");
    }
  });
  // Three batches: 32, 32, 5.
  const all = views(69);
  const first = await readLifeIcons(all, fake.embedder, 20);
  expect(first.size).toBe(32);
  resolve();
  await Bun.sleep(5);
  // The second failed: it and the third, never begun, are asked again; the first is kept.
  const queried = fake.of("query").length;
  const second = await readLifeIcons(all, fake.embedder, 1000);
  expect(second.size).toBe(69);
  expect(
    fake
      .of("query")
      .slice(queried)
      .flatMap((c) => c.texts)
  ).toHaveLength(37);

  // A batch past the deadline that lands shows on the next read, with no new call.
  const late = Promise.withResolvers<void>();
  const slow = fakeEmbedder(async (as) => {
    if (as === "query") {
      await late.promise;
    }
  });
  expect((await readLifeIcons(views(2), slow.embedder, 20)).size).toBe(0);
  late.resolve();
  await Bun.sleep(5);
  const calls = slow.calls.length;
  expect((await readLifeIcons(views(2), slow.embedder, 20)).size).toBe(2);
  expect(slow.calls).toHaveLength(calls);
});

test("matters he picked an icon for never reach the embedder, nor its lookup; his pick wins, Life's comes next, else none", async () => {
  const fake = fakeEmbedder();
  const vectors = await import("./vectors");
  const lookup = spyOn(vectors, "embedderNow");
  const [first] = views(1);
  const his = {
    ...(first as NonNullable<typeof first>),
    ownerIcon: "tools" as const,
  };
  expect((await readLifeIcons([his], fake.embedder)).size).toBe(0);
  expect(fake.calls).toHaveLength(0);
  expect((await readLifeIcons([his])).size).toBe(0);
  expect(lookup).not.toHaveBeenCalled();
  lookup.mockRestore();
  const life = new Map([["matter_000000000000", "key" as const]]);
  expect(iconNow(his, life)).toEqual({ by: "owner", key: "tools" });
  expect(iconNow({ id: "matter_000000000000" }, life)).toEqual({
    by: "life",
    key: "key",
  });
  expect(iconNow({ id: "matter_other" }, life)).toBeUndefined();
});
