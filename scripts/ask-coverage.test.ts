import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CheckGroup } from "@life/server/src/core/names";
import { ITEM_STATES } from "@life/server/src/host/life-thread";
import { CHANGES, Option } from "@life/server/src/memory/card-request";
import { LINE_KINDS, MARKS } from "@life/server/src/memory/decision-lines";
import { MessageDraft } from "@life/server/src/memory/draft";
import { NEED_KINDS } from "@life/server/src/memory/needs";
import { BLOCKS } from "@life/server/src/records/answer-blocks";
import {
  MAIN_SESSION_ACT_KINDS,
  MAIN_SESSION_LINE_KINDS,
} from "@life/server/src/records/main-session-wire";

// Every kind of ask and answer the server can send the phone, from the server's own lists, has a fixture the server
// wrote, a Kit decode and a view that draws it: or a line in `apps/lifelog/fixtures/ask-coverage.json` saying why not
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
// A kind is drawn only when a view of the app references it: the Debug catalog's labels never count.
const views = dir(`${LIFELOG}/apps/ios/Lifelog`)
  .filter((f) => f.endsWith(".swift") && !f.endsWith("Catalog.swift"))
  .map((f) => readFileSync(join(`${LIFELOG}/apps/ios/Lifelog`, f), "utf8"))
  .join("\n");
// What draws a kind, named by the view code that does (never a label or a generic word): a kind with no entry is not
// drawn, except an item state, whose Swift case has its own name.
const drawnAs: Record<string, RegExp> = {
  "answer block: document": /\bDocumentBlock\(/,
  "answer block: items": /\bItemsBlock\(/,
  "answer block: phrase": /\bPhraseBlock\(/,
  "answer block: place": /\bPlaceBlock\(/,
  "answer block: question": /\bQuestionBlock\(/,
  "answer block: settings": /\bLiveSettingsBlock\(/,
  "answer block: table": /\bTableBlock\(/,
  "card change: edit:tap": /\btap: true\b/,
  "card change: edit:words": /\blife\.opened\b/,
  "card change: message": /\bDraftBlock\(/,
  "check group: at organization": /\.atOrganization\b/,
  "check group: contacts card": /case \.contactsCard\b/,
  "check group: decision": /\bAskCard\(/,
  "check group: ending": /case \.ending:/,
  "check group: name": /\.personOrName\b/,
  "check group: new matter": /case \.newMatter:/,
  "check group: same person": /\.samePerson\b/,
  "check group: voice": /case \.voice:/,
  "decision line: sent": /\bSentLine\(/,
  "draft field: channel": /\bdraft\.channel\b/,
  "draft field: file": /\bdraft\.file\b/,
  "draft field: reaction": /\bdraft\.reaction\b/,
  "draft field: subject": /\bdraft\.subject\b/,
  "draft field: text": /\bdraft\.text\b/,
  "draft field: to": /\bdraft\.to\b/,
  "item state: later": /case \.later:/,
  "item state: needs_you": /case \.needsYou\b/,
  "item state: outdated": /case \.outdated:/,
  "item state: settled": /case \.settled:/,
  "item state: under_way": /case \.underWay:/,
  "item state: waiting_on_someone": /case \.waitingOnSomeone:/,
  "main-session line: block": /\bAnswerView\(/,
  "main-session line: reaction": /\blifeReaction\b/,
  "main-session line: step": /\bStepsLine\(\s*verb:/,
  "main-session line: thinking": /\bStepsLine\(\)/,
  "main-session line: words": /\bAnswerView\(/,
  "need kind: account": /\bNeedRows\(/,
  "need kind: amount": /\bNeedRows\(/,
  // The outcome rows of a calendar add, a paid run and a look for it done (`ItemRow.outcome`) and the cards' own parts.
  "need kind: apify": /\bSpendLine\(|\.kind == \.apify|\.apify\)/,
  "need kind: app": /\bNeedRows\(/,
  "need kind: event": /\bEventBox\(|\.event\)/,
  "need kind: link": /\bLinkCard\(/,
  "need kind: place": /\bNeedRows\(/,
  "need kind: qr": /\bPayCodeBox\(/,
  "need kind: text": /\bNeedRows\(/,
  "option flag: adds": /\$0\.adds\b|changed\?\.added/,
  "option flag: icon": /\$0\.icon\b/,
  "option flag: id": /\boption\.id\b/,
  "option flag: label": /\boption\.label\b/,
  "option flag: looks": /\.looks\b|\.looks == true/,
  "option flag: runs": /\$0\.runs\b|changed\?\.ran/,
  // His three marks, drawn by the rating row; the mapping from its marks is `RatingMark.of`.
  "rating mark: bad": /\bRatingMark\.of\b/,
  "rating mark: good": /\bRatingMark\.of\b/,
  "rating mark: okay": /\bRatingMark\.of\b/,
};

const lists: Record<string, readonly string[]> = {
  "answer block": Object.keys(BLOCKS),
  "card change": CHANGES,
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

const key = (list: string, k: string) => `${list}: ${k}`;
const camel = (k: string) =>
  k.replace(/[ :_-]+(.)/g, (_, c: string) => c.toUpperCase());
const word = (k: string) => new RegExp(`\\b${camel(k)}\\b`, "i");
const lacks = (list: string, k: string): string[] =>
  [
    fixtures.includes(`"${k}"`) || fixtures.includes(`"${k}":`)
      ? ""
      : "fixture",
    word(k).test(kit) || kit.includes(`"${k}"`) ? "" : "decode",
    drawnAs[key(list, k)]?.test(views) ? "" : "view",
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

test("every ask kind is covered or listed in the manifest with its reason", () => {
  const missing: string[] = [];
  const stale: string[] = [];
  const listed = new Map(manifest.map((e) => [e.kind, e]));
  const seen = new Set<string>();
  for (const [list, kinds] of Object.entries(lists)) {
    for (const k of kinds) {
      seen.add(key(list, k));
      const now = lacks(list, k);
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
