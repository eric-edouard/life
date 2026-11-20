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
  /** `phone`, `closed` (the iPhone Duo folded) or `open wide|upright`. */
  pose: string;
  size: [number, number];
  state?: Record<string, unknown>;
  title: string;
}

/**
 * How the app reaches a frame: its launch arguments, then labels pressed for a state no argument reaches; or `why` it
 * can't.
 */
export interface AppFrame {
  args?: string[];
  taps?: string[];
  why?: string;
}

export const readAppFrames = () =>
  JSON.parse(readFileSync(join(DESIGN_DATA, "frames.json"), "utf8")) as Record<
    string,
    AppFrame
  >;

/** The Duo open is drawn on the closed display (`-fixturePose`), shrunk from its top left: the shot keeps that part. */
function poseOf(frame: Frame) {
  if (frame.pose === "closed") {
    return { args: [] };
  }
  const [open, way = "wide"] = frame.pose.split(" ");
  if (open !== "open") {
    throw new Error(`${frame.pose}: only the iPhone Duo's frames are shot`);
  }
  return { args: ["-fixturePose", way], ratio: frame.size[1] / frame.size[0] };
}

const device = (args: string[]) =>
  execOk(["agent-device", ...args, "--session", SESSION], {
    timeout: 120_000,
  });

async function shoot(udid: string, frame: Frame, app: AppFrame) {
  const pose = poseOf(frame);
  await launch(udid, [
    ...["-fixtureReads", DESIGN_DATA],
    ...(app.args ?? []),
    ...pose.args,
  ]);
  await Bun.sleep(5000);
  for (const label of app.taps ?? []) {
    // biome-ignore lint/performance/noAwaitInLoops: the taps run in order
    await device(["press", `label="${label}"`]);
    await Bun.sleep(1500);
  }
  const path = join(OUT, `${frame.name}.app.png`);
  await screenshot(udid, "primary", path);
  if (pose.ratio) {
    const width = Number(
      (await execOk(["sips", "-g", "pixelWidth", path])).match(PIXEL_WIDTH)?.[1]
    );
    const height = String(Math.round(width * pose.ratio));
    // sips takes an offset of 0 as none and crops the middle: the top row of pixels goes instead.
    await execOk([
      ...["sips", "-c", height, String(width), "--cropOffset", "1", "0"],
      ...[path, "--out", path],
    ]);
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
<div><figure><a href="file://${join(design, frame.png)}"><img src="file://${join(design, frame.png)}"></a><figcaption>Design</figcaption></figure>
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
  const asked = process.argv.slice(2);
  const unknown = asked.filter((name) => !map.frames[name]);
  if (unknown.length > 0) {
    throw new Error(`not in the frame map: ${unknown.join(", ")}`);
  }
  const frames = Object.values(map.frames).filter(
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
  const booted = await boot(udid);
  // The keyboard's first-use tip would cover a frame that edits a field.
  await execOk([
    ...["xcrun", "simctl", "spawn", udid, "defaults", "write"],
    ...["com.apple.keyboard.preferences", "DidShowContinuousPathIntroduction"],
    ...["-bool", "true"],
  ]);
  const outcome = new Map<string, string>();
  try {
    await install(udid, await buildApp(udid, join(OUT, "build")));
    if (mapped.some((frame) => appFrames[frame.name]?.taps)) {
      await launch(udid, ["-fixtureReads", DESIGN_DATA]);
      await device([
        "open",
        APP_ID,
        "--platform",
        "ios",
        "--device",
        SIMULATOR,
      ]);
    }
    for (const frame of mapped) {
      // biome-ignore lint/performance/noAwaitInLoops: one simulator, one frame at a time
      const result = await shoot(
        udid,
        frame,
        appFrames[frame.name] as AppFrame
      ).then(
        () => "shot",
        (e: Error) => `failed: ${e.message}`
      );
      outcome.set(frame.name, result);
      console.log(`${frame.name}: ${result}`);
    }
  } finally {
    await exec(["agent-device", "close", "--session", SESSION]);
    if (booted) {
      await shutdown(udid);
    }
  }
  writeIndex(frames, appFrames, outcome);
  console.log(join(OUT, "index.html"));
}

if (import.meta.main) {
  await main();
}
