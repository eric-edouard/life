import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { clock } from "@life/server/src/core/clock";
import { chromium, type Page } from "playwright";
import {
  type DesignElement,
  gapsOf,
  placementOf,
  type ScreenNode,
} from "./design-compare";
import { GATE_SKIPPED, RESULT, SHOTS } from "./e2e-dirs";

// The parity board (docs/plans/2026-11-26-app-matches-prototype.md): each state of the approved prototype
// (`2026-11-25-app-v4.html`, one side-panel button) beside the app reaching it in a flow test over the same made-up data.
// `bun run parity [row …] [--no-app] [--verdicts <file>] [--digest <board url>]` writes `parity/board.json` and the pairs,
// which the designs app's Parity tab shows (https://designs.ericedouard.com/#/2026-11-23-chat-first/2026-11-26-parity-board.html).
// A row is green when every column it has passes: Looks (the reviewer's score of the pair, 8 or more; the words-and-boxes
// gaps are its evidence), Works (the flow test, which checks the calls the app made), Taps (no more than the
// prototype's), Accessibility (Apple's audit, blocking only as `blockingA11yOf` says), Owner (his "not right" is a failing note until the next batch fixes it).
// `bun run parity --gate` (the check's "parity gate", after the Swift builds): runs the flows of the rows green on the Mac's
// last board and fails naming each whose flow now fails or takes more taps; it writes nothing, and skips on battery.

const REPO = join(import.meta.dir, "..");
const PROTO = join(
  REPO,
  "docs/design/2026-11-23-chat-first/2026-11-25-app-v4.html"
);
const BOARD_DIR = "docs/design/2026-11-23-chat-first/parity";
const OUT = join(REPO, BOARD_DIR);
const VERDICTS = join(REPO, "docs/design/parity-verdicts.json");
const FRAME: [number, number] = [390, 844];
const LOOKS_PASS = 8;

/**
 * A state the app reaches: the side-panel (and phone) clicks that bring the prototype to it, the clicks in the phone its
 * task takes there (0: a state he only sees), and the flow test that brings the app to it and does the task.
 */
interface Row {
  flow: string;
  id: string;
  proto: string[];
  /** Words the prototype shows once the state is reached, when its clicks start something slow (an answer written). */
  ready?: string;
  taps: number;
  title: string;
}

export const ROWS: Row[] = [
  {
    flow: "OP1OpeningCleanTests",
    id: "open-clean",
    proto: ['[data-v4="openlong"]'],
    taps: 0,
    title: "Come back after 5 minutes: a clean screen",
  },
  {
    flow: "OP1OpeningBrokenTests",
    id: "open-broken",
    proto: ['[data-v4="broken"]'],
    taps: 0,
    title: "LINE and Messenger sign Life out",
  },
  {
    flow: "W1WaitingListTests",
    id: "waiting",
    proto: ['[data-v4="openlong"]', '#ph [aria-label$="waiting on you"]'],
    taps: 1,
    title: "What waits on you: the count's list",
  },
  {
    flow: "C1SendADraftTests",
    id: "draft",
    proto: ['[data-v4="draft"]'],
    taps: 1,
    title: "Life brings a draft to Jade, sent",
  },
  {
    flow: "C20RateTheAnswerTests",
    id: "rate",
    proto: ['[data-v4="rate"]'],
    taps: 1,
    title: "How am I doing? Life asks",
  },
  {
    flow: "C11UndoThenDeleteTests",
    id: "undo-whatsapp",
    proto: ['[data-v4="wa"]'],
    taps: 2,
    title: "A WhatsApp reply: Undo after",
  },
  {
    flow: "C10NoUndoOnAnIMessageTests",
    id: "imessage-no-undo",
    proto: ['[data-v4="im"]'],
    taps: 1,
    title: "An iMessage reply: no Undo",
  },
  {
    flow: "C12PersonAsTheAnswerTests",
    id: "which-person",
    proto: ['[data-try="person"]'],
    taps: 1,
    title: "Text Ben I'm running late (which person)",
  },
  {
    flow: "O2OfflineNoticeTests",
    id: "offline",
    proto: ['[data-k="offline"]'],
    taps: 0,
    title: "You go offline",
  },
  {
    flow: "L5MacOutOfReachTests",
    id: "mac-out",
    proto: ['[data-k="mac"]'],
    taps: 0,
    title: "Your Mac stops answering",
  },
  {
    flow: "N1SignBackInTests",
    id: "signed-out",
    proto: ['[data-k="login"]'],
    taps: 0,
    title: "WhatsApp signs you out",
  },
  {
    flow: "C16OutdatedWhileOpenTests",
    id: "outdated",
    proto: ['[data-v4="draft"]', "#o1"],
    taps: 0,
    title: "Jade writes again: the draft is out of date",
  },
  {
    flow: "M1SlowAnswerTests",
    id: "slow-answer",
    proto: ['[data-try="house"]'],
    ready: "The rest hasn’t moved",
    taps: 0,
    title: "Where are we regarding the house? (an answer as it is written)",
  },
  {
    flow: "V1VoiceGuessTests",
    id: "voice-guess",
    proto: ['[data-v4="vguess"]'],
    taps: 2,
    title: "A voice: Life suggests someone",
  },
];

