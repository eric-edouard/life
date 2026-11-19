import { Database } from "bun:sqlite";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { cliEnv } from "@life/server/src/core/platform";
import { exec, execOk, untilAnswers } from "@life/server/src/core/proc";

// The demo's stress test, `bun run e2e:demo [scenario]`: a made-up Life (`scripts/demo.ts`) runs as a second Life on this
// Mac (its own ports and machine folder), the phone app is built and paired in a fresh simulator, and a scenario's steps
// are driven with agent-device, a real Claude agent at the desk. Each step leaves a numbered screenshot and a PASS or
// FAIL line in the folder printed at the end; everything started is stopped and removed, on failure too. Out of
// `bun run check`: it takes minutes, the simulator and a real agent's turns (docs/operations.md, "Demo stress tests").

/**
 * One step: an action (tap a label, open the first row holding a text, go back, wait for the agent's turns to end),
 * then what must show (`until`) or be gone (`gone`). `refresh` reopens the app between looks, as a push would.
 */
interface Step {
  back?: boolean;
  gone?: string;
  name: string;
  open?: string;
  refresh?: boolean;
  tap?: string;
  /** Wait until the agent has ended this many turns. */
  turnsEnded?: number;
  until?: string;
  waitS?: number;
}

/** The new matter the demo holds, found to closed: Start, the plan card's Go, the agent's work, Mark as done. */
const FOUND_TO_CLOSED: Step[] = [
  {
    name: "inbox offers the new matter",
    refresh: true,
    until: "Start an agent on this?",
  },
  {
    name: "Start: goal saved, runtime, session, first turn",
    tap: "Start",
    until: "Its first turn has begun, done",
    waitS: 180,
  },
  { name: "back to the inbox", tap: "Done", until: "Inbox" },
  { name: "the agent's first turn ends", turnsEnded: 1, waitS: 600 },
  { name: "its plan card: Go, Change, Stop", refresh: true, until: "Change" },
  { name: "Go", tap: "Go", until: "knows, and goes on, done" },
  { name: "back to the inbox after Go", tap: "Done", until: "Inbox" },
  { name: "the agent works after Go", turnsEnded: 2, waitS: 900 },
  { name: "what the agent asked next", refresh: true, until: "Inbox" },
  {
    name: "the matters list",
    tap: "Matters",
    until: "The leaking kitchen tap",
  },
  {
    name: "the matter's page",
    open: "The leaking kitchen tap",
    until: "Mark as done",
  },
  { name: "Mark as done", tap: "Mark as done", until: "Marked as done" },
  {
    back: true,
    gone: "The leaking kitchen tap",
    name: "the matter leaves the list",
    refresh: true,
  },
  {
    name: "its cards leave the inbox",
    refresh: true,
    tap: "Inbox",
    until: "Nothing",
  },
];

/** Every scenario, by name; add one here. */
const SCENARIOS: Record<string, Step[]> = {
  "found-to-closed": FOUND_TO_CLOSED,
};

const name = process.argv[2] ?? "found-to-closed";
const steps = SCENARIOS[name];
if (!steps) {
  console.error(
    `usage: bun run e2e:demo [${Object.keys(SCENARIOS).join("|")}]`
  );
  process.exit(2);
}
const REPO = join(import.meta.dir, "..");
/** The demo's public port (its local and door ports follow); the demo's own `portOf` checks it. */
const PORT = Number(process.env.LIFE_E2E_PORT ?? 46_500);
// Its real path: Life and Claude name folders by it.
const root = realpathSync(mkdtempSync(join(tmpdir(), "life-e2e-")));
const shots = join(root, "screens");
mkdirSync(shots);
const demo = join(root, "demo");
// The demo's services and its agent get no secret of his: the variables a CLI needs and the demo's own.
const env = {
  ...cliEnv(),
  LIFE_MACHINE_DIR: join(demo, "machine"),
  LIFE_OWNER_DATA_DIR: join(demo, "data"),
  LIFE_PORT: String(PORT),
  LIFE_STATE_DIR: join(demo, "state"),
  NODE_ENV: "",
};
const session = `life-e2e-${process.pid}`;
const door = `127.0.0.1:${PORT + 2}/mcp`;
const life = (args: string[]) =>
  execOk(["bun", join(REPO, "apps/server/src/desk/life-entry.ts"), ...args], {
    env,
  });
