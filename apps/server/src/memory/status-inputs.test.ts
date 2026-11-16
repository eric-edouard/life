import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { OWNER_DATA_DIR } from "../core/paths";
import { setSettings, settings } from "../core/settings";
import type { Observation } from "../records/observation";
import { pageDiffs, readObservation } from "./changes";
import { withSpans } from "./index-rows";
import { buildIndex } from "./index-writer";
import {
  isCitedOnlyByFrozen,
  OBSERVATIONS,
  observationStatusOf,
  pagePath,
  shownOf,
} from "./memory-files";
import {
  assemble,
  checkReply,
  frozenOnlyOf,
  generated,
  layoutOf,
  type PageLine,
  parsePage,
  perSection,
  previousSections,
  renderPage,
  settle,
  shownBody,
} from "./page-format";
import { madeBy } from "./record-fixtures";
import { readReaderStatusInputs } from "./status-inputs";

// With an add-on off its sections are frozen (hidden by readers, kept in the file) and what only they cite is hidden
// with them; with it on nothing changes. Made-up people and ids.
const A = "obs_aaaaaaaaaaaa"; // cited only in Between us
const B = "obs_bbbbbbbbbbbb"; // cited in Between us and in Now
const REF = "person:ana";

const pageText = (
  between = "Ana and Jean keep money apart.",
  now = "Ana is renting a flat."
) =>
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
        { cites: [A], text: between },
        { cites: [B], text: "Ana trusts Jean with the keys." },
      ],
      now: [{ cites: [B], text: now }],
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
const fact = (id: string): Observation =>
  ({
    area: null,
    at: "2026-10-20T10:00:00.000Z",
    confidence: 1,
    date: "2026-10-20",
    id,
    importance: 2,
    madeBy: { ...madeBy, unitHash: "h" },
    quote: "q",
    schemaVersion: 1,
    source: { channel: "lifelog", ref: "j:0@x" },
    speaker: "person:me",
    subjects: [],
    text: "t",
    type: "to_do",
    tz: "UTC",
    unit: "unit_000000000001",
    validFrom: null,
    validTo: null,
    when: null,
  }) as Observation;

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
    // The steps that compute still see it as active; only the readers hide it.
    expect(observationStatusOf(o(A), status).state).toBe("active");
    expect(shownOf([o(A), o(B)], status).map((x) => x.id)).toEqual([A, B]);
    expect(isCitedOnlyByFrozen(o(A), status)).toBe(true);
    expect([A, B].filter((id) => !isCitedOnlyByFrozen(o(id), status))).toEqual([
      B,
    ]);

    // Through the files: the reading the pages, search, the index, fact checks and the email's key observations share.
    const file = pagePath(REF);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
    try {
      expect([
        ...((await readReaderStatusInputs([])).frozenOnly ?? []),
      ]).toEqual([A]);
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
    const status = await readReaderStatusInputs([]);
    expect(status.frozenOnly).toBeUndefined();
    expect(observationStatusOf(o(A), inputs(new Set())).state).toBe("active");
  });
});

const parsedSections = (text: string) => ({
  ...perSection<PageLine>(),
  ...generated(parsePage(text) as NonNullable<ReturnType<typeof parsePage>>),
});

