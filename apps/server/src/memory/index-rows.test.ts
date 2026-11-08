import { expect, test } from "bun:test";
import { withSpans } from "./index-rows";
import { readIndex } from "./ledger";
import { layoutOf, perSection, renderPage } from "./page-format";

test("readIndex takes no async read: the index closes when the read returns", () => {
  // @ts-expect-error a promise would settle after the index is closed (`bun run check` types this file)
  const refused = () => readIndex(async () => 1);
  expect(refused).toBeFunction();
});

test("a Between us line shows the days of its first and latest evidence", () => {
  const text = renderPage({
    hold: "> Ana.",
    layout: layoutOf("person:ana", true),
    meta: {
      built: "2026-10-18T02:00:00.000Z",
      madeBy: { engine: "codex", model: "m", prompt: "p", run: "r" },
      name: "Ana",
      page: "person:ana",
      schemaVersion: 1,
      seen: "r",
    },
    owner: [],
    sections: {
      ...perSection(),
      bond: [
        {
          cites: ["obs_aaaaaaaaaaaa", "obs_bbbbbbbbbbbb"],
          text: "Ana and Jean agreed to keep money apart.",
        },
      ],
    },
    title: "Ana",
  });
  const day: Record<string, string> = {
    obs_aaaaaaaaaaaa: "2026-03-01",
    obs_bbbbbbbbbbbb: "2026-09-12",
  };
  expect(withSpans(text, (id) => (day[id] ? [day[id]] : []))).toContain(
    "agreed to keep money apart. [obs_aaaaaaaaaaaa, obs_bbbbbbbbbbbb] (since 2026-03-01 · last evidence 2026-09-12)"
  );
});
