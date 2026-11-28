import { expect, test } from "bun:test";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OWNER_DATA_DIR } from "../core/paths";
import { apply, type Stay } from "../sources/voice-server";
import {
  conversation,
  voiceStore,
  pageFixture,
  turnFixture,
} from "../sources/store-fixtures";
import { placesOf } from "./places";

test("places: a conversation's label names who spoke as the directory does, not as lifelog heard", async () => {
  const file = join(OWNER_DATA_DIR, "truth", "people.yaml");
  const before = readFileSync(file, "utf8");
  appendFileSync(
    file,
    "  - id: test-bea\n    name: Test Bea\n    handles: { lifelog: 00000000-0000-8000-8000-0000000000b1 }\n"
  );
  try {
    const open = () => {
      const store = voiceStore();
      apply(
        store,
        pageFixture({
          conversations: [conversation("c1")],
          turns: [
            turnFixture(
              0,
              "2026-10-14T10:00:00.000Z",
              "00000000-0000-8000-8000-0000000000b1",
              "Bea Heard"
            ),
          ],
        })
      );
      return store;
    };
    const stay: Stay = {
      arrivedAt: "2026-10-14T09:50:00.000Z",
      latitude: 1,
      leftAt: "2026-10-14T10:30:00.000Z",
      longitude: 2,
    };
    const read = {
      visits: () => Promise.resolve([stay]),
      where: () => Promise.resolve([]),
    };
    const answer = await placesOf({ place: "x" }, read, open);
    expect(answer).toContain("with Test Bea");
    expect(answer).not.toContain("Bea Heard");
  } finally {
    writeFileSync(file, before);
  }
});
