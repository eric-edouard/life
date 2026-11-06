import { expect, test } from "bun:test";
import { EMBEDDER_MODEL, embedderAt } from "../core/embedder";
import { embedNew, embedQuery, readNearest } from "./vectors";

test("with no embedder, or one down, search says it ranks by words alone", async () => {
  expect(await embedQuery("vitre", null)).toEqual({
    note: "(by words only: no voice source, so no embedder)",
  });
  expect(
    (await embedQuery("vitre", embedderAt("http://127.0.0.1:1"))).note
  ).toStartWith("(by words only: the embedder is down");
});

test("a part the embedder refuses is skipped and said; the older texts are still embedded", async () => {
  const texts = Array.from({ length: 300 }, (_, i) => ({
    at: new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString(),
    text: i === 299 ? "refused text" : `older text ${i}`,
  }));
  const embedder = {
    embed: (part: string[]) =>
      part.includes("refused text")
        ? Promise.reject(new Error("the embedder answered 400"))
        : Promise.resolve(part.map(() => [1, 0])),
    model: EMBEDDER_MODEL,
  };
  await expect(embedNew(embedder, texts)).rejects.toThrow(
    "1 parts not embedded"
  );
  expect(
    readNearest([1, 0], () => [{ id: "a", text: "older text 0" }])
  ).toEqual(["a"]);
});
