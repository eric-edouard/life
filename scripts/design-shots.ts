import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { exec, execOk } from "@life/server/src/core/proc";
import {
  APP_ID,
  boot,
  buildApp,
  createSimulator,
  findSimulator,
  install,
  launch,
  screenshot,
  shutdown,
} from "./simulator";

// `bun run design:shots [Frame…]`: the app's picture of each frame the designer drew, beside the drawing, for the design
// review (`apps/lifelog/apps/ios/design-review.md`). The frames are the designer's frame map (`LIFE_FRAME_MAP`); how the
// app reaches each is the repo's half, `frames.json` beside the design data. Writes `derived/design-shots/<Frame>.app.png`
// and `derived/design-shots/index.html`, the pairs side by side.

const REPO = join(import.meta.dir, "..");
export const FRAME_MAP =
  process.env.LIFE_FRAME_MAP ??
  join(homedir(), "Life/docs/product/app-design/frame-map.json");
export const DESIGN_DATA = join(REPO, "apps/lifelog/fixtures/design");
const OUT = join(REPO, "derived/design-shots");
const SIMULATOR = "iPhone Duo";
const SESSION = "design-shots";
const PIXEL_WIDTH = /pixelWidth: (\d+)/;

/** A frame as the designer's map has it. */
interface Frame {
  name: string;
  png: string;
  /** `phone` (drawn on the folded iPhone Duo's screen), `closed` (the Duo folded) or `open wide|upright`. */
  pose: string;
  size: [number, number];
  state?: Record<string, unknown>;
  title: string;
}

/**
 * How the app reaches a frame: its launch arguments, then labels pressed for a state no argument reaches, then text typed
 * into the field a label names (`fill`: label, text), then a scroll to an edge (`scroll`); or `why` it can't.
 */
export interface AppFrame {
  args?: string[];
  /** Why the designer has no drawing of this frame (a tap's result): it is shot, with no design beside it. */
  drawing?: string;
  fill?: [string, string];
  /** A label the screen shows once it is the frame's own (default: the Inbox gone for a route, the screen settled). */
  ready?: string;
  /** `top` or `bottom`: the page scrolled to that edge, after the taps. */
  scroll?: string;
  taps?: string[];
  why?: string;
}

export const readAppFrames = () =>
  JSON.parse(readFileSync(join(DESIGN_DATA, "frames.json"), "utf8")) as Record<
    string,
    AppFrame
  >;

/**
 * The Duo open is drawn on the closed display (`-fixturePose`), shrunk to its width and centred down it, clear of the
 * system's clock at the top of the side column: the shot keeps that part.
 */
function poseOf(frame: Frame) {
  if (frame.pose === "closed" || frame.pose === "phone") {
    return { args: [] };
  }
  const [open, way = "wide"] = frame.pose.split(" ");
  if (open !== "open") {
    throw new Error(`${frame.pose}: only the phone and Duo frames are shot`);
  }
  return { args: ["-fixturePose", way], ratio: frame.size[1] / frame.size[0] };
}

/** `design:shots [Frame…] [--app <built app>] [--shutdown]`: the frames asked, an app already built, whether to stop the simulator after. */
export function parseArgs(argv: string[]) {
  const at = argv.indexOf("--app");
  return {
    app: at === -1 ? undefined : argv[at + 1],
    asked: argv.filter(
      (arg, i) => !arg.startsWith("--") && (at === -1 || i !== at + 1)
    ),
    shutdownAfter: argv.includes("--shutdown"),
  };
}

const device = (args: string[]) =>
  execOk(["agent-device", ...args, "--session", SESSION], {
    timeout: 120_000,
  });

/** The launch flags that open a full-screen route. */
export const ROUTE_FLAGS = new Set([
  "-fixtureMatter",
  "-fixturePage",
  "-fixtureParked",
  "-fixturePerson",
  "-fixtureTab",
]);
const SCREEN_WAIT = 90_000;