const device = (args: string[], timeout = 120_000) =>
  execOk(["agent-device", ...args, "--session", session], { timeout });
const shown = () => device(["snapshot"]);
const services: Bun.Subprocess[] = [];
const NOT_WORD = /[^A-Za-z0-9]/g;
let sim = "";

/** The newest iOS runtime's first iPhone: an older runtime may be a beta that lacks the SDK's APIs, and the app dies. */
async function newSimulator() {
  const { runtimes } = JSON.parse(
    await execOk(["xcrun", "simctl", "list", "runtimes", "-j"])
  ) as {
    runtimes: {
      identifier: string;
      platform: string;
      supportedDeviceTypes: { identifier: string; productFamily: string }[];
    }[];
  };
  const newest = runtimes.filter((r) => r.platform === "iOS").at(-1);
  const phone = newest?.supportedDeviceTypes.find(
    (d) => d.productFamily === "iPhone"
  );
  if (!(newest && phone)) {
    throw new Error("no iOS runtime with an iPhone");
  }
  return (
    await execOk([
      "xcrun",
      "simctl",
      "create",
      session,
      phone.identifier,
      newest.identifier,
    ])
  ).trim();
}

async function setUp() {
  if (await fetch(`http://127.0.0.1:${PORT}/`).catch(() => null)) {
    throw new Error(`port ${PORT} is taken: set LIFE_PORT`);
  }
  await execOk(["bun", join(REPO, "scripts/demo.ts"), demo], { env });
  for (const service of ["watch", "desk"]) {
    const log = openSync(join(root, `${service}.log`), "w");
    services.push(
      Bun.spawn(
        ["bun", join(REPO, "apps/server/src/desk/life-entry.ts"), service],
        { env, stderr: log, stdout: log }
      )
    );
  }
  await untilAnswers(
    () => fetch(`http://127.0.0.1:${PORT}/`).then(() => true),
    "the demo Life"
  );
  sim = await newSimulator();
  await execOk(["bun", "run", "ios:project"], { cwd: REPO });
  await execOk(
    [
      "xcodebuild",
      ...["-project", "apps/lifelog/apps/ios/Lifelog.xcodeproj"],
      ...["-scheme", "Lifelog", "-configuration", "Debug"],
      ...["-destination", `id=${sim}`, "-derivedDataPath", join(root, "dd")],
      "build",
      "-quiet",
    ],
    { cwd: REPO, timeout: 30 * 60_000 }
  );
  await execOk(["xcrun", "simctl", "boot", sim]);
  await execOk(["xcrun", "simctl", "bootstatus", sim, "-b"], {
    timeout: 300_000,
  });
  const app = join(root, "dd/Build/Products/Debug-iphonesimulator/lifelog.app");
  await execOk(["xcrun", "simctl", "install", sim, app]);
  await device(
    [
      "open",
      "com.ericedouard.lifelog",
      "--platform",
      "ios",
      "--device",
      session,
    ],
    300_000
  );
  const link = (await life(["pair", "--link"])).trim();
  await execOk(["xcrun", "simctl", "openurl", sim, link]);
  await device(["wait", 'label="Open"', "30000"]);
  await device(["press", 'label="Open"']);
  await device(["wait", 'label="Pair this phone"', "30000"]);
  await device(["press", 'label="Pair this phone"']);
  await device(["wait", 'label="Done"', "60000"]);
  await device(["press", 'label="Done"']);
}

/** The desk's turns that ended, from its store. */
function turnsEnded() {
  const path = join(env.LIFE_STATE_DIR, "desk/desk.sqlite");
  if (!existsSync(path)) {
    return 0;
  }
  const db = new Database(path, { readonly: true });
  try {
    return (
      db
        .query<{ n: number }, []>(
          "select count(*) as n from turn where ended_at is not null"
        )
        .get()?.n ?? 0
    );
  } finally {
    db.close();
  }
}