interface Review {
  note: string;
  of: string;
  score: number;
}
interface Verdict {
  note?: string;
  verdict: "looks right" | "not right";
}
export interface BoardRow {
  a11y: string[] | null;
  /** The audit's issues that keep the row red (`blockingA11yOf`); the rest are shown only. */
  a11yBlocking: string[] | null;
  changed: boolean;
  gaps: string[];
  green: boolean;
  id: string;
  owner: Verdict | null;
  pair: string | null;
  review: Review | null;
  status: "filled" | "not built";
  taps: { app: number | null; proto: number } | null;
  title: string;
  works: boolean | null;
}

/** A side-panel scene no row brings the app to: its board row's id, from its button's selector. */
export const notBuiltIdOf = (selector: string) =>
  selector.replace(/\W+/g, "-").replace(/^-|-$/g, "");

/** The side panel's buttons: one prototype state each, the board's rows, titled by their words. */
function panelOf(page: Page) {
  return page.$$eval(".side button", (buttons) =>
    buttons.map((b) => {
      const attr = [...b.attributes].find((a) => a.name.startsWith("data-"));
      const byAttr = attr ? `[${attr.name}="${attr.value}"]` : "";
      return {
        selector: b.id ? `#${b.id}` : byAttr,
        title: (b.textContent ?? "").replace(/\s+/g, " ").trim(),
      };
    })
  );
}

/** What VoiceOver would read in the phone, as `design-compare` reads a frame: a label, else an element's words, in frame points. */
function elementsOf(page: Page): Promise<DesignElement[]> {
  return page.evaluate(([w, h]) => {
    const ph = document.getElementById("ph") as HTMLElement;
    const r0 = ph.getBoundingClientRect();
    const k = r0.width / w;
    const out: { box: [number, number, number, number]; name: string }[] = [];
    const isInline = (el: Element) =>
      getComputedStyle(el).display.startsWith("inline") &&
      !el.getAttribute("aria-label");
    // A label, else its words: a run of words split into spans (bold, a link, a time) is read as one.
    const nameOf = (el: Element) => {
      const words = ((el as HTMLElement).innerText ?? "").trim();
      const hasText = [...el.childNodes].some(
        (n) => n.nodeType === 3 && n.textContent?.trim()
      );
      const isWords =
        hasText ||
        (el.children.length > 0 && [...el.children].every(isInline) && words);
      return (el.getAttribute("aria-label") || (isWords ? words : ""))
        .replace(/\s+/g, " ")
        .trim();
    };
    const walk = (el: Element) => {
      const st = getComputedStyle(el);
      if (
        st.display === "none" ||
        st.visibility === "hidden" ||
        el.getAttribute("aria-hidden") === "true"
      ) {
        return;
      }
      const r = el.getBoundingClientRect();
      const name = nameOf(el);
      const box = [
        (r.x - r0.x) / k,
        (r.y - r0.y) / k,
        r.width / k,
        r.height / k,
      ].map(Math.round) as [number, number, number, number];
      const isOnScreen =
        box[1] < h && box[1] + box[3] > 0 && box[2] > 0 && box[3] > 0;
      if (name) {
        if (isOnScreen) {
          out.push({ box, name });
        }
        return;
      }
      for (const c of el.children) {
        walk(c);
      }
    };
    walk(ph);
    return out;
  }, FRAME);
}

/**
 * The owner's rule (27 Nov 2026): "accessibility, like contrast and text size, we don't care about much if it's already
 * what the design has provided for… we just want to follow the design. Cut-off text, yes it's an issue." Clipped text
 * always blocks; contrast and Dynamic Type follow the design's own colours and sizes, shown, never blocking; any other
 * issue blocks unless the prototype's state has it too (of those, only a small hit area can be read from its boxes).
 */
