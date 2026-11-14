import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readReplies } from "@life/server/src/memory/exchange-reads";
import { convertAll } from "./pilot-convert";

const WORDING = "a".repeat(16);
const old = (over: Record<string, unknown> = {}) => ({
  // The old files held the candidates a trial offered: left behind.
  candidates: ["person:x"],
  madeBy: {
    engine: "codex",
    model: "m",
    prompt: "memory-mentions.v1",
    run: "2026-10-05T10-00-00.000Z",
  },
  messages: ["whatsapp|+1:0", "whatsapp|+1:1"],
  reply: { exchanges: [{ exchange: 0, moves: [] }] },
  starts: [0],
  wording: WORDING,
  ...over,
});

test("an earlier folder becomes a folder named by label and digest, one stored line a file, left alone when it exists; a bad file is counted", () => {
  const root = mkdtempSync(join(tmpdir(), "convert-"));
  const put = (read: string, label: string, name: string, body: unknown) => {
    mkdirSync(join(root, read, label), { recursive: true });
    writeFileSync(join(root, read, label, name), JSON.stringify(body));
  };
  try {
    put("mentions", "set", "a.json", old());
    put("mentions", "set", "b.json", old({ messages: ["whatsapp|+1:5"] }));
    put("mentions", "set", "c.json", { nope: true });
    put("connection", "set", "d.json", old());
    const atOf = (key: string) =>
      key === "whatsapp|+1:0" ? "2026-09-30T12:00:00.000Z" : undefined;
    const counts = convertAll(root, atOf);
    expect(Object.fromEntries(counts)).toEqual({
      [`connection set ${WORDING} converted`]: 1,
      [`mentions set ${WORDING} converted`]: 2,
      "mentions set invalid": 1,
    });
    const lines = readReplies(join(root, "mentions", `set-${WORDING}`)).flat();
    expect(lines).toHaveLength(2);
    const first = lines.find((l) => l.messages[0] === "whatsapp|+1:0");
    expect(first).toMatchObject({
      at: "2026-10-05T10:00:00.000Z",
      promptDigest: WORDING,
      read: "mentions",
      schemaVersion: 1,
    });
    expect(first).not.toHaveProperty("candidates");
    expect(first).not.toHaveProperty("wording");
    // A second pass finds the folders and changes nothing.
    expect(Object.fromEntries(convertAll(root, atOf))).toEqual({
      [`connection set ${WORDING} left alone`]: 1,
      [`mentions set ${WORDING} left alone`]: 2,
      "mentions set invalid": 1,
    });
    expect(
      readReplies(join(root, "mentions", `set-${WORDING}`)).flat()
    ).toHaveLength(2);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
