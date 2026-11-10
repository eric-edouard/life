import { expect, spyOn, test } from "bun:test";
import { people } from "@lifelog/db/schema";
import { testDb } from "../src/testing";
import { freezeVoiceSnapshot, withFrozenVoiceSnapshot } from "./frozen-voices";

test("unchanged evidence is captured once; replay changes only its disposable copy", () => {
  const env = testDb();
  try {
    env.db.insert(people).values({ id: "guest", name: "Guest" }).run();
    const snapshots: Record<string, string> = {};
    const first = freezeVoiceSnapshot(env.db, snapshots);
    const serialize = spyOn(env.db.$client, "serialize").mockImplementation(
      () => {
        throw new Error("snapshot captured twice");
      }
    );
    try {
      expect(freezeVoiceSnapshot(env.db, snapshots)).toBe(first);
    } finally {
      serialize.mockRestore();
    }
    expect(Object.keys(snapshots)).toHaveLength(1);
    const before = env.db.$client.serialize();
    withFrozenVoiceSnapshot(snapshots, first, (copy) => {
      copy.insert(people).values({ id: "other", name: "Other" }).run();
      expect(copy.select().from(people).all()).toHaveLength(2);
    });
    expect(env.db.$client.serialize()).toEqual(before);
    env.db.insert(people).values({ id: "later", name: "Later" }).run();
    expect(freezeVoiceSnapshot(env.db, snapshots)).not.toBe(first);
    expect(Object.keys(snapshots)).toHaveLength(2);
    expect(() => withFrozenVoiceSnapshot({}, first, () => null)).toThrow(
      "snapshot hash mismatch"
    );
  } finally {
    env.drop();
  }
});
