import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { blockingA11yOf, greenOf, ROWS, regressedOf } from "./parity";

// Each parity fixture (the prototype's own made-up data) keeps the shape of the fixture it was copied from:
// every key path it holds exists in that source, so the app's decoders see no new field.
const WIRE = join(import.meta.dir, "../apps/lifelog/fixtures/wire");
const SOURCE: Record<string, string[]> = {
  "opening_broken.json": ["lab/opening_broken.json"],
  "opening.json": ["lab/opening.json", "life/read_thread_lab_asks.json"],
  "read_thread_draft_imessage.json": [
    "life/read_thread_draft.json",
    "lab/opening.json",
  ],
  "read_thread_draft_whatsapp.json": [
    "life/read_thread_draft.json",
    "lab/opening.json",
  ],
  "read_thread_draft.json": ["life/read_thread_draft.json", "lab/opening.json"],
  "read_thread_outdated.json": [
    "life/read_thread_outdated.json",
    "life/read_thread_draft.json",
    "lab/opening.json",
  ],
  "read_thread_person.json": [
    "life/read_thread_person.json",
    "lab/opening.json",
  ],
  "read_thread_rate.json": [
    "life/read_thread_settled_undo.json",
    "lab/opening.json",
  ],
  "read_thread_settled_imessage.json": [
    "life/read_thread_settled_imessage.json",
    "lab/opening.json",
  ],
  "read_thread_settled.json": [
    "life/read_thread_settled_imessage.json",
    "lab/opening.json",
  ],
  "read_thread_undo_whatsapp.json": [
    "life/read_thread_settled_undo.json",
    "lab/opening.json",
  ],
  "sign-in.json": ["lab/sign-in.json", "lab/opening.json"],
};

/** Every key path of a JSON value, arrays folded to `[]`. */
function paths(value: unknown, at = ""): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((v) => paths(v, `${at}[]`));
  }
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([k, v]) => [
      `${at}.${k}`,
      ...paths(v, `${at}.${k}`),
    ]);
  }
  return [];
}
const read = (file: string) =>
  JSON.parse(readFileSync(join(WIRE, file), "utf8"));

test("every parity fixture is named here", () => {
  expect(readdirSync(join(WIRE, "parity")).sort()).toEqual(
    Object.keys(SOURCE).sort()
  );
});

for (const [name, sources] of Object.entries(SOURCE)) {
  test(`${name} adds no key to ${sources.join(", ")}`, () => {
    const known = new Set(sources.flatMap((s) => paths(read(s))));
    expect(paths(read(`parity/${name}`)).filter((p) => !known.has(p))).toEqual(
      []
    );
  });
}

test("a row is green only when every column passes", () => {
  const row = {
    a11y: [],
    a11yBlocking: [],
    gaps: [],
    id: "draft",
    owner: null,
    review: { note: "", of: "p", score: 8 },
    status: "filled" as const,
    taps: { app: 1, proto: 1 },
    title: "A draft",
    works: true,
  };
  expect(greenOf(row)).toBe(true);
  expect(greenOf({ ...row, review: { ...row.review, score: 7 } })).toBe(false);
  expect(greenOf({ ...row, works: null })).toBe(false);
  expect(greenOf({ ...row, taps: { app: 2, proto: 1 } })).toBe(false);
  expect(greenOf({ ...row, a11yBlocking: ["clipped"] })).toBe(false);
  expect(greenOf({ ...row, a11y: ["contrast"] })).toBe(true);
  expect(greenOf({ ...row, owner: { verdict: "not right" as const } })).toBe(
    false
  );
});

test("accessibility blocks on clipped text and on what the prototype's state lacks", () => {
  const hit = "XCUIAccessibilityAuditType(rawValue: 4): Hit area is too small";
  const clipped = "XCUIAccessibilityAuditType(rawValue: 131072): Text clipped";
  const audit = [
    "XCUIAccessibilityAuditType(rawValue: 1): Contrast failed",
    "XCUIAccessibilityAuditType(rawValue: 65536): Dynamic Type font sizes are partially unsupported",
    hit,
    clipped,
  ];
  expect(blockingA11yOf(audit, { hasSmallHits: true })).toEqual([clipped]);
  expect(blockingA11yOf(audit, { hasSmallHits: false })).toEqual([
    hit,
    clipped,
  ]);
});

test("the gate names a green row whose flow fails or takes more taps than the prototype", () => {
  // Rows whose task takes taps: the first holds, the second's flow fails, the third takes one more tap, the fourth counted none.
  const rows = ROWS.filter((r) => r.taps > 0).slice(0, 4);
  const ids = rows.map((r) => r.id);
  const results = new Map(rows.map((r, i) => [r.flow, i !== 1]));
  const taps = (id: string) => {
    const i = ids.indexOf(id);
    return i === 3 ? null : (rows[i]?.taps ?? 0) + (i === 2 ? 1 : 0);
  };
  expect(regressedOf(rows, results, taps).map((r) => r.id)).toEqual(
    ids.slice(1)
  );
});