test("settle and assemble keep a frozen section's lines whatever they cite; the page shows them again when the add-on is on", () => {
  const frozenLine = {
    cites: ["obs_cccccccccccc"],
    text: "Ana keeps her word.",
  };
  const prev = { ...perSection<PageLine>(), between_us: [frozenLine] };
  const known = {
    byId: new Map<string, Observation>(),
    retired: new Set<string>(),
  };
  const build = (on: boolean, from = prev) => {
    const layout = layoutOf(REF, true, () => on);
    const settled = settle(from, known, layout.frozen);
    const sections = assemble(
      settled.sections,
      checkReply({}, {} as never),
      known,
      {
        fixed: 0,
        layout,
        today: "2026-11-16",
      }
    );
    return renderPage({
      hold: "> Ana.",
      layout,
      meta: {
        built: "2026-10-18T02:00:00.000Z",
        madeBy: { engine: "codex", model: "m", prompt: "p", run: "r" },
        name: "Ana",
        page: REF,
        schemaVersion: 1,
        seen: "r",
      },
      owner: [],
      sections,
      title: "Ana",
    });
  };
  const off = build(false);
  expect(off).toContain("keeps her word");
  expect(shownBody(off)).not.toContain("keeps her word");
  // Turned back on, the page rebuilt from that file shows it (its observation known again).
  known.byId.set("obs_cccccccccccc", o("obs_cccccccccccc"));
  expect(shownBody(build(true, parsedSections(off)))).toContain(
    "keeps her word"
  );
});

test("read_observation shows no Between us line and no frozen observation while relationships is off", async () => {
  mkdirSync(OBSERVATIONS, { recursive: true });
  writeFileSync(
    join(OBSERVATIONS, "2026-10.jsonl"),
    `${[A, B].map((id) => JSON.stringify(fact(id))).join("\n")}\n`
  );
  const file = pagePath(REF);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, pageText());
  try {
    await withAddOns({}, async () => {
      await expect(readObservation(A)).rejects.toThrow("hidden while");
      const b = await readObservation(B);
      expect(b.pages.map((p) => p.line).join("\n")).toContain("renting a flat");
      expect(b.pages.map((p) => p.line).join("\n")).not.toContain("keys");
    });
    await withAddOns({ aboutMe: {}, relationships: {} }, async () => {
      expect((await readObservation(A)).pages[0]?.line).toContain(
        "money apart"
      );
    });
  } finally {
    rmSync(file, { force: true });
    rmSync(OBSERVATIONS, { force: true, recursive: true });
  }
});

test("the index leaves out an observation only a frozen section cites", () => {
  const path = join(tmpdir(), `frozen-index-${process.pid}.sqlite`);
  buildIndex([fact(A), fact(B)], path, inputs(new Set([A])));
  const db = new Database(path, { readonly: true });
  try {
    expect(
      db
        .query<{ id: string }, []>("select id from observations")
        .all()
        .map((r) => r.id)
    ).toEqual([B]);
  } finally {
    db.close();
    rmSync(path, { force: true });
  }
});

test("a rebuild starts the live sections over and keeps the frozen lines", () => {
  const prev = parsePage(pageText()) as NonNullable<
    ReturnType<typeof parsePage>
  >;
  const old = previousSections(prev, true, ["between_us"]);
  expect(old.between_us.map((l) => l.text)).toEqual([
    "Ana and Jean keep money apart.",
    "Ana trusts Jean with the keys.",
  ]);
  expect(old.now).toEqual([]);
  expect(previousSections(prev, false, ["between_us"]).now).toHaveLength(1);
});

test("page diffs with relationships off drop a changed Between us line and keep a Now line", async () => {
  const git = (...a: string[]) =>
    Bun.spawnSync([
      "git",
      "-C",
      OWNER_DATA_DIR,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      ...a,
    ]);
  const file = join(OWNER_DATA_DIR, "memory/pages/people/ana.md");
  mkdirSync(dirname(file), { recursive: true });
  git("init", "-q");
  await withAddOns({}, () => {
    writeFileSync(file, pageText("Old between.", "Old now."));
    git("add", "-A");
    git("commit", "-qm", "one");
    writeFileSync(file, pageText("New between.", "New now."));
    git("commit", "-qam", "two");
    const sha = git("rev-parse", "HEAD").stdout.toString().trim();
    const d = pageDiffs([sha]).get(`${sha}:memory/pages/people/ana.md`);
    expect(d?.added).toEqual(["- New now. [obs_bbbbbbbbbbbb]"]);
    expect(d?.removed).toEqual(["- Old now. [obs_bbbbbbbbbbbb]"]);
  });
  rmSync(file, { force: true });
});
