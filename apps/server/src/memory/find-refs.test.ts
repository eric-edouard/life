import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SourceEvent } from "../records/source";
import { readArchivedMessageAt } from "../sources/archived";
import type { Descriptor } from "../sources/contract";
import { githubCopier, readGithub } from "../sources/github";
import { apply } from "../sources/lifelog";
import {
  conversation,
  lifelogStore,
  pageFixture,
  turnFixture,
} from "../sources/store-fixtures";
import { DECISIONS } from "./decision-lines";
import { requestDecision } from "./decisions";
import {
  findMessageIn,
  findRef,
  readsOnce,
  type SharedReads,
} from "./find-refs";
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
  // A part an add-on supplies, or a conversation summary, may not be there to open: never a link.
  expect(await found("person:test-ana/persona")).toContain("persona");
  expect(
    await found("person:test-ana/conversation/job-1:0@2026-10-14T10:00:00.000Z")
  ).toContain("conversation");
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
  // He turned WhatsApp on, and Notes, whose store finds no message by id; Messages is off.
  spyOn(sources, "enabledSources").mockReturnValue([
    {
      kind: "chat",
      label: "WhatsApp",
      messageAt: (m: string) =>
        m === id ? { first: event.at, last: event.at } : undefined,
      name: "whatsapp",
      read,
    },
    { kind: "own_writing", label: "Notes", name: "notes", read: () => [] },
  ] as unknown as Descriptor[]);
  expect(await found(`msg:whatsapp|${id}`)).toBe(true);
  expect(await found("msg:whatsapp|whatsapp:120@g.us/S9")).toBe(
    "no WhatsApp message whatsapp:120@g.us/S9"
  );
  expect(await found("msg:notes|notes:1")).toBe(
    "notes is off or holds no messages"
  );
  expect(await found("msg:imessage|imessage:G1")).toBe(
    "imessage is off or holds no messages"
  );
  expect(
    await openById(`msg:whatsapp|${id}`, undefined, undefined, () =>
      Promise.resolve("")
    )
  ).toContain("+66600000001: The boiler is fixed");
  // Shown as every chat reader shows it: a secret line redacted.
  event.text = "The boiler is fixed\nthe door code secret is 4471";
  const shown = await openById(`msg:whatsapp|${id}`, undefined, undefined, () =>
    Promise.resolve("")
  );
  expect(shown).toContain("[line removed: looked like a secret]");
  expect(shown).not.toContain("4471");
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
  // A QR's message ref must open too; one that opens is kept for his card's source chip.
  const qr = (ref: string) => ({
    ...ask("Reef sent the code."),
    needs: [{ kind: "qr", ref, source: "Reef's WhatsApp of Tue" }],
  });
  await expect(
    requestDecision("planner", qr("unit_0000000000ff"), now)
  ).rejects.toThrow("the qr need's `ref` unit_0000000000ff opens nothing");
  expect(
    (await requestDecision("planner", qr("ask/draft"), now)).id
  ).toStartWith("dec_");
  rmSync(DECISIONS, { force: true });
});

test("a GitHub comment is found by its id at its instant, which its archive keeps without milliseconds", async () => {
  const archive = mkdtempSync(join(tmpdir(), "github-"));
  const comment = {
    body: "me too",
    created_at: "2026-11-18T09:00:00Z",
    html_url: "https://github.com/o/r/issues/1#issuecomment-31",
    id: 31,
    issue_url: "https://api.github.com/repos/o/r/issues/1",
    updated_at: "2026-11-18T09:00:00Z",
    user: { login: "Bob" },
  };
  const run = (cmd: string[]) =>
    Promise.resolve({
      code: 0,
      killed: null,
      stderr: "",
      stdout:
        cmd[2] === "user"
          ? "ana\n"
          : JSON.stringify(
              cmd[2]?.startsWith("repos/o/r/issues/comments") ? [comment] : []
            ),
    });
  const repos = () => ["o/r"];
  await githubCopier({ archive, repos, run: run as never })();
  const github = {
    kind: "chat" as const,
    label: "GitHub",
    messageAt: (id: string) => readArchivedMessageAt("github", id, archive),
    read: (since: Date, before?: Date) =>
      readGithub(since, archive, before, repos),
  };
  const [sent] = readGithub(new Date(0), archive, undefined, repos);
  const comment31 = findMessageIn(github, sent?.id ?? "none");
  expect(comment31.found && comment31.event?.text).toContain("me too");
  expect(findMessageIn(github, `${sent?.id}9`).found).toBe(false);
});
