import { expect, test } from "bun:test";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { clock, FROZEN } from "./clock";
import { exec } from "./proc";

// The bench's frozen world (`LIFE_NOW`): this file runs itself again with the clock stopped, and those tests check
// what a frozen process serves.
const NOW = "2026-10-14T10:00:00.000Z";
const at = (minutes: number) =>
  new Date(Date.parse(NOW) + minutes * 60_000).toISOString();

test.if(FROZEN === undefined)(
  "under LIFE_NOW, the frozen tests pass",
  async () => {
    const r = await exec(["bun", "test", import.meta.path], {
      env: { ...process.env, LIFE_NOW: NOW },
      timeout: 60_000,
    });
    expect(`${r.stdout}${r.stderr}`).toContain(" 0 fail");
    expect(r.code).toBe(0);
  }
);

test.if(FROZEN !== undefined)(
  "the clock and every range stop at LIFE_NOW",
  async () => {
    const { dayRange } = await import("./memory/units");
    expect(clock().toISOString()).toBe(NOW);
    expect(dayRange().to).toBe(NOW);
    expect(dayRange("2026-10-01", "2026-10-30").to).toBe(NOW);
  }
);

test.if(FROZEN !== undefined)(
  "chats and places show nothing after now",
  async () => {
    const { chatsOf } = await import("./memory/raw");
    const { placesOf } = await import("./memory/places");
    const message = (minutes: number, text: string) => ({
      at: at(minutes),
      chat: "!c",
      chatName: "Ana",
      fromMe: false,
      id: `m${minutes}`,
      sender: "Ana",
      source: "beeper" as const,
      text,
    });
    const chats =
      (await chatsOf(
        { chat: "!c" },
        { beeper: () => [message(-5, "before now"), message(5, "after now")] }
      )) ?? "";
    expect(chats).toContain("before now");
    expect(chats).not.toContain("after now");
    const stay = (from: number, to: number | null, place: string) => ({
      arrivedAt: at(from),
      latitude: 13.7,
      leftAt: to === null ? null : at(to),
      longitude: 100.5,
      place,
    });
    const places =
      (await placesOf(
        { place: "x" },
        {
          visits: () =>
            Promise.resolve([stay(30, 60, "Later"), stay(-30, 30, "Now")]),
          where: () => Promise.resolve([]),
        }
      )) ?? "";
    expect(places).toContain("Now");
    expect(places).toContain("–now");
    expect(places).not.toContain("Later");
  }
);

test.if(FROZEN !== undefined)(
  "what acts outside the copy refuses to run frozen",
  async () => {
    const { remctl } = await import("./actions");
    const { forward } = await import("./sources/lifelog");
    const { sendReport } = await import("./memory/report");
    await expect(remctl(["lists"])).rejects.toThrow("frozen run");
    await expect(forward("title", {} as never)).rejects.toThrow("frozen run");
    await expect(sendReport("k", {} as never)).rejects.toThrow("frozen run");
  }
);

test.if(FROZEN !== undefined)(
  "a frozen connector acts on nothing and subscribes nothing",
  async () => {
    const { buildServer } = await import("./mcp");
    const handler = createMcpHandler(buildServer);
    const rpc = async (method: string, params: object) => {
      const res = await handler.fetch(
        new Request("http://localhost/mcp", {
          body: JSON.stringify({ id: 1, jsonrpc: "2.0", method, params }),
          headers: {
            accept: "application/json, text/event-stream",
            "content-type": "application/json",
          },
          method: "POST",
        }),
        { authInfo: { clientId: "bench", scopes: [], token: "t" } }
      );
      const body = await res.text();
      const data = body.split("\n").find((l) => l.startsWith("data:"));
      return JSON.parse(data ? data.slice(5) : body);
    };
    const call = async (name: string, args: object) =>
      (await rpc("tools/call", { arguments: args, name })).result.content[0]
        .text as string;
    expect(
      await call("reminders", {
        kind: "add",
        said: "remind me to call the bank",
        title: "Call the bank",
      })
    ).toStartWith("Not done: this is a frozen run");
    expect(
      await call("correct", { kind: "rename_person", name: "x", personId: "p" })
    ).toStartWith("Not done");
    expect(await call("open_reminders", {})).toStartWith("Not done");
    const sub = await rpc("events/subscribe", {
      delivery: {
        mode: "webhook",
        secret: `whsec_${Buffer.alloc(32).toString("base64")}`,
        url: "https://api.openai.com/hook",
      },
      name: "ask",
    });
    const unsub = await rpc("events/unsubscribe", {
      delivery: { mode: "webhook", url: "https://api.openai.com/hook" },
      name: "ask",
    });
    for (const r of [sub, unsub]) {
      expect(r.error?.message ?? "").toContain("frozen run");
    }
  }
);
