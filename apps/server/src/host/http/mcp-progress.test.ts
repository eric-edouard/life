import { expect, spyOn, test } from "bun:test";
import { rmSync } from "node:fs";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { DAY } from "../../core/clock";
import {
  DECISIONS,
  decisionsNow,
  requestDecision,
} from "../../memory/decisions";
import { buildServer } from "./mcp";

// `report` (`mcp-tool.ts`) relies on the SDK upgrading to SSE when a handler notifies; only 2026-07-28 exists.

const META = {
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "phone", version: "1" },
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
};

test("answer_check streams its plan and steps on a progress token, and a repeat of the tap (its answer key) writes nothing", async () => {
  rmSync(DECISIONS, { force: true });
  const { id } = await requestDecision("planner", {
    deadline: new Date(Date.now() + 2 * DAY).toISOString(),
    options: [
      { id: "yes", label: "Book Kit" },
      { id: "wait", label: "Wait" },
    ],
    question: "Book Kit?",
    title: "Boiler",
  });
  const listed = spyOn(
    await import("../../memory/checks"),
    "checksNow"
  ).mockImplementation(async () =>
    decisionsNow()
      .filter((d) => d.state === "open")
      .map(
        (d) =>
          ({
            about: [],
            deadline: d.deadline,
            group: "decision",
            ref: d.id,
          }) as never
      )
  );
  const handler = createMcpHandler(() => buildServer());
  const call = async (meta: object) => {
    const res = await handler.fetch(
      new Request("https://life.example.test/mcp", {
        body: JSON.stringify({
          id: 1,
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            _meta: { ...META, ...meta },
            arguments: { options: ["yes"], ref: id },
            name: "answer_check",
          },
        }),
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          "mcp-method": "tools/call",
          "mcp-name": "answer_check",
          "mcp-protocol-version": "2026-07-28",
        },
        method: "POST",
      })
    );
    const body = await res.text();
    const events = body.startsWith("{")
      ? [JSON.parse(body)]
      : body
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => JSON.parse(l.slice(5)));
    return events;
  };
  try {
    const events = await call({
      "life/answerKey": "tap-1",
      progressToken: "p1",
    });
    const progress = events.filter(
      (e) => e.method === "notifications/progress"
    );
    expect(progress.map((e) => e.params.progress)).toEqual([1, 2, 3, 4]);
    const messages = progress.map((e) => JSON.parse(e.params.message));
    expect(messages[0].plan).toEqual(["recorded", "asker_told", "left_inbox"]);
    expect(messages.slice(1).map((m) => m.step)).toEqual([
      "recorded",
      "asker_told",
      "left_inbox",
    ]);
    const result = JSON.parse(events.at(-1).result.content[0].text);
    expect(result).toMatchObject({
      changed: { state: "answered" },
      kind: "decision",
      send: null,
    });
    // The same tap again, with no token: one JSON body, the same answer line, nothing new written.
    const repeat = await call({ "life/answerKey": "tap-1" });
    expect(repeat).toHaveLength(1);
    expect(JSON.parse(repeat[0].result.content[0].text).done).toEqual(
      result.done
    );
    expect(decisionsNow()[0]?.answer?.answerKey).toBe("tap-1");
  } finally {
    listed.mockRestore();
    rmSync(DECISIONS, { force: true });
  }
});
