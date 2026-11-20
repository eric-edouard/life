import { afterEach, expect, setSystemTime, test } from "bun:test";
import { clock, HOUR, MIN } from "../core/clock";
import { appendJsonl } from "../core/files";
import { FILES } from "../memory/memory-files";
import type { SourceEvent } from "../records/source";
import { FileEntry } from "../records/unit";
import { register, setWait } from "./agent-actions";
import { pollMessages, readPeopleOnce, wakeDue } from "./desk-clock";
import { advance, ahead, chatSource, on, setup } from "./test-desk";

// An agent's wait may test a message's words (`text_matches`): a wake by a sender nobody knows, handing no text.

afterEach(() => {
  setSystemTime();
});

const FILTER = { channels: ["whatsapp"], text_matches: "zort" };

/** An agent after its first turn, and `arrive`: texts from Test Stranger that reach the chat after the desk's first poll. */
async function waitingOnWords() {
  const s = setup();
  const list: SourceEvent[] = [];
  s.desk.sources = [chatSource(list)];
  const id = register(s.desk, {
    brief: "Test brief: wait for an invitation",
    folder: s.dir,
    runtime: "fake",
  });
  await wakeDue(s.desk);
  const set = await setWait(s.desk, on(s.desk, id), {
    events: [FILTER],
    reason: "an invitation",
    until: ahead(HOUR),
  });
  await s.end(id);
  await pollMessages(s.desk, readPeopleOnce());
  const arrive = async (...texts: (string | SourceEvent["files"])[]) => {
    advance(MIN);
    for (const said of texts) {
      const text = typeof said === "string" ? said : "";
      const files = typeof said === "string" ? undefined : said;
      list.push({
        ...(files ? { files } : {}),
        at: clock().toISOString(),
        chat: "Test Stranger",
        fromMe: false,
        id: `whatsapp:w${list.length + 1}`,
        sender: "Test Stranger",
        source: "whatsapp",
        text,
      });
    }
    advance(10 * MIN);
    await pollMessages(s.desk, readPeopleOnce());
    await wakeDue(s.desk);
  };
  return { ...s, arrive, id, set };
}

test("a wait on words is woken by an unknown sender's matching message, any case, and hands no text", async () => {
  const { arrive, desk, id, set, turns } = await waitingOnWords();
  expect(set).not.toHaveProperty("error");
  await arrive("lunch?", "Welcome to ZORT");
  expect(turns(id).at(-1)).toEqual({ cause: "event", outcome: null });
  const queued = desk.db
    .query<{ event_id: string; payload: string }, []>(
      "select event_id, payload from event"
    )
    .all();
  expect(queued.map((r) => r.event_id)).toEqual(["whatsapp:w2"]);
  // Facts only: the payload's keys are a message's facts, with no text under any name.
  expect(Object.keys(JSON.parse(queued[0]?.payload ?? "{}")).sort()).toEqual([
    "at",
    "chat",

    "id",
    "person",
    "source",
  ]);
});

test("a voice note's words wake a wait on words, as every reader sees them", async () => {
  const { arrive, desk } = await waitingOnWords();
  const ref = "whatsapp:voice-test";
  appendJsonl(FILES, FileEntry, [
    {
      hash: "0123456789abcdef",
      ref,
      schemaVersion: 1,
      text: "the Zort invoice",
    },
  ]);
  await arrive([
    { mime: "audio/ogg", name: "PTT.opus", path: "/nowhere/PTT.opus", ref },
  ]);
  const queued = desk.db
    .query<{ event_id: string }, []>("select event_id from event")
    .all();
  expect(queued.map((r) => r.event_id)).toEqual(["whatsapp:w1"]);
});

test("a wait refuses a pattern that does not compile or is over 200 characters", async () => {
  const { desk, id } = await waitingOnWords();
  const refused = ["(", "a".repeat(201)].map((text_matches) =>
    setWait(desk, on(desk, id), {
      events: [{ text_matches }],
      reason: "r",
      until: ahead(HOUR),
    })
  );
  for (const r of await Promise.all(refused)) {
    expect(r).toHaveProperty("error");
  }
});

test("a stored filter without the key still matches every message of its chat", async () => {
  const { arrive, desk, id, turns } = await waitingOnWords();
  await setWait(desk, on(desk, id), {
    events: [{ channels: ["whatsapp"] }],
    reason: "anything",
    until: ahead(HOUR),
  });
  await arrive("lunch?");
  expect(turns(id).at(-1)?.cause).toBe("event");
});
