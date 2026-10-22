import { expect, test } from "bun:test";
import { C } from "./memory/email";

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

test("the email's colours are tokens.css's", () => {
  for (const [name, value] of Object.entries(C)) {
    expect([name, value]).toEqual([name, light[name] ?? "not a token"]);
  }
});

test("the app's colours are tokens.css's, light and dark", async () => {
  const swift = await asset("app/Sources/LifeApp/Brand.swift");
  // Brand's names for the tokens it copies, then each Tone's status token.
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
