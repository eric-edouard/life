import { expect, test } from "bun:test";
import { join } from "node:path";
import { LIFE_CODE_DIR } from "@life/server/src/core/paths";
import { repoFiles } from "@life/server/src/core/proc";
import { C, MONO, RADIUS, SANS, SERIF } from "@life/server/src/memory/email";

// Life's brand has one source, assets/brand/tokens.css; the email and the app, which can't read it, copy its values.
// This fails when a copy drifts from it.
const asset = (path: string) => Bun.file(join(LIFE_CODE_DIR, path)).text();
const tokens = await asset("assets/brand/tokens.css");
// Each colour is `#light` or `light-dark(#light, #dark)`.
const tokenColours = [
  ...tokens.matchAll(
    /--([a-z]+):\s*(?:light-dark\()?(#[0-9a-f]{6})(?:,\s*(#[0-9a-f]{6}))?/g
  ),
];
const light = Object.fromEntries(tokenColours.map((m) => [m[1], m[2]]));
const dark = Object.fromEntries(
  tokenColours.filter((m) => m[3]).map((m) => [m[1], m[3]])
);
const hex = (n: string) => `#${n.slice(2)}`;
const HEX_COLOUR = /#[0-9a-f]{6}\b|0x[0-9a-f]{6}\b/i;
const L_OUTLINE = /d="(M14 0[^"]+)"/;

test("the email's colours are tokens.css's", () => {
  for (const [name, value] of Object.entries(C)) {
    expect([name, value]).toEqual([name, light[name] ?? "not a token"]);
  }
});

// The apps' names for the tokens they copy, then each Tone's status token.
const names: Record<string, string> = {
  ink: "ink",
  muted: "muted",
  page: "white",
  rule: "rule",
  surface: "surface",
};
const tones: Record<string, string> = {
  bad: "error",
  busy: "progress",
  idle: "unknown",
  ok: "synced",
  teal: "confirmation",
  warn: "open",
};

test("the app's colours are tokens.css's, light and dark", async () => {
  const swift = await asset("apps/mac/Sources/LifeApp/Brand.swift");
  const pairs = [
    ...swift.matchAll(
      /static let (\w+) = Color\(light: (0x\w+), dark: (0x\w+)\)/g
    ),
  ];
  expect(pairs.map((m) => m[1]).toSorted()).toEqual(Object.keys(names));
  for (const [, name = "", l = "", d = ""] of pairs) {
    const token = names[name] ?? "";
    expect([name, hex(l), hex(d)]).toEqual([
      name,
      light[token],
      dark[token] ?? light[token],
    ]);
  }
  const statuses = [...swift.matchAll(/case \.(\w+): Color\((0x\w+)\)/g)];
  expect(statuses.map((m) => m[1]).toSorted()).toEqual(Object.keys(tones));
  for (const [, tone = "", value = ""] of statuses) {
    expect([tone, hex(value)]).toEqual([tone, light[tones[tone] ?? ""]]);
  }
});

test("the email's and the app's radii and the email's font stacks are tokens.css's", async () => {
  const value = (name: string) =>
    tokens.match(new RegExp(`--${name}:\\s*([^;]+);`))?.[1] ?? "";
  const px = (name: string) => Number.parseFloat(value(name));
  expect(RADIUS).toEqual({
    control: px("control-radius"),
    panel: px("panel-radius"),
  });
  const stack = (s: string) => s.replaceAll(/["'\s]/g, "");
  expect([stack(SERIF), stack(SANS), stack(MONO)]).toEqual([
    stack(value("serif")),
    stack(value("sans")),
    stack(value("mono")),
  ]);
  const swift = await asset("apps/mac/Sources/LifeApp/Brand.swift");
  const radius = (name: string) =>
    Number(
      swift.match(new RegExp(`static let ${name}: CGFloat = (\\d+)`))?.[1]
    );
  expect({ control: radius("control"), panel: radius("panel") }).toEqual(
    RADIUS
  );
});

test("no colour is written anywhere else: every hex colour is in tokens.css or a checked copy", async () => {
  const allowed = new Set([
    "apps/mac/Sources/LifeApp/Brand.swift",
    "assets/brand/tokens.css",
    "apps/server/src/memory/email.ts",
  ]);
  const read = repoFiles(
    LIFE_CODE_DIR,
    ["apps/server/src", "assets", "apps/mac/Sources", "apps/web/src"],
    ".ts .tsx .js .css .html .swift .json .jsonl .md".split(" ")
  );
  expect(read).toContain("apps/server/src/memory/email.ts");
  const texts = await Promise.all(read.map(asset));
  const strays = read.filter(
    (path, i) => !allowed.has(path) && HEX_COLOUR.test(texts[i] ?? "")
  );
  expect(strays).toEqual([]);
});

test("the L is one outline: the icon's, the wordmark's and the menu bar's are the same", async () => {
  const outline = async (path: string) =>
    (await asset(path)).match(L_OUTLINE)?.[1];
  const l = await outline("assets/brand/life-l.svg");
  expect(l).toBeTruthy();
  expect([
    await outline("assets/brand/life.svg"),
    await outline("assets/icon/icon.svg"),
  ]).toEqual([l, l]);
});

const CARD_RULE = /\n\s*\.(opt|field|row)\b([^{]*)\{([^}]*)\}/g;
// Any border, outline or shadow ring on a card's side or all round (its radius aside); `0` or `none` removes one.
const BORDER =
  /(?:border(?!-radius)[\w-]*|outline|box-shadow):(?!\s*(?:0|none)\b)/;
const CLASSES = /className="([^"]*)"/g;
const ROUNDED = /\brounded/;
// Tailwind's border utilities, border-0 aside.
const BORDER_UTILITY = /\bborder(?!-0\b)(?:-|\b)/;

test("no card draws a border in the web app: a subtle background sets it apart (owner, 30 Oct)", async () => {
  const css = await asset("apps/web/src/styles.css");
  // The cards' own rules (options, fields, overview rows), not their parts' (the status circle is a mark, not a card).
  const cards = [...css.matchAll(CARD_RULE)].filter(
    ([, , selector]) => !selector?.includes(".mark")
  );
  expect(cards.length).toBeGreaterThan(2);
  const bordered = cards
    .filter(([, , , body]) => BORDER.test(body ?? ""))
    .map(([, name]) => name);
  expect(bordered).toEqual([]);
  // Any rounded box in the components carries no border utility (border-0 aside).
  const tsx = repoFiles(LIFE_CODE_DIR, ["apps/web/src"], [".tsx"]);
  const boxed = (await Promise.all(tsx.map(asset))).flatMap((t, i) =>
    [...t.matchAll(CLASSES)]
      .map(([, c]) => c ?? "")
      .filter((c) => ROUNDED.test(c) && BORDER_UTILITY.test(c))
      .map((c) => `${tsx[i]}: ${c}`)
  );
  expect(boxed).toEqual([]);
});
