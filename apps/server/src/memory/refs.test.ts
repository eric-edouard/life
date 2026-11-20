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

test("lifeRefsOf: link destinations outside code, percent-decoded, each once", () => {
  const md = [
    "Kit [quoted](life:unit_0123456789ab) and [again](life:unit_0123456789ab).",
    "Her [message](<life:msg:github|github:acme/tools%2312/c9>) and [a site](https://example.com).",
    "Not this: `[x](life:unit_ffffffffffff)`",
    "```",
    "[nor this](life:obs_ffffffffffff)",
    "```",
  ].join("\n");
  expect(lifeRefsOf(md)).toEqual([
    "unit_0123456789ab",
    "msg:github|github:acme/tools#12/c9",
  ]);
  expect(lifeLinksOf(md)).toEqual([
    { kind: "unit", ref: "unit_0123456789ab" },
    { kind: "message", ref: "msg:github|github:acme/tools#12/c9" },
  ]);
  expect(lifeLinksOf(null)).toEqual([]);
});
