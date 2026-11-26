import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { greenOf } from "./parity";

// Each parity fixture (the prototype's own made-up data) keeps the shape of the fixture it was copied from:
// every key path it holds exists in that source, so the app's decoders see no new field.
const WIRE = join(import.meta.dir, "../apps/lifelog/fixtures/wire");
const SOURCE: Record<string, string[]> = {
  "opening_broken.json": ["lab/opening_broken.json"],
  "opening.json": ["lab/opening.json"],
  "read_people_and_organizations.json": [
    "life/read_people_and_organizations.json",
  ],
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
  expect(greenOf({ ...row, a11y: ["contrast"] })).toBe(false);
  expect(greenOf({ ...row, owner: { verdict: "not right" as const } })).toBe(
    false
  );
});
