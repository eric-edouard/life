import { expect, test } from "bun:test";
import { lifeLinksOf, lifeRefsOf, parseRef } from "./refs";

test("parseRef: one grammar, each kind from its ref", () => {
  const kind = (id: string) => {
    const r = parseRef(id);
    return "error" in r ? r.error : r.kind;
  };
  expect(kind("ask/draft")).toBe("ask");
  expect(kind("person:test-ana/now")).toBe("person");
  expect(kind("matter_0123456789ab")).toBe("matter");
  // A lone to-do item's matter has the item's key.
  expect(kind("entry_0123456789ab")).toBe("matter");
  expect(kind("obs_0123456789ab")).toBe("observation");
  expect(kind("unit_0123456789ab")).toBe("unit");
  expect(kind("file:whatsapp:120@g.us/S1")).toBe("file");
  expect(kind("job-1:3@2026-10-14T10:06:00.000Z")).toBe("turn");
  expect(kind("claude:w1")).toBe("conversation");
  expect(kind("person:test-ana")).toContain("not a read part ref");
  expect(kind("msg:nowhere|x")).toContain("not a message ref");
  expect(kind("msg:whatsapp|")).toContain("not a message ref");
});

test("a message ref splits at its first |: the message id may hold / and #", () => {
  expect(parseRef("msg:github|github:acme/tools#12/c9|x")).toEqual({
    id: "msg:github|github:acme/tools#12/c9|x",
    kind: "message",
    message: "github:acme/tools#12/c9|x",
    source: "github",
  });
});

test("lifeRefsOf: link destinations as Markdown reads them, never in code, percent-decoded, each once", () => {
  const md = [
    "Kit [quoted](life:unit_0123456789ab) and [again](life:unit_0123456789ab).",
    "Her [message](<life:msg:github|github:acme/tools%2312/c9>), [a site](https://example.com) and [the plan][plan].",
    "Not this: `[x](life:unit_ffffffffffff)`",
    "",
    "    [nor this, indented](life:unit_eeeeeeeeeeee)",
    "",
    "```",
    "[nor this](life:obs_ffffffffffff)",
    "```",
    "",
    "[plan]: life:obs_0123456789ab",
  ].join("\n");
  expect(lifeRefsOf(md)).toEqual([
    "unit_0123456789ab",
    "msg:github|github:acme/tools#12/c9",
    "obs_0123456789ab",
  ]);
  // A lone observation's matter has its id: the phone is told it is a matter, as fetch opens it.
  expect(lifeLinksOf(md, (id) => id === "obs_0123456789ab")).toEqual([
    { kind: "unit", ref: "unit_0123456789ab" },
    { kind: "message", ref: "msg:github|github:acme/tools#12/c9" },
    { kind: "matter", ref: "obs_0123456789ab" },
  ]);
  expect(lifeLinksOf(null)).toEqual([]);
});