/** The accessibility tree as text, less the warning line that counts snapshots. */
const readScreen = async () =>
  (await device(["snapshot"]))
    .split("\n")
    .filter((line) => !line.startsWith("Warning"))
    .join("\n");

/**
 * Waits for the screen the frame asked for, never a fixed time: the frame's own `ready` label on screen, and in every
 * case the tree the same on two reads in a row (the reads settled).
 */
async function waitForScreen(app: AppFrame) {
  const start = performance.now();
  let before = "";
  while (performance.now() - start < SCREEN_WAIT) {
    // biome-ignore lint/performance/noAwaitInLoops: each read waits on the last
    const now = await readScreen();
    const isThere = app.ready ? now.includes(app.ready) : true;
    if (isThere && now === before) {
      return;
    }
    before = now;
  }
  throw new Error(
    `the screen never settled${app.ready ? ` on "${app.ready}"` : ""}`
  );
}

const press = async (labels: string[]) => {
  for (const label of labels) {
    // A sheet may still be coming: wait for the label before pressing it.
    // biome-ignore lint/performance/noAwaitInLoops: the taps run in order
    await device(["wait", "text", label, "15000"]);
    await device(["press", `label="${label}"`]);
    await Bun.sleep(1500);
  }
};

async function shoot(udid: string, frame: Frame, app: AppFrame) {
  const pose = poseOf(frame);
  await launch(udid, [
    ...["-fixtureReads", DESIGN_DATA],
    ...(app.args ?? []),
    ...pose.args,
  ]);
  await waitForScreen(app);
  await press(app.taps ?? []);
  if (app.fill) {
    const [label, text] = app.fill;
    await device(["fill", `label="${label}"`, text]);
    await Bun.sleep(1500);
  }
  if (app.scroll) {
    await device(["scroll", app.scroll]);
    await Bun.sleep(1000);
  }
  const path = join(OUT, `${frame.name}.app.png`);
  await screenshot(udid, "primary", path);
  if (pose.ratio) {
    const width = Number(
      (await execOk(["sips", "-g", "pixelWidth", path])).match(PIXEL_WIDTH)?.[1]
    );
    const height = String(Math.round(width * pose.ratio));
    // sips crops the middle (its offset is ignored): the pose is drawn there.
    await execOk(["sips", "-c", height, String(width), path, "--out", path]);
  }
}

const escaped = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** A frame's state in words: "sheet: New person · button: working, Attaching 3 mentions…". */
const stateWords = (state: Record<string, unknown> = {}) =>
  Object.entries(state)
    .map(
      ([key, value]) =>
        `${key}: ${typeof value === "object" && value ? Object.values(value).flat().join(", ") : String(value)}`
    )
    .join(" · ");

function writeIndex(
  frames: Frame[],
  appFrames: Record<string, AppFrame>,
  outcome: Map<string, string>
) {
  const design = dirname(FRAME_MAP);
  const rows = frames.map((frame) => {
    const why = appFrames[frame.name]?.why;
    const result =
      outcome.get(frame.name) ?? `not mapped${why ? `: ${why}` : ""}`;
    const app =
      result === "shot"
        ? `<a href="${frame.name}.app.png"><img src="${frame.name}.app.png"></a>`
        : `<p class="missing">${escaped(result)}</p>`;
    return `<section><h2>${escaped(frame.name)} <small>${escaped(frame.title)}</small></h2>
<p>${escaped(`${frame.pose} ${frame.size.join("x")}`)}${frame.state ? ` · ${escaped(stateWords(frame.state))}` : ""}</p>
<div>${frame.png ? `<figure><a href="file://${join(design, frame.png)}"><img src="file://${join(design, frame.png)}"></a><figcaption>Design</figcaption></figure>` : ""}
<figure>${app}<figcaption>App</figcaption></figure></div></section>`;
  });
  writeFileSync(
    join(OUT, "index.html"),
    `<!doctype html><meta charset="utf-8"><title>Design shots</title>
<style>body{font:14px system-ui;margin:24px}section{margin-bottom:40px}h2 small{font-weight:400;color:#666}
div{display:flex;gap:24px;align-items:flex-start}figure{margin:0}img{width:420px;border:1px solid #ddd}
.missing{width:420px;color:#a00}</style>
${rows.join("\n")}`
  );
}