const AUDIT_TYPE = /rawValue: (\d+)/;
const A11Y = { contrast: 1, dynamicType: 65_536, hitRegion: 4 };
export function blockingA11yOf(
  audit: string[],
  proto: { hasSmallHits: boolean }
) {
  const shared = [
    A11Y.contrast,
    A11Y.dynamicType,
    ...(proto.hasSmallHits ? [A11Y.hitRegion] : []),
  ];
  return audit.filter(
    (issue) => !shared.includes(Number(AUDIT_TYPE.exec(issue)?.[1]))
  );
}

/** Whether the prototype's state shows a control under Apple's 44-point tap target, in frame points. */
function hasSmallHitsOf(page: Page) {
  return page.evaluate(([w, h]) => {
    const ph = document.getElementById("ph") as HTMLElement;
    const r0 = ph.getBoundingClientRect();
    const k = r0.width / w;
    return [
      ...ph.querySelectorAll("button, a, input, textarea, [role=button]"),
    ].some((el) => {
      const r = el.getBoundingClientRect();
      const y = (r.y - r0.y) / k;
      const isShown =
        r.width > 0 &&
        r.height > 0 &&
        y < h &&
        y + r.height / k > 0 &&
        getComputedStyle(el).visibility !== "hidden";
      return isShown && Math.min(r.width, r.height) / k < 44;
    });
  }, FRAME);
}

/** Shoots each row's prototype state, all at once, each on its own page: the picture and its elements. */
async function shootPrototype(rows: Row[]) {
  const browser = await chromium.launch();
  const open = async () => {
    const page = await browser.newPage({
      deviceScaleFactor: 2,
      viewport: { height: 960, width: 1400 },
    });
    // Not the `load` event: the page's Google Fonts stylesheet holds it (offline or slow, it never fires). The fonts get 5 s.
    await page.goto(`file://${PROTO}`, { waitUntil: "domcontentloaded" });
    await page.evaluate(() =>
      Promise.race([
        document.fonts.ready,
        new Promise((done) => setTimeout(done, 5000)),
      ])
    );
    await page.waitForTimeout(800);
    return page;
  };
  const shot = async (row: Row) => {
    const page = await open();
    for (const click of row.proto) {
      // biome-ignore lint/performance/noAwaitInLoops: each click acts on the state the one before it brought
      await page.click(click);
      await page.waitForTimeout(2500); // its lines arrive and ink in
    }
    if (row.ready) {
      await page.getByText(row.ready).first().waitFor({ timeout: 30_000 });
      await page.waitForTimeout(1500);
    }
    await page
      .locator("#ph")
      .screenshot({ path: join(OUT, `${row.id}.proto.png`) });
    const elements = await elementsOf(page);
    const hasSmallHits = await hasSmallHitsOf(page);
    await page.close();
    return [row.id, { elements, hasSmallHits }] as const;
  };
  const panel = await open();
  const [titles, shots] = await Promise.all([
    panelOf(panel),
    // Four pages at a time: a dozen at once time out while the Mac builds.
    (async () => {
      const out: Awaited<ReturnType<typeof shot>>[] = [];
      for (let i = 0; i < rows.length; i += 4) {
        // biome-ignore lint/performance/noAwaitInLoops: one batch of pages after another
        out.push(...(await Promise.all(rows.slice(i, i + 4).map(shot))));
      }
      return out;
    })(),
  ]);
  await browser.close();
  return { design: new Map(shots), titles };
}

/** The flows, in the heavy lane (one simulator job on the Mac at a time; at once inside a push's check, `heavy.sh`'s rule). */
function runFlows(rows: Row[]) {
  Bun.spawnSync(["rm", "-rf", SHOTS, RESULT]); // a build that fails leaves no stale result behind
  Bun.spawnSync(
    [
      join(REPO, "tools/heavy.sh"),
      "bun",
      join(REPO, "scripts/e2e-phone.ts"),
      ...rows.map((r) => r.flow),
    ],
    { stderr: "inherit", stdout: "inherit" }
  );
}

