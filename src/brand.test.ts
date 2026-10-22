import { expect, test } from "bun:test";
import { C, MONO, RADIUS, SERIF } from "./memory/email";

// Life's brand has one source, assets/brand/tokens.css; the email and the app, which can't read it, copy its values.
// This fails when a copy drifts from it.
const asset = (path: string) =>
  Bun.file(new URL(`../${path}`, import.meta.url)).text();
const colours = (block: string) =>
  Object.fromEntries(
    [...block.matchAll(/--([a-z]+):\s*(#[0-9a-f]{6})/g)].map((m) => [
      m[1],
      m[2],
    ])
  );

const tokens = await asset("assets/brand/tokens.css");
const [lightCss = "", darkCss = ""] = tokens.split(
  "@media (prefers-color-scheme: dark)"
);
const light = colours(lightCss);
const dark = colours(darkCss);
const hex = (n: string) => `#${n.slice(2)}`;
const HEX_COLOUR = /#[0-9a-f]{6}\b|0x[0-9a-f]{6}\b/i;
const L_OUTLINE = /d="(M14 0[^"]+)"/;
/** The tray's build outputs, never checked in. */
const BUILT = /\/(bin|obj)\//;

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
  const swift = await asset("app/Sources/LifeApp/Brand.swift");
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

test("the Windows tray's colours and radii are tokens.css's, light and dark", async () => {
  const xaml = await asset("app-windows/Life.Tray/Brand.xaml");
  const brushes = (block = "") =>
    Object.fromEntries(
      [...block.matchAll(/x:Key="(\w+)" Color="(#[0-9a-f]{6})"/g)].map((m) => [
        (m[1] ?? "").toLowerCase(),
        m[2],
      ])
    );
  const [themes = "", rest = ""] = xaml.split(
    "</ResourceDictionary.ThemeDictionaries>"
  );
  const [lightXaml, darkXaml] = themes.split('x:Key="Dark"').map(brushes);
  const want = (from: Record<string, string>) =>
    Object.fromEntries(
      Object.entries(names).map(([name, token]) => [name, from[token]])
    );
  expect([lightXaml, darkXaml]).toEqual([
    want(light),
    want({ ...light, ...dark }),
  ]);
  expect(brushes(rest)).toEqual(
    Object.fromEntries(
      Object.entries(tones).map(([tone, token]) => [
        `tone${tone}`,
        light[token],
      ])
    )
  );
  const radius = (name: string) =>
    Number(xaml.match(new RegExp(`x:Key="${name}Radius">(\\d+)<`))?.[1]);
  expect({ control: radius("Control"), panel: radius("Panel") }).toEqual(
    RADIUS
  );
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
  expect([stack(SERIF), stack(MONO)]).toEqual([
    stack(value("serif")),
    stack(value("mono")),
  ]);
  const swift = await asset("app/Sources/LifeApp/Brand.swift");
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
    "app/Sources/LifeApp/Brand.swift",
    "app-windows/Life.Tray/Brand.xaml",
    "assets/brand/tokens.css",
    "src/memory/email.ts",
  ]);
  const root = new URL("..", import.meta.url).pathname;
  const files = new Bun.Glob(
    "**/*.{ts,js,css,html,swift,cs,xaml,json,jsonl,md}"
  );
  const read = ["src", "assets", "app/Sources", "app-windows"]
    .flatMap((dir) =>
      [...files.scanSync(root + dir)].map((file) => `${dir}/${file}`)
    )
    .filter((path) => !BUILT.test(path));
  expect(read).toContain("src/memory/email.ts");
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
