import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { rmSync } from "node:fs";
import type { SourceEvent } from "../records/source";
import type { Descriptor } from "../sources/contract";
import { apply } from "../sources/lifelog";
import {
  conversation,
  lifelogStore,
  pageFixture,
  turnFixture,
} from "../sources/store-fixtures";
import { DECISIONS, requestDecision } from "./decisions";
import { findRef, readsOnce, type SharedReads } from "./find-refs";
// biome-ignore lint/performance/noNamespaceImport: a test spies on its functions
import * as memoryFiles from "./memory-files";
import { openById } from "./open-by-id";
import { unit } from "./record-fixtures";
import { parseRef, type Ref } from "./refs";
// biome-ignore lint/performance/noNamespaceImport: a test spies on its functions
import * as sources from "./sources";

afterEach(() => mock.restore());

const MATTER = "matter_aaaaaaaaaaaa";
const LONE = "obs_bbbbbbbbbbbb";
const OBS = "obs_cccccccccccc";
const reads: SharedReads = {
  book: () =>
    Promise.resolve([{ id: MATTER }, { id: LONE }] as Awaited<
      ReturnType<SharedReads["book"]>
    >),
  people: readsOnce().people,
};
const open = () => {
  const store = lifelogStore();
  apply(
    store,
    pageFixture({
      conversations: [conversation("c1")],
      turns: [turnFixture(0, "2026-10-14T10:00:00.000Z", null, null)],
    })
  );
  return store;
};
/** Whether `id` names something that exists, or why not. */
const found = async (id: string) => {
  const f = await findRef(parseRef(id) as Ref, reads, open);
  return f.found ? true : f.why;
};

test("each kind: a live ref is found, a dead one says why", async () => {
  expect(await found("ask/draft")).toBe(true);
  expect(await found("ask/nope")).toContain("no page ask/nope");
  expect(await found("person:test-ana/now")).toBe(true);
  expect(await found("person:test-nobody/now")).toBe(
    "no one is person:test-nobody"
  );
  expect(await found("project:garden/now")).toContain("no read parts");
  expect(await found(MATTER)).toBe(true);
  expect(await found("matter_dddddddddddd")).toBe(
    "no matter matter_dddddddddddd"
  );
  // A lone observation's matter has its id: found as the matter.
  expect(await found(LONE)).toBe(true);
  expect(await found("job-1:0@2026-10-14T10:00:00.000Z")).toBe(true);
  expect(await found("job-9:0@2026-10-14T10:00:00.000Z")).toContain(
    "no turn job-9"
  );
  expect(await found("c1")).toBe(true);
  expect(await found("c9")).toBe("no conversation c9");
});

test("an observation by its index row, a unit, a file's line", async () => {
  spyOn(memoryFiles, "readIndex").mockImplementation(((
    read: (db: unknown) => unknown
  ) =>
    read({
      query: () => ({
        get: (id: string) =>
          id === OBS ? { date: "2026-10-14", id, text: "Kit fixed it" } : null,
      }),
    })) as typeof memoryFiles.readIndex);
  spyOn(memoryFiles, "readUnit").mockImplementation((id) =>
    Promise.resolve(id === "unit_000000000001" ? unit() : undefined)
  );
  spyOn(memoryFiles, "readFiles").mockReturnValue(
    new Map([
      [
        "whatsapp:120@g.us/S1",
        {
          description: "A boiler's label",
          hash: "0123456789abcdef",
          ref: "whatsapp:120@g.us/S1",
          schemaVersion: 1 as const,
        },
      ],
    ])
  );
  expect(await found(OBS)).toBe(true);
  expect(await found("obs_eeeeeeeeeeee")).toBe(
    "no observation obs_eeeeeeeeeeee"
  );
  expect(await found("unit_000000000001")).toBe(true);
  expect(await found("unit_000000000002")).toBe("no unit unit_000000000002");
  expect(await found("file:whatsapp:120@g.us/S1")).toBe(true);
  expect(await found("file:whatsapp:120@g.us/S2")).toBe(
    "no file whatsapp:120@g.us/S2"
  );
});

test("a message by its id, whatever its age; a source that can't find one says so", async () => {
  const id = "whatsapp:120@g.us/S1#2";
  const event = {
    at: "2020-01-02T03:04:05.000Z",
    chat: "120@g.us",
    fromMe: false,
    id,
    sender: "+66600000001",
    source: "whatsapp",
    text: "The boiler is fixed",
  } as SourceEvent;
  const read = mock((since: Date) =>
    since.toISOString() === event.at ? [event] : []
  );
  const real = sources.sourceOf;
  spyOn(sources, "sourceOf").mockImplementation((name) =>
    name === "whatsapp"
      ? ({
          kind: "chat",
          label: "WhatsApp",
          messageAt: (m: string) =>
            m === id ? { first: event.at, last: event.at } : undefined,
          read,
        } as unknown as Descriptor)
      : real(name)
  );
  expect(await found(`msg:whatsapp|${id}`)).toBe(true);
  expect(await found("msg:whatsapp|whatsapp:120@g.us/S9")).toBe(
    "no WhatsApp message whatsapp:120@g.us/S9"
  );
  expect(await found("msg:notes|notes:1")).toContain(
    "message by its id: link its unit"
  );
  expect(
    await openById(`msg:whatsapp|${id}`, undefined, undefined, () =>
      Promise.resolve("")
    )
  ).toContain("+66600000001: The boiler is fixed");
});

test("fetch prints a miss as before", async () => {
  const none = () => Promise.resolve("");
  expect(
    await openById("unit_000000000000", undefined, undefined, none)
  ).toContain("(no unit unit_000000000000)");
  expect(await openById("ask/nope", undefined, undefined, none)).toContain(
    "(no page ask/nope: ask/draft"
  );
});

test("a card's context is required Markdown, at most 20,000 characters, and its life: links must open", async () => {
  rmSync(DECISIONS, { force: true });
  const now = new Date("2026-11-18T09:00:00.000Z");
  const ask = (context: string) => ({
    context,
    deadline: "2026-11-20T09:00:00.000Z",
    onSilence: null,
    options: [
      { id: "yes", label: "Book Kit" },
      { id: "wait", label: "Wait" },
    ],
    question: "Book Kit to fix the boiler?",
    title: "Fix the boiler",
  });
  await expect(requestDecision("planner", ask("  "), now)).rejects.toThrow(
    "`context` is required"
  );
  await expect(
    requestDecision("planner", ask("x".repeat(20_001)), now)
  ).rejects.toThrow("20000");
  await expect(
    requestDecision(
      "planner",
      ask("Kit's [quote](life:unit_0000000000ff)."),
      now
    )
  ).rejects.toThrow("the link life:unit_0000000000ff opens nothing (no unit");
  // A link inside code is not checked; a live one passes.
  const asked = await requestDecision(
    "planner",
    ask(
      "See [how a draft is asked](life:ask/draft).\n```\n[no](life:unit_0000000000ff)\n```"
    ),
    now
  );
  expect(asked.id).toStartWith("dec_");
  rmSync(DECISIONS, { force: true });
});