/** Each flow test's result, by class, from the last `e2e-phone` run. */
function flowResults() {
  const json = Bun.spawnSync([
    "xcrun",
    "xcresulttool",
    "get",
    "test-results",
    "tests",
    "--path",
    RESULT,
  ]).stdout.toString();
  const results = new Map<string, boolean>();
  const walk = (node: {
    children?: unknown[];
    name?: string;
    nodeType?: string;
    result?: string;
  }) => {
    if (node.nodeType === "Test Suite" && node.name) {
      results.set(node.name, node.result === "Passed");
    }
    for (const c of node.children ?? []) {
      walk(c as typeof node);
    }
  };
  for (const n of (JSON.parse(json || "{}").testNodes ?? []) as object[]) {
    walk(n);
  }
  return results;
}

/** The app's taps in a row's flow, from its shot in `SHOTS`. */
const tapsOf = (id: string) => {
  const file = join(SHOTS, `${id}.taps`);
  return existsSync(file) ? Number(readFileSync(file, "utf8")) : null;
};
/** No more taps than the prototype's, when its task takes any. */
const isTapsOk = (app: number | null, proto: number) =>
  proto === 0 || (app !== null && app <= proto);

/** The gate's failures: of rows green before, those whose flow failed or took more taps than the prototype. */
export const regressedOf = (
  rows: Row[],
  results: Map<string, boolean>,
  taps: (id: string) => number | null
) =>
  rows.filter(
    (r) => results.get(r.flow) !== true || !isTapsOk(taps(r.id), r.taps)
  );

const read = <T>(file: string): T | null =>
  existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as T) : null;
/**
 * What a pair shows: the prototype's file, and the app's words with their boxes. The prototype's own runs differ (its
 * suggestions rotate, its lines ink in), the file does not; the simulator draws the same frame every time.
 */
const pairOf = (screen: ScreenNode[] | undefined) =>
  createHash("sha256")
    .update(readFileSync(PROTO))
    .update(
      JSON.stringify((screen ?? []).map((n) => [n.label, n.value, n.rect]))
    )
    .digest("hex")
    .slice(0, 16);
/** What a row shows him: when it differs from the board before, the row changed. */
const signatureOf = (r: BoardRow) =>
  JSON.stringify([
    r.status,
    r.green,
    r.pair,
    r.review?.score,
    r.works,
    r.taps,
    r.a11y?.length,
    r.a11yBlocking?.length,
  ]);

/** Green: a pair the app reached in a flow that passed, every column it has passing (a review of 8 or more, no blocking accessibility issue, his word never "not right"). */
export const greenOf = (r: Omit<BoardRow, "changed" | "green" | "pair">) =>
  r.status === "filled" &&
  r.a11yBlocking !== null &&
  r.a11yBlocking.length === 0 &&
  r.review !== null &&
  r.review.score >= LOOKS_PASS &&
  r.works === true &&
  isTapsOk(r.taps?.app ?? null, r.taps?.proto ?? 0) &&
  r.owner?.verdict !== "not right";

export function boardRowOf(
  row: Row,
  gaps: string[],
  shot: { a11y: string[]; taps: number | null } | null,
  proto: { hasSmallHits: boolean },
  works: boolean | null,
  review: Review | null,
  owner: Verdict | null
): Omit<BoardRow, "changed" | "pair"> {
  const taps = row.taps ? { app: shot?.taps ?? null, proto: row.taps } : null;
  const fields = {
    a11y: shot?.a11y ?? null,
    a11yBlocking: shot ? blockingA11yOf(shot.a11y, proto) : null,
    gaps,
    id: row.id,
    owner,
    review,
    status: "filled" as const,
    taps,
    title: row.title,
    works,
  };
  return { ...fields, green: greenOf(fields) };
}

/** A row the app reaches, from its flow's shot in `SHOTS`: the pair, its gaps, the flow's result, his word. */
function filledRowOf(
  row: Row,
  design: { elements: DesignElement[]; hasSmallHits: boolean },
  was: BoardRow | undefined,
  passed: boolean | undefined,
  owner: Verdict | null
): BoardRow {
  const shot = read<{
    audit: string[];
    nodes: ScreenNode[];
    window: NonNullable<ScreenNode["rect"]>;
  }>(join(SHOTS, `${row.id}.json`));
  const app = join(SHOTS, `${row.id}.png`);
  if (shot && existsSync(app)) {
    copyFileSync(app, join(OUT, `${row.id}.app.png`));
  }
  const pair = pairOf(shot?.nodes);
  const taps = tapsOf(row.id);
  const gaps = shot
    ? gapsOf(
        design.elements,
        shot.nodes,
        shot.window,
        placementOf(FRAME, [shot.window.width, shot.window.height], "fit")
      )
    : ["no app shot: the flow never reached the state"];
  // A review holds while the pair it saw shows the same.
  const review = was?.review && was.pair === pair ? was.review : null;
  const next = boardRowOf(
    row,
    gaps,
    shot ? { a11y: shot.audit, taps } : null,
    design,
    passed ?? (shot ? null : false),
    review,
    owner
  );
  return { ...next, changed: false, pair };
}

