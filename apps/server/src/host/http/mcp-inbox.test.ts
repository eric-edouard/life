import { expect, spyOn, test } from "bun:test";
import { clock } from "../../core/clock";
import { versionOf } from "../inbox";
import { rpc, token } from "./mcp-test-harness";

// `read_inbox` over made-up checks: its counts, its pages, its version and a push's one card.

test("read_inbox: every open ask; counts by group, those that block, those due by the end of his day and the total", async () => {
  const checks = await import("../../memory/checks");
  const check = (
    ref: string,
    group: string,
    deadline: string | null = null
  ) => ({
    deadline,
    group,
    kind: group === "decision" ? "decision" : "person",
    likelyPeople: [],
    ref,
  });
  const now = clock().toISOString();
  const spy = spyOn(checks, "checksAndKeyNow").mockResolvedValue({
    checks: [
      check("a", "decision", now),
      check("b", "guessed person"),
      check("c", "decision", "2099-01-01T09:00:00.000Z"),
    ],
    key: "three checks",
  } as never);
  const read = async (arguments_: object) =>
    (
      await rpc(await token(), "tools/call", {
        arguments: arguments_,
        name: "read_inbox",
      })
    ).json.result;
  try {
    const first = JSON.parse((await read({ limit: 2 })).content[0].text);
    expect(first).toEqual({
      blocking: 2,
      checks: [check("a", "decision", now), check("b", "guessed person")],
      counts: { decision: 2, "guessed person": 1 },
      deadlinesToday: 1,
      total: 3,
      version: versionOf("three checks"),
    });
    // The next page, after the last card shown; one that left the inbox is refused (read from the start).
    const next = JSON.parse((await read({ after: "b" })).content[0].text);
    expect(next.checks).toEqual([
      check("c", "decision", "2099-01-01T09:00:00.000Z"),
    ]);
    expect((await read({ after: "gone" })).isError).toBe(true);
    // Nothing changed since his version: only that; another version: the inbox.
    expect(
      JSON.parse((await read({ ifNot: first.version })).content[0].text)
    ).toEqual({ unchanged: true, version: first.version });
    expect(
      JSON.parse((await read({ ifNot: "older" })).content[0].text).total
    ).toBe(3);
  } finally {
    spy.mockRestore();
  }
});

test("read_inbox with a pushId: that one card or none, the whole inbox's counts; a malformed id is refused", async () => {
  const checks = await import("../../memory/checks");
  const card = (ref: string, group: string) => ({
    deadline: null,
    group,
    pushId: checks.pushIdOf(ref, "0".repeat(64)),
    ref,
  });
  const second = card("b", "guessed person");
  const list = [card("a", "decision"), second];
  const spy = spyOn(checks, "checksAndKeyNow").mockResolvedValue({
    checks: list,
    key: "two cards",
  } as never);
  const read = async (arguments_: object) =>
    (
      await rpc(await token(), "tools/call", {
        arguments: arguments_,
        name: "read_inbox",
      })
    ).json.result;
  try {
    const one = JSON.parse(
      (await read({ limit: 1, pushId: second.pushId })).content[0].text
    );
    expect(one).toEqual({
      blocking: 1,
      checks: [second],
      counts: { decision: 1, "guessed person": 1 },
      deadlinesToday: 0,
      total: 2,
      version: versionOf("two cards"),
    });
    const none = JSON.parse(
      (await read({ pushId: "f".repeat(16) })).content[0].text
    );
    expect(none.checks).toEqual([]);
    expect(none.counts).toEqual(one.counts);
    expect(none.total).toBe(2);
    expect((await read({ pushId: "nope" })).isError).toBe(true);
  } finally {
    spy.mockRestore();
  }
});
