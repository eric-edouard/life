import { expect, spyOn, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildIndex } from "../../memory/index-writer";
import { INDEX, UNITS } from "../../memory/memory-files";
import { unit as unitFixture } from "../../memory/record-fixtures";
// biome-ignore lint/performance/noNamespaceImport: a test spies on its functions
import * as sources from "../../memory/sources";
import type { SourceEvent } from "../../records/source";
import { rpc, token } from "./mcp-test-harness";
import { expectWire } from "./wire-fixture";

// The People tab's reads and its pictures, as real answers (`wire-fixture.ts`).

const GRAN_PICTURE = "00000000000000000000000000000a02";

test("people's pictures go to any app he paired, never to a paired agent", async () => {
  const { json } = await rpc(await token(), "tools/call", {
    arguments: { ids: [GRAN_PICTURE] },
    name: "read_person_pictures",
  });
  expect(json.result.isError).toBe(true);
  expect(json.result.content[0].text).toContain("paired as an agent");
});

test("the People tab's reads: read_people_and_organizations' list, a person's and an organization's now, and latest answer as data", async () => {
  // Test Ana's one 1:1 WhatsApp chat-day (made-up), indexed, its messages read from the source's span.
  const chat = "33600000004@s.whatsapp.net";
  const chatDay = unitFixture({
    date: "2026-11-17",
    end: "2026-11-17T09:20:00.000Z",
    id: "unit_00000000000a",
    key: chat,
    people: ["person:test-ana", "person:me"],
    source: "whatsapp",
    start: "2026-11-17T09:14:00.000Z",
    title: "Ana B",
  });
  const said = (at: string, fromMe: boolean, text: string): SourceEvent => ({
    at,
    chat,
    chatName: "Ana B",
    fromMe,
    id: `whatsapp:${chat}/${at}`,
    sender: fromMe ? "me" : "Test Ana",
    source: "whatsapp",
    text,
  });
  const real = sources.sourceOf;
  const spy = spyOn(sources, "sourceOf").mockImplementation(
    (name) =>
      ({
        ...real(name),
        read: () => [
          said("2026-11-17T09:14:00.000Z", false, "Bread for Sunday?"),
          said("2026-11-17T09:20:00.000Z", true, "Two loaves, thanks"),
        ],
      }) as never
  );
  mkdirSync(UNITS, { recursive: true });
  mkdirSync(dirname(INDEX), { recursive: true });
  try {
    writeFileSync(
      join(UNITS, `${chatDay.date}.jsonl`),
      `${JSON.stringify(chatDay)}\n`
    );
    buildIndex(
      [],
      INDEX,
      {
        corrections: [],
        live: new Set(),
        retired: new Map(),
        standing: new Map(),
      },
      [{ unit: chatDay }]
    );
    const read = async (args: object) => {
      const { json } = await rpc(
        await token({ agent: undefined, client_id: "phone" }),
        "tools/call",
        { arguments: args, name: "read_people_and_organizations" }
      );
      expect(json.result.isError).toBe(false);
      return json.result.content[0].text as string;
    };
    expectWire("read_people_and_organizations", await read({}));
    expectWire(
      "read_people_and_organizations_query",
      await read({ query: "ana" })
    );
    const ana = await read({ name: "Test Ana" });
    expect(JSON.parse(ana).reach[0]).toMatchObject({
      accounts: [{ handle: "+33600000004", title: "Ana B" }],
      network: "whatsapp",
    });
    expectWire("read_people_and_organizations_now", ana);
    expectWire(
      "read_people_and_organizations_organization",
      await read({ name: "Test Bakery" })
    );
    const latest = await rpc(
      await token({ agent: undefined, client_id: "phone" }),
      "tools/call",
      { arguments: { id: "person:test-ana/latest" }, name: "fetch" }
    );
    expectWire(
      "read_people_and_organizations_latest",
      latest.json.result.content[0].text
    );
  } finally {
    spy.mockRestore();
    rmSync(UNITS, { force: true, recursive: true });
    rmSync(INDEX, { force: true });
  }
});
