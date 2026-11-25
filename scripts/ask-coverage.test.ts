import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CheckGroup } from "@life/server/src/core/names";
import { ITEM_STATES } from "@life/server/src/host/life-thread";
import { Option } from "@life/server/src/memory/card-request";
import { LINE_KINDS, MARKS } from "@life/server/src/memory/decision-lines";
import { MessageDraft } from "@life/server/src/memory/draft";
import { NEED_KINDS } from "@life/server/src/memory/needs";
import { BLOCKS } from "@life/server/src/records/answer-blocks";
import {
  MAIN_SESSION_ACT_KINDS,
  MAIN_SESSION_LINE_KINDS,
} from "@life/server/src/records/main-session-wire";

// Every kind of ask and answer the server can send the phone, from the server's own lists, has a fixture the server
// wrote, a Kit decode and a catalog drawing: or a line in `apps/lifelog/fixtures/ask-coverage.json` saying why not
// yet and where it is tracked. A kind drawn and decoded leaves the manifest (a stale line fails); a new kind fails
// until it is in one place or the other (`docs/research/2026-11-26-ask-coverage.md`).
const LIFELOG = "apps/lifelog";
const dir = (p: string) => readdirSync(p, { recursive: true }) as string[];
const text = (root: string, ext: string) =>
  dir(root)
    .filter((f) => f.endsWith(ext))
    .map((f) => readFileSync(join(root, f), "utf8"))
    .join("\n");
const fixtures = text(`${LIFELOG}/fixtures/wire/life`, ".json");
const kit = text(`${LIFELOG}/apps/ios/Kit/Sources`, ".swift");
const catalog = readFileSync(
  `${LIFELOG}/apps/ios/Lifelog/DesignSystem/Catalog.swift`,
  "utf8"
);

const lists: Record<string, readonly string[]> = {
  "answer block": Object.keys(BLOCKS),
  "check group": CheckGroup.options,
  "decision line": LINE_KINDS,
  "draft field": Object.keys(MessageDraft.shape),
  "item state": ITEM_STATES,
  "main-session act": MAIN_SESSION_ACT_KINDS,
  "main-session line": MAIN_SESSION_LINE_KINDS,
  "need kind": NEED_KINDS,
  "option flag": Object.keys(Option.shape),
  "rating mark": MARKS,
};

const camel = (k: string) =>
  k.replace(/[ :_-]+(.)/g, (_, c: string) => c.toUpperCase());
const word = (k: string) => new RegExp(`\\b${camel(k)}\\b`, "i");
const lacks = (k: string): string[] =>
  [
    fixtures.includes(`"${k}"`) || fixtures.includes(`"${k}":`)
      ? ""
      : "fixture",
    word(k).test(kit) || kit.includes(`"${k}"`) ? "" : "decode",
    word(k).test(catalog) || catalog.includes(`"${k}"`) ? "" : "catalog",
  ].filter(Boolean);

interface Entry {
  issue: number;
  kind: string;
  lacks: string[];
  reason: string;
}
const manifest: Entry[] = JSON.parse(
  readFileSync(`${LIFELOG}/fixtures/ask-coverage.json`, "utf8")
).notYetDrawn;
const key = (list: string, k: string) => `${list}: ${k}`;

test("every ask kind is covered or listed in the manifest with its reason", () => {
  const missing: string[] = [];
  const stale: string[] = [];
  const listed = new Map(manifest.map((e) => [e.kind, e]));
  const seen = new Set<string>();
  for (const [list, kinds] of Object.entries(lists)) {
    for (const k of kinds) {
      seen.add(key(list, k));
      const now = lacks(k);
      const entry = listed.get(key(list, k));
      if (now.length && !entry) {
        missing.push(`${key(list, k)} lacks ${now}`);
      }
      if (entry && entry.lacks.join() !== now.join()) {
        stale.push(`${key(list, k)}: manifest says ${entry.lacks}, now ${now}`);
      }
    }
  }
  const gone = manifest.filter((e) => !seen.has(e.kind)).map((e) => e.kind);
  expect({ gone, missing, stale }).toEqual({
    gone: [],
    missing: [],
    stale: [],
  });
  for (const e of manifest) {
    expect(e.reason.length).toBeGreaterThan(0);
    expect(e.issue).toBeGreaterThan(0);
  }
});