/** The reviewer's scores (`{row: {score, note}}`), on the pairs the board holds now: the rows they turn green or red. */
export function withReviews(
  rows: BoardRow[],
  reviews: Record<string, { note: string; score: number }>
) {
  return rows.map((r) => {
    const review = reviews[r.id];
    if (!(review && r.pair)) {
      return r;
    }
    const next = { ...r, review: { ...review, of: r.pair } };
    const isNew = r.review?.score !== review.score;
    return { ...next, changed: r.changed || isNew, green: greenOf(next) };
  });
}

/** The gate's rows: those green on a board (the Mac's last), or why it runs none. */
export function gateRowsOf(board: string): Row[] | string {
  const baseline = read<{ rows: BoardRow[] }>(board);
  const green = new Set(baseline?.rows.filter((r) => r.green).map((r) => r.id));
  const rows = ROWS.filter((r) => green.has(r.id));
  if (rows.length) {
    return rows;
  }
  return baseline
    ? "no green row on the Mac's last board"
    : "no board from the Mac yet";
}

/** `--gate`: the rows green on the Mac's last board (the main checkout's, from any worktree), their flows run again. */
function gate() {
  const power = Bun.spawnSync(["pmset", "-g", "batt"]).stdout.toString();
  const common = Bun.spawnSync(
    ["git", "rev-parse", "--path-format=absolute", "--git-common-dir"],
    { cwd: REPO }
  )
    .stdout.toString()
    .trim();
  const rows = power.includes("Battery Power")
    ? "on battery"
    : gateRowsOf(join(dirname(common), BOARD_DIR, "board.json"));
  if (typeof rows === "string") {
    console.log(`skipped: ${rows}`);
    return GATE_SKIPPED;
  }
  runFlows(rows);
  const ran = existsSync(RESULT);
  const results = flowResults();
  const regressed = regressedOf(rows, results, tapsOf);
  for (const r of regressed) {
    let why = "its flow fails";
    if (!ran) {
      why = "the flows didn't run (build failed?)";
    } else if (results.get(r.flow)) {
      why = `takes ${tapsOf(r.id) ?? "?"} taps, the prototype ${r.taps}`;
    }
    console.error(`✗ ${r.id} (${r.title}): ${why}`);
  }
  console.log(
    `${rows.length - regressed.length} of ${rows.length} green rows hold`
  );
  return regressed.length ? 1 : 0;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flag = (name: string) => {
    const at = args.indexOf(name);
    return at < 0 ? undefined : args.splice(at, 2)[1];
  };
  const noApp = args.includes("--no-app");
  // The owner's verdicts, told in chat and kept in the repo; a file given instead is read in their place.
  const verdicts =
    read<Record<string, Verdict>>(flag("--verdicts") ?? VERDICTS) ?? {};
  const boardUrl = flag("--digest");
  const reviewsFile = flag("--reviews");
  if (args.includes("--gate")) {
    process.exit(gate());
  }
  const ids = args.filter((a) => !a.startsWith("--"));
  const rows = ids.length ? ROWS.filter((r) => ids.includes(r.id)) : ROWS;
  mkdirSync(OUT, { recursive: true });

  async function run() {
    const { design, titles } = await shootPrototype(rows);
    if (!noApp) {
      runFlows(rows);
    }
    const results = flowResults();
    const before = stored?.rows ?? [];
    const beforeOf = new Map(before.map((r) => [r.id, r]));
    const board: BoardRow[] = [];
    const used = new Set(ROWS.flatMap((r) => r.proto));
    const notBuilt = titles.filter((t) => t.selector && !used.has(t.selector));
    const add = (full: BoardRow) => {
      const was = beforeOf.get(full.id);
      full.changed = !was || signatureOf(was) !== signatureOf(full);
      board.push(full);
    };
    for (const row of ROWS) {
      const was = beforeOf.get(row.id);
      if (!rows.includes(row)) {
        // Not run this time: as the board had it, his newest word on it kept.
        if (was) {
          board.push({
            ...was,
            changed: false,
            owner: verdicts[row.id] ?? was.owner,
          });
        }
        continue;
      }
      add(
        filledRowOf(
          row,
          design.get(row.id) ?? { elements: [], hasSmallHits: false },
          was,
          results.get(row.flow),
          verdicts[row.id] ?? was?.owner ?? null
        )
      );
    }
    for (const { selector, title } of notBuilt) {
      const id = notBuiltIdOf(selector);
      add({
        a11y: null,
        a11yBlocking: null,
        changed: false,
        gaps: [],
        green: false,
        id,
        owner: null,
        pair: null,
        review: null,
        status: "not built",
        taps: null,
        title,
        works: null,
      });
    }
    return { board, was: before.filter((r) => r.green).length };
  }
  const stored = read<{ rows: BoardRow[]; was: number }>(
    join(OUT, "board.json")
  );
  let board: BoardRow[];
  let was: number;
  if (reviewsFile) {
    // The run's second half: its rows as written, the reviewer's scores on them.
    board = withReviews(stored?.rows ?? [], read(reviewsFile) ?? {});
    was = stored?.was ?? 0;
  } else {
    ({ board, was } = await run());
  }
  // The board artifact's pictures: small JPEGs beside board.json (sips, the Mac's own), the PNGs kept for the mail.
  for (const r of board.filter((b) => b.status === "filled")) {
    for (const side of ["proto", "app"]) {
      const png = join(OUT, `${r.id}.${side}.png`);
      if (existsSync(png)) {
        Bun.spawnSync([
          "sips",
          "-s",
          "format",
          "jpeg",
          "-s",
          "formatOptions",
          "70",
          "-Z",
          "900",
          png,
          "--out",
          join(OUT, `${r.id}.${side}.jpg`),
        ]);
      }
    }
  }
  const filled = board.filter((r) => r.status === "filled");
  const green = board.filter((r) => r.green).length;
  writeFileSync(
    join(OUT, "board.json"),
    `${JSON.stringify({ at: clock().toISOString(), green, rows: board, total: board.length, was }, null, 2)}\n`
  );
  console.log(
    `${green} of ${board.length} green (was ${was}); ${filled.length} filled; ${board.filter((r) => r.changed).length} changed`
  );

  // The evening mail's parts, only when a row changed: the count, each changed row's pair inline, a link to answer it.
  const changed = board.filter((r) => r.changed && r.status === "filled");
  rmSync(join(OUT, "digest"), { force: true, recursive: true }); // a day with nothing changed sends nothing
  if (boardUrl && changed.length) {
    const dir = join(OUT, "digest");
    mkdirSync(dir, { recursive: true });
    const rowsHtml = changed
      .map(
        (r) => `<h3 style="margin:24px 0 4px">${r.title}</h3>
<p style="margin:0 0 8px;color:#555">${r.green ? "green" : "not green yet"}${r.review ? ` · looks ${r.review.score}/10` : ""}${r.taps ? ` · taps ${r.taps.app ?? "?"} vs ${r.taps.proto}` : ""}</p>
<table><tr><td>Prototype<br><img src="cid:${r.id}-proto" width="220"></td><td>App<br><img src="cid:${r.id}-app" width="220"></td></tr></table>
<p><a href="${boardUrl}#${r.id}">Looks right? Answer on the board</a></p>`
      )
      .join("\n");
    writeFileSync(
      join(dir, "subject.txt"),
      `Parity board: ${green} of ${board.length} green, was ${was}`
    );
    writeFileSync(
      join(dir, "body.html"),
      `<div style="font-family:-apple-system,sans-serif;font-size:15px">
<p><b>${green} of ${board.length} green</b>, was ${was}. ${changed.length} row${changed.length > 1 ? "s" : ""} changed today: say if each looks right (taste only; nothing waits on you).</p>
${rowsHtml}</div>`
    );
    writeFileSync(
      join(dir, "attachments.txt"),
      `${changed
        .flatMap((r) => [
          `${join(OUT, `${r.id}.proto.jpg`)};cid=${r.id}-proto;filename=${r.id}-proto.jpg`,
          `${join(OUT, `${r.id}.app.jpg`)};cid=${r.id}-app;filename=${r.id}-app.jpg`,
        ])
        .filter((spec) => existsSync(spec.split(";")[0] as string))
        .join("\n")}\n`
    );
    console.log(`digest: ${dir}`);
  }
}
