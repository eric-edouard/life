import { expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { setSettings, settings } from "../core/settings";
import type { Observation } from "../records/observation";
import { withSpans } from "./index-rows";
import { observationStatusOf, pagePath, shownOf } from "./memory-files";
import {
  frozenOnlyOf,
  layoutOf,
  parsePage,
  perSection,
  renderPage,
  shownBody,
} from "./page-format";
import { readStatusInputs } from "./status-inputs";

// With an add-on off its sections are frozen (hidden by readers, kept in the file) and what only they cite is hidden
// with them; with it on nothing changes. Made-up people and ids.
const A = "obs_aaaaaaaaaaaa"; // cited only in Between us
const B = "obs_bbbbbbbbbbbb"; // cited in Between us and in Now
const REF = "person:ana";

const pageText = () =>
  renderPage({
    hold: "> Ana.",
    layout: layoutOf(REF, true, () => true),
    meta: {
      built: "2026-10-18T02:00:00.000Z",
      madeBy: { engine: "codex", model: "m", prompt: "p", run: "r" },
      name: "Ana",
      page: REF,
      schemaVersion: 1,
      seen: "r",
    },
    owner: [],
    sections: {
      ...perSection(),
      between_us: [
        { cites: [A], text: "Ana and Jean keep money apart." },
        { cites: [B], text: "Ana trusts Jean with the keys." },
      ],
      now: [{ cites: [B], text: "Ana is renting a flat." }],
    },
    title: "Ana",
  });

const withAddOns = async <T>(
  personal: NonNullable<ReturnType<typeof settings>["personal"]>,
  run: () => Promise<T> | T
) => {
  const was = settings().personal;
  try {
    setSettings({ personal });
    return await run();
  } finally {
    setSettings({ personal: was ?? null });
  }
};
const o = (id: string) =>
  ({ id, madeBy: { run: "r", unitHash: "h" }, unit: "unit_1" }) as Observation;
const inputs = (frozenOnly: Set<string>) => ({
  corrections: [],
  frozenOnly,
  latest: new Map(),
  live: new Set(["unit_1"]),
  retired: new Map(),
});

test("relationships off: a Between us line and what only it cites show nowhere, and nothing is deleted", async () => {
  const text = pageText();
  const dates = () => ["2026-03-01"];
  await withAddOns({}, async () => {
    const shown = withSpans(text, dates);
    expect(shown).toContain("renting a flat");
    expect(shown).not.toContain("Between us");
    expect(shown).not.toContain("money apart");
    expect(shownBody(text)).not.toContain("keys");
    const only = frozenOnlyOf([
      parsePage(text) as NonNullable<ReturnType<typeof parsePage>>,
    ]);
    expect([...only]).toEqual([A]);
    const status = inputs(only);
    expect(observationStatusOf(o(A), status).state).toBe("frozen");
    expect(observationStatusOf(o(B), status).state).toBe("active");
    expect(shownOf([o(A), o(B)], status).map((x) => x.id)).toEqual([B]);

    // Through the files: the reading the pages, search, the index, fact checks and the email's key observations share.
    const file = pagePath(REF);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
    try {
      expect([...((await readStatusInputs([])).frozenOnly ?? [])]).toEqual([A]);
    } finally {
      rmSync(file, { force: true });
    }
  });
  expect(text).toContain("money apart");
});

test("relationships on: everything shows as before", async () => {
  const text = pageText();
  await withAddOns({ aboutMe: {}, relationships: {} }, async () => {
    expect(withSpans(text, () => ["2026-03-01"])).toContain("money apart");
    expect(shownBody(text)).toContain("## Between us");
    const status = await readStatusInputs([]);
    expect(status.frozenOnly).toBeUndefined();
    expect(observationStatusOf(o(A), inputs(new Set())).state).toBe("active");
  });
});