async function main() {
  const map = JSON.parse(readFileSync(FRAME_MAP, "utf8")) as {
    frames: Record<string, Frame>;
  };
  const appFrames = readAppFrames();
  const {
    asked,
    app: builtApp,
    shutdownAfter,
  } = parseArgs(process.argv.slice(2));
  const unknown = asked.filter(
    (name) => !(map.frames[name] || appFrames[name]?.drawing)
  );
  if (unknown.length > 0) {
    throw new Error(`not in the frame map: ${unknown.join(", ")}`);
  }
  const undrawn = Object.entries(appFrames)
    .filter(([, app]) => app.drawing)
    .map(([name, app]) => ({
      name,
      png: "",
      pose: "closed",
      size: [0, 0] as [number, number],
      title: app.drawing as string,
    }));
  const frames = [...Object.values(map.frames), ...undrawn].filter(
    (frame) => asked.length === 0 || asked.includes(frame.name)
  );
  const mapped = frames.filter((frame) => appFrames[frame.name]?.args);
  mkdirSync(OUT, { recursive: true });
  for (const frame of frames) {
    rmSync(join(OUT, `${frame.name}.app.png`), { force: true });
  }
  const udid =
    (await findSimulator(SIMULATOR))?.udid ??
    (await createSimulator(
      SIMULATOR,
      "com.apple.CoreSimulator.SimDeviceType.iPhone-Duo"
    ));
  await boot(udid);
  // The frames are drawn dark.
  await execOk(["xcrun", "simctl", "ui", udid, "appearance", "dark"]);
  // The keyboard's first-use tip would cover a frame that edits a field.
  await execOk([
    ...["xcrun", "simctl", "spawn", udid, "defaults", "write"],
    ...["com.apple.keyboard.preferences", "DidShowContinuousPathIntroduction"],
    ...["-bool", "true"],
  ]);
  const outcome = new Map<string, string>();
  try {
    await install(udid, builtApp ?? (await buildApp(udid, join(OUT, "build"))));
    // The microphone's alert at launch would cover every frame: granted, never reset (the simulator is shared).
    await execOk([
      "xcrun",
      "simctl",
      "privacy",
      udid,
      "grant",
      "microphone",
      APP_ID,
    ]);
    // The session reads the screen to know a frame is there, so every run opens it.
    await launch(udid, ["-fixtureReads", DESIGN_DATA, "-fixtureLife", "ok"]);
    await device(["open", APP_ID, "--platform", "ios", "--device", SIMULATOR]);
    for (const frame of mapped) {
      const app = appFrames[frame.name] as AppFrame;
      // Once more on a miss: the first taps after a boot can find the app still settling.
      // biome-ignore lint/performance/noAwaitInLoops: one simulator, one frame at a time
      const result = await shoot(udid, frame, app)
        .catch(() => shoot(udid, frame, app))
        .then(
          () => "shot",
          (e: Error) => `failed: ${e.message}`
        );
      outcome.set(frame.name, result);
      console.log(`${frame.name}: ${result}`);
    }
  } finally {
    // The simulator stays booted for the next run; `--shutdown` stops it (agent-device's runner boots it again unless its
    // close shuts it down too).
    await exec([
      ...["agent-device", "close", "--session", SESSION],
      ...(shutdownAfter ? ["--shutdown"] : []),
    ]);
    if (shutdownAfter) {
      await shutdown(udid);
    }
  }
  writeIndex(frames, appFrames, outcome);
  console.log(join(OUT, "index.html"));
  // The index keeps every pair; a mapped frame that failed fails the run.
  if ([...outcome.values()].some((result) => result !== "shot")) {
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  await main();
}
