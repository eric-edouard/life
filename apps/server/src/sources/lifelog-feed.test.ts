import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { apply, turnsBetween } from "./lifelog";
import { isOwnerSpeech, Page } from "./lifelog-feed";
import {
  conversation,
  lifelogStore,
  pageFixture,
  turnFixture,
} from "./store-fixtures";

test("an inferred owner name is descriptive and grants no owner-word authority", () => {
  const store = lifelogStore();
  const named = turnFixture(
    0,
    "2026-10-14T10:00:00.000Z",
    "owner-person",
    "Owner",
    "c1",
    true
  );
  try {
    for (const source of [
      "inferred",
      "owner",
      "recognized",
      undefined,
    ] as const) {
      const page = Page.parse(
        pageFixture({
          conversations: [conversation("c1")],
          turns: [{ ...named, speaker: { ...named.speaker, source } }],
        })
      );
      const [turn] = page.turns;
      expect(turn).toBeDefined();
      if (!turn) {
        throw new Error("missing test turn");
      }
      expect(isOwnerSpeech(turn.speaker)).toBe(source !== "inferred");
      apply(store, page);
      expect(turnsBetween(store, "c1")[0]).toMatchObject({
        name: "Owner",
        owner: source !== "inferred",
        personId: "owner-person",
      });
    }
  } finally {
    store.db.close();
    rmSync(dirname(store.cursor), { force: true, recursive: true });
  }
});
