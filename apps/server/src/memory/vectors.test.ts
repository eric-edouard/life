import { expect, test } from "bun:test";
import { EMBEDDER_MODEL } from "../core/embedder";
import { setSettings } from "../core/settings";
import { embedNew, embedQuery, readNearest } from "./vectors";

test("with no embedder set, or one down, search says it ranks by words alone; only a loopback one is taken", async () => {
  expect(await embedQuery("vitre")).toEqual({
    note: "(by words only: no embedder set)",
  });
  expect(() =>
    setSettings({ embedder: { url: "https://example.com" } })
  ).toThrow();
  setSettings({ embedder: { url: "http://127.0.0.1:1" } });
  try {
    expect((await embedQuery("vitre")).note).toStartWith(
      "(by words only: the embedder is down"
    );
  } finally {
    setSettings({ embedder: null });
  }
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
