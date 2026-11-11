import { expect, test } from "bun:test";
import type { SourceEvent } from "../records/source";
import { writePassages } from "./passages";
import { chatHits, chatsOf, mailHits } from "./words";

const event = (
  id: string,
  at: string,
  source: SourceEvent["source"] = "line"
): SourceEvent => ({
  at,
  chat: source === "claude" ? "claude:old-room" : "old-room",
  chatName: "Old room",
  fromMe: true,
  id,
  sender: "owner",
  source,
  text: "The ancient cobalt plan",
});

test("stored ancient chats and pruned assistant writing remain searchable without any source scan", async () => {
  const all = [
    event("a", "2001-02-01T12:00:00.000Z"),
    event("b", "2001-02-02T12:00:00.000Z", "claude"),
  ];
  writePassages(all, { from: "2001-02-01", to: "2001-02-02" }, [], {
    claude: () => [],
    line: () => [],
  });
  const hits = (await chatHits("ancient cobalt")).join("\n");
  expect(hits).toContain("(line, chat old-room)");
  expect(hits).toContain("(claude, fetch claude:old-room)");
  expect(
    (await chatHits("cobalt", { from: "2002-01-01" })).join("\n")
  ).not.toContain("ancient cobalt");
});

test("stored ancient mail retains its owning thread-day fetch id", async () => {
  writePassages(
    [
      {
        ...event("mail:a", "2001-03-01T12:00:00.000Z", "mail"),
        text: "Old room\nThe ancient cobalt plan",
      },
    ],
    { from: "2001-03-01", to: "2001-03-01" },
    [],
    { mail: () => [] }
  );
  const hits = await mailHits("ancient cobalt");
  expect(hits).toHaveLength(1);
  expect(hits[0]).toStartWith("- unit_");
  expect(hits[0]).toContain("ancient cobalt");
});

test("who reads ancient source history and before pagination sends an exclusive storage end", async () => {
  const all = [
    event("a", "2001-02-01T12:00:00.000Z"),
    event("b", "2001-02-02T12:00:00.000Z"),
  ];
  const bounds: { from: string; to: string | undefined }[] = [];
  const read = (from: Date, to?: Date) => {
    bounds.push({ from: from.toISOString(), to: to?.toISOString() });
    return all.filter(
      (e) => e.at >= from.toISOString() && (!to || e.at < to.toISOString())
    );
  };
  const found = await chatsOf(
    { before: "2001-02-02T12:00:00.000Z", who: "Old room" },
    { line: read }
  );
  expect(found).toContain("2001-02-01");
  expect(bounds[0]).toEqual({
    from: "1970-01-01T00:00:00.000Z",
    to: "2001-02-02T12:00:00.000Z",
  });
  expect(found).not.toContain("2001-02-02 13:00");
});
