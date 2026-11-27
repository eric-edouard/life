import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Variation } from "../apps/design/src/catalog";
import components from "../docs/design/components.json";
import { notBuiltIdOf, ROWS } from "./parity";

// docs/design/components.json maps each component of app v4 to the parity board row of its scene: the board's rows are
// the side panel's buttons (`panelOf`), so every button must be a variation's scene or left out with why.
const PROTO = readFileSync(
  join(
    import.meta.dir,
    "../docs/design/2026-11-23-chat-first/2026-11-25-app-v4.html"
  ),
  "utf8"
);
const side = PROTO.slice(
  PROTO.indexOf('<aside class="side">'),
  PROTO.indexOf("</aside>")
);
const BUTTON = /<button\b([^>]*)>/g;
const ID = /\bid="([^"]+)"/;
const DATA = /\b(data-[\w-]+)="([^"]*)"/;
/** As `panelOf` names a button: its id, else its first data- attribute (`panelOf` runs inside the page, so it can share no code). */
const selectorOf = (attrs: string) => {
  const id = ID.exec(attrs)?.[1];
  if (id) {
    return `#${id}`;
  }
  const data = DATA.exec(attrs);
  return data ? `[${data[1]}="${data[2]}"]` : "";
};
const panel = [...side.matchAll(BUTTON)]
  .map(([, attrs = ""]) => selectorOf(attrs))
  .filter(Boolean);
const variations: Variation[] = components.groups.flatMap(
  (g): Variation[] => g.variations
);
const rowOf = (scene: string[]) =>
  ROWS.find((r) => r.proto.join() === scene.join())?.id ??
  (scene.length === 1 ? notBuiltIdOf(scene[0] as string) : undefined);

test("every side-panel scene is a component's or left out with why", () => {
  const rows = new Set(variations.map((v) => v.row));
  const used = new Set([
    ...variations.flatMap((v) => v.scene ?? []),
    ...Object.keys(components.leftOut),
    // A variation drawn elsewhere (the Glow page's edge) names its scene's row alone.
    ...panel.filter((s) => rows.has(notBuiltIdOf(s))),
  ]);
  expect(panel.filter((s) => !used.has(s))).toEqual([]);
});

test("each variation's row is its scene's parity board row", () => {
  const boardRows = new Set(panel.map(notBuiltIdOf));
  for (const v of variations) {
    if (v.scene) {
      expect([v.name, v.row]).toEqual([v.name, rowOf(v.scene) ?? null]);
    } else if (v.row) {
      expect(boardRows).toContain(v.row);
    }
  }
});

test("each scene and part is the prototype's, and a status is typed, never In the app", () => {
  for (const v of variations) {
    for (const click of v.scene?.slice(0, 1) ?? []) {
      expect(panel).toContain(click);
    }
    expect(["next", "waiting", "designed"]).toContain(v.status);
    expect(v.status === "waiting").toBe(Boolean(v.on));
  }
});