async function run(step: Step) {
  if (step.tap) {
    await device(["press", `label="${step.tap}"`]);
  }
  const row = step.open;
  if (row) {
    // A row below a short screen (the iPhone Duo's) is scrolled to first.
    await device(["find", row, "click", "--first"]).catch(async () => {
      await device(["scroll", "down"]);
      await device(["find", row, "click", "--first"]);
    });
  }
  if (step.back) {
    // The system's back button by name: agent-device's `back` pressed the Pendant pill on the iPhone Duo.
    await device(["find", "BackButton", "click"]);
  }
  await untilAnswers(
    async () => {
      if (step.refresh) {
        // Another app in front sends the app to the background; Home doesn't on the iPhone Duo.
        await execOk([
          "xcrun",
          "simctl",
          "launch",
          sim,
          "com.apple.Preferences",
        ]);
        await device(["open", "com.ericedouard.lifelog"]);
      }
      const ok =
        (step.turnsEnded === undefined || turnsEnded() >= step.turnsEnded) &&
        (!(step.until || step.gone) ||
          (await shown().then(
            (text) =>
              (!step.until || text.includes(step.until)) &&
              !(step.gone && text.includes(step.gone))
          )));
      if (!ok) {
        await Bun.sleep(4000);
      }
      return ok || undefined;
    },
    step.name,
    Math.ceil((step.waitS ?? 60) / 5)
  );
}

/**
 * Stops and removes everything the run started, once: the services first (so the desk starts no new turn), then the
 * agent, the simulator, the demo and its transcripts.
 */
let down: Promise<void> | undefined;
const tearDown = () => {
  down ??= stopAll();
  return down;
};
async function stopAll() {
  for (const s of services) {
    s.kill();
  }
  await Promise.all(services.map((s) => s.exited));
  await exec(["pkill", "-f", door]);
  await exec(["agent-device", "close", "--session", session]);
  if (sim) {
    await exec(["xcrun", "simctl", "shutdown", sim]);
    await exec(["xcrun", "simctl", "delete", sim]);
  }
  // Claude keeps a copy's transcripts under its folder's path; the folder is gone with the demo.
  const projects = join(homedir(), ".claude", "projects");
  const slug = join(env.LIFE_STATE_DIR, "desk/agents").replace(NOT_WORD, "-");
  for (const dir of new Bun.Glob(`${slug}-*`).scanSync({
    cwd: projects,
    onlyFiles: false,
  })) {
    rmSync(join(projects, dir), { force: true, recursive: true });
  }
  rmSync(demo, { force: true, recursive: true });
  rmSync(join(root, "dd"), { force: true, recursive: true });
}

for (const [signal, code] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
] as const) {
  process.on(signal, () => tearDown().then(() => process.exit(code)));
}
const results = join(root, "results.txt");
const say = (line: string) => {
  console.log(line);
  appendFileSync(results, `${line}\n`);
};
let failed = false;
try {
  const start = performance.now();
  await setUp();
  say(
    `PASS 00 set up: demo Life on ${PORT}, app built, paired (${Math.round((performance.now() - start) / 1000)} s)`
  );
  for (const [i, step] of steps.entries()) {
    const n = String(i + 1).padStart(2, "0");
    const t = performance.now();
    // biome-ignore lint/performance/noAwaitInLoops: the steps run in order
    const error = await run(step).then(
      () => null,
      (e: Error) => e.message
    );
    // simctl names the display: agent-device's screenshot fails on a phone with two (the iPhone Duo).
    await exec([
      ...["xcrun", "simctl", "io", sim, "screenshot", "--display=primary"],
      join(shots, `${n}-${step.name.replace(/\W+/g, "-")}.png`),
    ]);
    say(
      `${error ? "FAIL" : "PASS"} ${n} ${step.name} (${Math.round((performance.now() - t) / 1000)} s)${error ? `: ${error}` : ""}`
    );
    if (error) {
      failed = true;
      break;
    }
  }
} catch (e) {
  failed = true;
  say(`FAIL set up: ${(e as Error).message}`);
} finally {
  await tearDown();
}
console.log(
  `${failed ? "FAILED" : "PASSED"}: ${results}, screenshots in ${shots}`
);
process.exit(failed ? 1 : 0);
