import { afterAll, expect, test } from "bun:test";
import { clock } from "../../core/clock";
import { logEvents, logFileOf } from "../../core/log";
import { forward } from "../../sources/voice-server";
import { voiceServer } from "../../sources/store-fixtures";
import { correct } from "./mcp";

const server = voiceServer({
  "/conversations/c1/title": () => ({ id: "c1" }),
  "/people/p1": () => ({ id: "p1" }),
  "/people/p1/merge": () => ({ id: "p1" }),
});
afterAll(() => server.close());

test("forward sends the four corrections and nothing else", async () => {
  await expect(
    forward("rename_person", { id: "p1", name: "Ana" })
  ).resolves.toEqual({
    id: "p1",
  });
  await expect(forward("title", { id: "c1", title: null })).resolves.toEqual({
    id: "c1",
  });
  await expect(forward("delete_person", { id: "p1" })).rejects.toThrow(
    "not a forwardable correction"
  );
  // Each write is logged by its body's field names, never their values or lifelog's answer.
  const written = logEvents(logFileOf(clock().toISOString()), "lifelog.write")
    .filter((l) => l.path === "/people/p1")
    .slice(-2);
  expect(written).toMatchObject([
    { fields: ["aliases", "name"], phase: "before" },
    { fields: ["aliases", "name"], phase: "after" },
  ]);
  expect(JSON.stringify(written)).not.toContain("Ana");
});

test("correct names what is missing and sends a merge as lifelog takes it", async () => {
  await expect(correct({ kind: "title" })).rejects.toThrow(
    "title needs: id, title"
  );
  await expect(
    correct({ jobId: "j1", kind: "speaker", label: "speaker_0" })
  ).rejects.toThrow("speaker needs: to or newName");
  server.seen.length = 0;
  expect(
    await correct({ id: "p1", kind: "merge_people", personId: "p2" })
  ).toBe("Done: merge_people.");
  expect(server.seen.at(-1)).toMatchObject({
    body: { personId: "p2" },
    path: "/people/p1/merge",
  });
});
