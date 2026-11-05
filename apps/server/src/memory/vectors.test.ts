import { expect, test } from "bun:test";
import { setSettings } from "../core/settings";
import { embedQuery } from "./vectors";

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
