// The app's screen against the designer's frame, both as text (`bun run design:shots <Frame> --compare <dir>`): the frame
// is `<dir>/<Frame>.html`, written by the designer's `render_frames.py --spec` (`bun run design:export`); the screen is the
// simulator's accessibility tree with its frames (agent-device). What VoiceOver can read is compared: labels and text, where
// they sit and how big they are. Colours and type are in the frame's `t` tokens for the builder; the tree carries none.

/** One element of the frame VoiceOver would read: its name (label, else text) and box in the frame's points. */
export interface DesignElement {
  box: [number, number, number, number];
  name: string;
}

/** One node of the app's tree, as agent-device gives it. */
export interface ScreenNode {
  label?: string;
  rect?: { height: number; width: number; x: number; y: number };
  type?: string;
  value?: string;
}

const LINE = /^\s*<(\w+) ([^>]*)>([^<]*)/;
const ATTR = /([\w-]+)(?:="([^"]*)")?/g;
const FRAME_SIZE = /<frame [^>]*w="(\d+)" h="(\d+)"/;
const unescaped = (text: string) =>
  text
    .replace(/&lt;/g, "<")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");

/** The frame's size and the elements VoiceOver reads, from the frame's text (one element per line). */
export function parseFrame(html: string) {
  const size = html.match(FRAME_SIZE);
  if (!size) {
    throw new Error("not a frame spec: no <frame w h> line");
  }
  const [w, h] = [Number(size[1]), Number(size[2])];
  const elements: DesignElement[] = [];
  for (const line of html.split("\n")) {
    const m = line.match(LINE);
    if (!m || m[1] === "frame") {
      continue;
    }
    const attrs = Object.fromEntries(
      [...(m[2] as string).matchAll(ATTR)].map((a) => [a[1], a[2] ?? ""])
    );
    const name = spoken(unescaped(attrs.label || (m[3] as string)));
    const box = (attrs.box ?? "").split(" ").map(Number);
    const [x, y, bw, bh] = box as [number, number, number, number];
    // Off the screen (a list running on under its edge) is not on the screen to compare.
    const isOnScreen = x < w && y < h && x + bw > 0 && y + bh > 0;
    if (name && !("ax-hidden" in attrs) && box.length === 4 && isOnScreen) {
      elements.push({ box: [x, y, bw, bh], name });
    }
  }
  return { elements, size: [w, h] as [number, number] };
}

/**
 * The frame's points to the screen's: a pose drawn on the closed display (`-fixturePose`) is shrunk to its width and
 * centred down it, as the shots crop it. A phone frame is drawn on another screen: no place to compare, names only.
 */
export function placementOf(
  frame: [number, number],
  screen: [number, number],
  pose: string
) {
  if (pose === "phone") {
    return;
  }
  const scale = screen[0] / frame[0];
  return { dy: (screen[1] - frame[1] * scale) / 2, scale };
}

/** Words as read: one space, straight quotes (the frames type ' where iOS sets ’). */
export const spoken = (text: string) =>
  text.replace(/\s+/g, " ").replace(/[‘’]/g, "'").replace(/[“”]/g, '"').trim();

const nameOf = (node: ScreenNode) => spoken(node.label || node.value || "");

/** VoiceOver reads a row's parts as one label, joined by commas ("Camille Vance, Partner"): a name is one of those parts. */
const isReadIn = (label: string, name: string) =>
  `, ${label}, `.includes(`, ${name}, `);

/** The app and its window frame everything: they are where things are, not things. */
const FRAMES = new Set(["Application", "Window"]);

interface Placement {
  dy: number;
  scale: number;
}
type Box = number[];

/** A frame's box in the screen's points (as drawn when there is no placement). */
const placed = ([x, y, w, h]: DesignElement["box"], placement?: Placement) =>
  placement
    ? [
        x * placement.scale,
        y * placement.scale + placement.dy,
        w * placement.scale,
        h * placement.scale,
      ].map(Math.round)
    : [x, y, w, h];

const rectOf = ({ rect }: ScreenNode): Box =>
  rect ? [rect.x, rect.y, rect.width, rect.height].map(Math.round) : [];

/** Off by more than `tolerance`: the same box when the name is the element's own, else within the element that reads it. */
const isOff = (want: Box, got: Box, isOwn: boolean, tolerance: number) => {
  const [wx = 0, wy = 0, ww = 0, wh = 0] = want;
  const [gx = 0, gy = 0, gw = 0, gh = 0] = got;
  return isOwn
    ? want.some((v, i) => Math.abs(v - (got[i] ?? 0)) > tolerance)
    : wx < gx - tolerance ||
        wy < gy - tolerance ||
        wx + ww > gx + gw + tolerance ||
        wy + wh > gy + gh + tolerance;
};

/**
 * The gaps between the frame and the screen, one line each: an element of the frame the screen lacks, one the screen has
 * that the frame lacks, one placed or sized off by more than `tolerance` points. A name the screen reads inside a longer
 * label (a row read as "Camille Vance, Partner") counts as there, its box within that element's.
 */
export function gapsOf(
  design: DesignElement[],
  screen: ScreenNode[],
  placement: Placement | undefined,
  tolerance = 4
) {
  const named = screen.filter(
    (node) => nameOf(node) && node.rect && !FRAMES.has(node.type ?? "")
  );
  const used = new Set<ScreenNode>();
  const gaps: string[] = [];
  for (const element of design) {
    const own = named.find(
      (node) => nameOf(node) === element.name && !used.has(node)
    );
    const reader =
      own ?? named.find((node) => isReadIn(nameOf(node), element.name));
    const want = placed(element.box, placement);
    if (!reader) {
      gaps.push(`missing  "${element.name}" at ${want.join(" ")}`);
      continue;
    }
    used.add(reader);
    const got = rectOf(reader);
    if (placement && isOff(want, got, Boolean(own), tolerance)) {
      const inside = own ? "" : ` (inside "${nameOf(reader)}")`;
      gaps.push(
        `off      "${element.name}" frame ${want.join(" ")}, app ${got.join(" ")}${inside}`
      );
    }
  }
  // One line per name the frame lacks, at its innermost node (a cell, its row and its text are read alike).
  const extras = new Map<string, ScreenNode>();
  for (const node of named) {
    const name = nameOf(node);
    const isDesigned = design.some((element) => isReadIn(name, element.name));
    const area = ({ rect }: ScreenNode) =>
      rect ? rect.width * rect.height : 0;
    const kept = extras.get(name);
    if (!(used.has(node) || isDesigned) && (!kept || area(node) < area(kept))) {
      extras.set(name, node);
    }
  }
  for (const [name, node] of extras) {
    gaps.push(
      `extra    "${name}" (${node.type ?? "?"}) at ${rectOf(node).join(" ")}`
    );
  }
  return gaps;
}
