import { expect, test } from "bun:test";
import { gapsOf, parseFrame, placementOf } from "./design-compare";

const FRAME = `<!-- A: made up. -->
<frame name="A" pose="closed" w="466" h="678">
  <main box="0 28 382 650">
    <h1 box="20 28 72 26" t="fg:fg 22/700">People</h1>
    <a box="14 120 360 64">
      <span box="80 132 252 20" t="fg:fg T_ROW">Ana Lind</span>
      <span ax-hidden box="28 132 40 40">AL</span>
    </a>
    <button label="Sort &amp; filter" box="400 174 44 44"></button>
    <span box="80 900 252 20">Below the edge</span>
  </main>
</frame>`;

test("a frame's text gives the elements VoiceOver reads on the screen", () => {
  const { elements, size } = parseFrame(FRAME);
  expect(size).toEqual([466, 678]);
  expect(elements.map((e) => e.name)).toEqual([
    "People",
    "Ana Lind",
    "Sort & filter",
  ]);
});

test("the gaps: missing, extra, off, and a name read inside a longer label", () => {
  const { elements, size } = parseFrame(FRAME);
  const gaps = gapsOf(
    elements,
    [
      { label: "People", rect: { height: 26, width: 72, x: 20, y: 40 } },
      {
        label: "Ana Lind, Client",
        rect: { height: 64, width: 360, x: 14, y: 120 },
      },
      { label: "Search", rect: { height: 44, width: 44, x: 400, y: 600 } },
    ],
    placementOf(size, [466, 678], "closed")
  );
  expect(gaps).toEqual([
    'off      "People" frame 20 28 72 26, app 20 40 72 26',
    'missing  "Sort & filter" at 400 174 44 44',
    'extra    "Search" (?) at 400 600 44 44',
  ]);
});

test("an open pose drawn on the closed screen is shrunk and centred; a phone frame compares names only", () => {
  expect(placementOf([951, 669], [466, 678], "open wide")).toEqual({
    dy: (678 - 669 * (466 / 951)) / 2,
    scale: 466 / 951,
  });
  expect(placementOf([390, 844], [466, 678], "phone")).toBeUndefined();
});
