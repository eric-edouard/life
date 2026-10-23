import { statSync } from "node:fs";
import { basename } from "node:path";
import { clock, MIN } from "../core/clock";
import { readSecretEnv, SECRETS } from "../core/secret";
import { SETTINGS } from "../core/settings";

// `bun life headless`: what Life.app's Supervisor does (apps/mac/Sources/LifeApp/Supervisor.swift), without the app, as
// a server container's command. The archive and the watcher always running (started again 5 s after either stops: new
// code, a crash), the nightly tick every 30 minutes (its own schedule decides what is due, one at a time), and the
// server's keys (`SECRETS.env`) in their environment, as the app passes the Keychain's. Settings and keys are read once
// per process, so when either file changes each service starts again (a nightly running finishes on what it started
// with). A SIGTERM or SIGINT ends every child, then this.

const SERVICES = [["archive"], ["watch"]];
const TICK_MS = 30 * MIN;
const RESTART_MS = 5000;
/** How often the settings and the keys are looked at for a change. */
const LOOK_MS = 5000;

/** This program as a command: the compiled helper alone, or bun with the CLI's file. */
const self = () =>
  basename(process.execPath).startsWith("bun")
    ? [process.execPath, Bun.main]
    : [process.execPath];

const stamp = (paths: string[]) =>
  paths
    .map((p) => {
      try {
        return statSync(p).mtimeMs;
      } catch {
        return 0;
      }
    })
    .join(" ");

export async function headless(): Promise<number> {
  const services = new Map<string, Bun.Subprocess>();
  let nightly: Bun.Subprocess | undefined;
  /** Set once a signal came: nothing starts again. */
  const stopping = new AbortController();
  /** The children still running (an exit code is null after a signal too, so it can't tell). */
  const running = new Set<Bun.Subprocess>();
  const start = (args: string[]) => {
    const p = Bun.spawn([...self(), ...args], {
      env: { ...process.env, ...readSecretEnv() },
      stderr: "inherit",
      stdout: "inherit",
    });
    running.add(p);
    p.exited.then(() => running.delete(p));
    return p;
  };
  const keep = (args: string[]) => {
    const name = args.join(" ");
    const p = start(args);
    services.set(name, p);
    p.exited.then(async () => {
      await Bun.sleep(RESTART_MS);
      if (!stopping.signal.aborted && services.get(name) === p) {
        keep(args);
      }
    });
  };
  const tick = () => {
    if (stopping.signal.aborted || (nightly && running.has(nightly))) {
      return;
    }
    nightly = start(["memory", "nightly"]);
  };
  const end = (p: Bun.Subprocess | undefined) => {
    if (p && running.has(p)) {
      p.kill("SIGTERM");
    }
    return p?.exited;
  };

  for (const args of SERVICES) {
    keep(args);
  }
  tick();
  const ticks = setInterval(tick, TICK_MS);
  let seen = stamp([SETTINGS, SECRETS.env]);
  const looks = setInterval(() => {
    const now = stamp([SETTINGS, SECRETS.env]);
    if (now === seen) {
      return;
    }
    seen = now;
    console.log(
      `${clock().toISOString()} settings or keys changed: restarting the services`
    );
    // Each ends, and `keep` starts it again on what the files say now.
    for (const p of services.values()) {
      end(p);
    }
  }, LOOK_MS);

  const signal = await new Promise<string>((resolve) => {
    for (const s of ["SIGTERM", "SIGINT"] as const) {
      process.on(s, () => resolve(s));
    }
  });
  stopping.abort();
  clearInterval(ticks);
  clearInterval(looks);
  console.log(`${clock().toISOString()} ${signal}: stopping`);
  await Promise.all([...services.values(), nightly].map(end));
  return 0;
}
