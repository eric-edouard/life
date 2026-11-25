import { expect, test } from "bun:test";
import { join } from "node:path";
import { LIFE_CODE_DIR } from "@life/server/src/core/paths";
import { repoFiles } from "@life/server/src/core/proc";

const IS_MONO = /isMono/;

import { C, RADIUS, SANS } from "@life/server/src/memory/email";

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

// The tokens the app copies, by their own names, then each Tone's status token.
const copied: Record<string, string> = {
  card: "card",
  ground: "bg",
  ink: "fg",
  muted: "muted",
  rule: "line",
};
const tones: Record<string, string> = {
  bad: "flag",
  busy: "ai",
  idle: "faint",
  ok: "ok",
  teal: "ok",
  warn: "flag",
};

test("the app's colours are tokens.css's, light and dark", async () => {
  const swift = await asset("apps/mac/Sources/LifeApp/Brand.swift");
  const pairs = [
    ...swift.matchAll(
      /static let (\w+) = Color\(light: (0x\w+), dark: (0x\w+)\)/g
    ),
  ];
  expect(pairs.map((m) => m[1]).toSorted()).toEqual(
    Object.keys(copied).toSorted()
  );
  for (const [, name = "", l = "", d = ""] of pairs) {
    const token = copied[name] ?? "";
    expect([name, hex(l), hex(d)]).toEqual([
      name,
      light[token],
      dark[token] ?? light[token],
    ]);
  }
  const statuses = [
    ...swift.matchAll(/case \.(\w+): Color\(light: (0x\w+), dark: (0x\w+)\)/g),
  ];
  expect(statuses.map((m) => m[1]).toSorted()).toEqual(Object.keys(tones));
  for (const [, tone = "", l = "", d = ""] of statuses) {
    const token = tones[tone] ?? "";
    expect([tone, hex(l), hex(d)]).toEqual([tone, light[token], dark[token]]);
  }
});

test("the phone's palette is tokens.css's, light and dark", async () => {
  const swift = await asset("apps/lifelog/apps/ios/Shared/Palette.swift");
  const pairs = [
    ...swift.matchAll(
      /static let (\w+) = token\(dark: (0x\w+), light: (0x\w+)\)/g
    ),
  ];
  const names = Object.keys(light).filter((n) => n in dark);
  expect(pairs.map((m) => m[1]).toSorted()).toEqual(names.toSorted());
  for (const [, name = "", d = "", l = ""] of pairs) {
    expect([name, hex(d), hex(l)]).toEqual([name, dark[name], light[name]]);
  }
});

test("the phone's tint, glass, wash, aura colours, type scale and block radius are tokens.css's", async () => {
  const swift = await asset("apps/lifelog/apps/ios/Shared/Palette.swift");
  for (const name of ["tint", "glass", "wash"]) {
    const percent = tokens.match(
      new RegExp(`--${name}:\\s*color-mix\\(in srgb, var\\(--fg\\) (\\d+)%`)
    )?.[1];
    const opacity = swift.match(
      new RegExp(`static let ${name} = fg\\.opacity\\(([0-9.]+)\\)`)
    )?.[1];
    expect([name, Number(opacity)]).toEqual([name, Number(percent) / 100]);
  }
  const aura = [
    ...tokens.matchAll(
      /--aura-([a-z]+):\s*light-dark\((#[0-9a-f]{6}),\s*(#[0-9a-f]{6})\)/g
    ),
  ].map((m) => [m[1], m[3], m[2]]);
  const copies = [
    ...swift.matchAll(
      /\("([a-z]+)", token\(dark: (0x\w+), light: (0x\w+)\)\)/g
    ),
  ].map((m) => [m[1], hex(m[2] ?? ""), hex(m[3] ?? "")]);
  expect(aura.length).toBe(8);
  expect(copies).toEqual(aura);
  const type = await asset(
    "apps/lifelog/apps/ios/Lifelog/DesignSystem/Typography.swift"
  );
  const sizes = [...tokens.matchAll(/--text-[a-z]+:\s*([\d.]+)px/g)].map((m) =>
    Number(m[1])
  );
  const used = new Set(
    [...type.matchAll(/TypeStep\(size: ([\d.]+), weight: (\d+)/g)]
      .filter(
        (m) =>
          !IS_MONO.test(
            m.input?.split("\n").find((l) => l.includes(m[0])) ?? ""
          )
      )
      .flatMap((m) => [Number(m[1]), -Number(m[2])])
  );
  for (const u of used) {
    if (u > 0) {
      expect(sizes).toContain(u);
    } else {
      expect([450, 600, 650]).toContain(-u);
    }
  }
  const metrics = await asset("apps/lifelog/apps/ios/Shared/Metrics.swift");
  for (const [swiftName, cssName] of [
    ["control", "control"],
    ["block", "block"],
    ["sheet", "panel"],
  ] as const) {
    const swiftRadius = metrics.match(
      new RegExp(`static let ${swiftName}: CGFloat = (\\d+)`)
    )?.[1];
    const cssRadius = tokens.match(
      new RegExp(`--${cssName}-radius:\\s*([\\d.]+)px`)
    )?.[1];
    expect([swiftName, Number(swiftRadius)]).toEqual([
      swiftName,
      Number.parseFloat(cssRadius ?? ""),
    ]);
  }
});

test("the email's and the app's radii and the email's font stack are tokens.css's", async () => {
  const value = (name: string) =>
    tokens.match(new RegExp(`--${name}:\\s*([^;]+);`))?.[1] ?? "";
  const px = (name: string) => Number.parseFloat(value(name));
  expect(RADIUS).toEqual({
    control: px("control-radius"),
    panel: px("panel-radius"),
  });
  const stack = (s: string) => s.replaceAll(/["'\s]/g, "");
  expect(stack(SANS)).toEqual(stack(value("sans")));
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
    "apps/lifelog/apps/ios/Shared/Palette.swift",
  ]);
  const read = repoFiles(
    LIFE_CODE_DIR,
    [
      "apps/server/src",
      "assets",
      "apps/mac/Sources",
      "apps/lifelog/apps/ios/Shared",
    ],
    ".ts .tsx .js .css .html .swift .json .jsonl .md".split(" ")
  );
  expect(read).toContain("apps/server/src/memory/email.ts");
  const texts = await Promise.all(read.map(asset));
  const strays = read.filter(
    (path, i) => !allowed.has(path) && HEX_COLOUR.test(texts[i] ?? "")
  );
  expect(strays).toEqual([]);
});

test("the L is one outline: the icons', the wordmark's and the menu bar's are the same", async () => {
  const outline = async (path: string) =>
    (await asset(path)).match(L_OUTLINE)?.[1];
  const l = await outline("assets/brand/life-l.svg");
  expect(l).toBeTruthy();
  expect([
    await outline("assets/brand/life.svg"),
    await outline("assets/icon/icon.svg"),
    await outline(
      "apps/lifelog/apps/ios/Lifelog/AppIcon.icon/Assets/glyph.svg"
    ),
  ]).toEqual([l, l, l]);
});
