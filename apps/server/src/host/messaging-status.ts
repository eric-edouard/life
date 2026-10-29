import { clock, DAY, HOUR, MIN } from "../core/clock";
import { isRunning } from "../core/service";
import { settings } from "../core/settings";
import { enabledSources, SOURCES } from "../memory/sources";
import { NETWORKS, type Network } from "../sources/bridged";
import type { Descriptor } from "../sources/contract";
import { isBridgeAdded } from "../sources/matrix";
import { sendBlockOf, withTimeout } from "./send";

// `bun life bridge` (docs/use/bridges.md): every messaging connector he has, checked live and in parallel, one line
// each: a spinner while it is checked, then ✓ or ✗ with what was found. A live probe of what each capability says now
// (its `missing()`, its newest message read, its bridge, its `send.blocked()`); the app's status cards judge quiet and
// failing stores over time, this doesn't.

/** One connector: its source and its bridge, either may be absent. */
export interface Connector {
  label: string;
  network?: Network;
  source?: Descriptor;
}

/** One thing checked, and what it found. */
interface Part {
  ok: boolean;
  text: string;
}

export interface Health {
  detail: string;
  ok: boolean;
}

/** Every messaging connector he has: each chat source he turned on, and each network with a bridge. */
export function connectors(): Connector[] {
  const on = enabledSources().filter((s) => s.kind === "chat");
  const names = [
    ...new Set([
      ...on.map((s) => s.name as string),
      ...NETWORKS.filter((n) => isBridgeAdded(n.name)).map(
        (n) => n.name as string
      ),
    ]),
  ];
  return names.map((name) => {
    const source = SOURCES.find((s) => s.name === name);
    return {
      label: source?.label ?? name,
      network: NETWORKS.find((n) => n.name === name),
      source,
    };
  });
}

const ago = (at: string) => {
  const ms = Math.max(0, clock().getTime() - Date.parse(at));
  if (ms < HOUR) {
    return `${Math.round(ms / MIN)} min ago`;
  }
  return ms < 2 * DAY
    ? `${Math.round(ms / HOUR)} h ago`
    : `${Math.round(ms / DAY)} d ago`;
};

async function bridgePart(
  n: Network,
  running: (job: string) => Promise<boolean>
): Promise<Part> {
  if (!isBridgeAdded(n.name)) {
    return { ok: false, text: `no bridge: bun life bridge add ${n.name}` };
  }
  return (await withTimeout(running(`bridge-${n.name}`), 10_000, false))
    ? { ok: true, text: "bridge running" }
    : { ok: false, text: "bridge stopped" };
}

/** Can Life read it: on, set up (`missing()`), its newest message read now (10 s at most). */
async function readPart(c: Connector): Promise<Part | undefined> {
  const s = c.source;
  if (!s) {
    return;
  }
  if (!enabledSources().includes(s)) {
    return c.network?.reads
      ? { ok: false, text: `not read: turn on ${s.name}` }
      : undefined;
  }
  const why = s.missing?.();
  if (why) {
    return { ok: false, text: `can't read: ${why}` };
  }
  try {
    const newest = await withTimeout(
      Promise.resolve(s.newest?.()),
      10_000,
      "late" as const
    );
    if (newest === "late") {
      return { ok: false, text: "read not answering in 10 s" };
    }
    return {
      ok: true,
      text: newest?.at ? `read, newest ${ago(newest.at)}` : "read, nothing yet",
    };
  } catch (e) {
    return { ok: false, text: `read failed: ${(e as Error).message}` };
  }
}

async function sendPart(c: Connector): Promise<Part | undefined> {
  if (!c.source?.send || (c.network && !isBridgeAdded(c.network.name))) {
    return;
  }
  const blocked = await sendBlockOf(c.source);
  if (blocked) {
    return { ok: false, text: blocked };
  }
  return {
    ok: true,
    text: settings().sends ? "sends" : "can send (sends off)",
  };
}

/** One connector checked: its parts at once, the failures first. */
export async function healthOf(
  c: Connector,
  running = isRunning
): Promise<Health> {
  const parts = (
    await Promise.all([
      c.network ? bridgePart(c.network, running) : undefined,
      readPart(c),
      sendPart(c),
    ])
  ).filter((p): p is Part => Boolean(p));
  return {
    detail: [...parts.filter((p) => !p.ok), ...parts.filter((p) => p.ok)]
      .map((p) => p.text)
      .join(", "),
    ok: parts.every((p) => p.ok),
  };
}

const FRAMES = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
const SPIN_MS = 80;

/** Checks every connector in parallel, one line each; exits 1 when one is ✗. */
export async function messagingStatus() {
  const all = connectors();
  const done: (Health | undefined)[] = all.map(() => undefined);
  const tty = Boolean(process.stdout.isTTY);
  const color = tty && !process.env.NO_COLOR;
  const mark = (h: Health) => {
    if (!color) {
      return h.ok ? "✓" : "✗";
    }
    return h.ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
  };
  const line = (i: number, at: number) => {
    const h = done[i];
    const text = `${all[i]?.label.padEnd(10)} ${h?.detail ?? "checking…"}`;
    // One terminal line each, so the redraw always moves back over exactly them.
    const width = tty
      ? (process.stdout.columns ?? 120) - 3
      : Number.POSITIVE_INFINITY;
    return `${h ? mark(h) : FRAMES[at % FRAMES.length]} ${text.length > width ? `${text.slice(0, width - 1)}…` : text}`;
  };
  let frame = 0;
  const draw = (first: boolean) => {
    process.stdout.write(
      `${first || all.length === 0 ? "" : `\x1b[${all.length}A`}${all.map((_, i) => `\x1b[2K${line(i, frame)}\n`).join("")}`
    );
  };
  const restore = () => process.stdout.write("\x1b[?25h");
  const abort = () => {
    restore();
    process.exit(130);
  };
  let spin: ReturnType<typeof setInterval> | undefined;
  if (tty) {
    process.stdout.write("\x1b[?25l");
    process.once("SIGINT", abort);
    draw(true);
    spin = setInterval(() => {
      frame += 1;
      draw(false);
    }, SPIN_MS);
  }
  await Promise.all(
    all.map(async (c, i) => {
      done[i] = await healthOf(c).catch((e: Error) => ({
        detail: e.message,
        ok: false,
      }));
    })
  );
  if (tty) {
    clearInterval(spin);
    draw(false);
    process.off("SIGINT", abort);
    restore();
  } else {
    for (const [i] of all.entries()) {
      console.log(line(i, 0));
    }
  }
  return done.every((h) => h?.ok) ? 0 : 1;
}
