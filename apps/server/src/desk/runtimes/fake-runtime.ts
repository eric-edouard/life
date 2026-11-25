import {
  type Run,
  type RunEnd,
  type Runtime,
  SessionLive,
  type Update,
} from "./contract";

// A runtime for tests: sessions in memory. The test plays the agent (its door calls and its turn's end) and sets what
// the runtime does: fail, forget a session, run a turn of his, end a run (with the usage it reports).

export function fakeRuntime() {
  const sessions = new Map<string, { running: boolean }>();
  /** Each session's last run, ended by `exit`. */
  const runs = new Map<string, (end: RunEnd) => void>();
  /** Each session's pending `begun`, settled by `begin` or, failing, by `exit`. */
  const begins = new Map<
    string,
    { fail: (e: Error) => void; ok: () => void }
  >();
  /** Each talking session's `onUpdate`. */
  const hearers = new Map<string, (u: Update) => void>();
  /** Set by `holdBegun`: a run is under way only when the test says. */
  let isBegunHeld = false;
  /** Sessions started, so a forgotten session's ref is never given again. */
  let startedCount = 0;
  /** Each session's last run. */
  const lastRuns = new Map<string, Run>();
  const run = (ref: string) => {
    const r = {
      begun: isBegunHeld
        ? new Promise<void>((ok, fail) => begins.set(ref, { fail, ok }))
        : Promise.resolve(),
      ended: new Promise<RunEnd>((resolve) => runs.set(ref, resolve)),
    };
    lastRuns.set(ref, r);
    return r;
  };
  const fake = {
    /** Settles the session's last run as under way (after `holdBegun`). */
    begin(ref: string) {
      begins.get(ref)?.ok();
    },
    /** Why the runtime can't run, as `Runtime.block`; none: it can. */
    blocked: undefined as string | undefined,
    /** The sessions opened on his Mac (`continueOnMac`), in order: each then runs until the test closes it. */
    continued: [] as string[],
    /** Runs inside `send` before it answers: a turn that calls the door before its runtime's CLI returns. */
    duringSend: undefined as (() => Promise<void>) | undefined,
    /** Ends the session's last run, as its process exiting: with the `usage` it reports and, failed, its `why`; `isBegunLate`: its `begun` settles just after, as a transcript poll does. */
    exit(
      ref: string,
      ok = true,
      {
        isBegunLate = false,
        usage,
        why,
      }: Partial<Omit<RunEnd, "ok">> & { isBegunLate?: boolean } = {}
    ) {
      const s = sessions.get(ref);
      if (s) {
        s.running = false;
      }
      runs.get(ref)?.({ ok, usage, why });
      if (isBegunLate) {
        begins.get(ref)?.ok();
      } else {
        begins.get(ref)?.fail(new Error("it ended before it began"));
      }
    },
    /** Plays what a talk's model says and does as it goes. */
    hear(ref: string, u: Update) {
      hearers.get(ref)?.(u);
    },
    /** From now on a run is under way only on `begin(ref)` (else it fails on `exit`), not as it is launched. */
    holdBegun() {
      isBegunHeld = true;
    },
    /** While set, `start` and `send` throw, as a CLI that fails. */
    isFailing: false as boolean,
    /** The sessions `keep` kept, in order. */
    kept: [] as string[],
    runtime: {
      block: (): Promise<string | undefined> => Promise.resolve(fake.blocked),
      cancel(ref) {
        if (sessions.get(ref)?.running && hearers.has(ref)) {
          fake.exit(ref, false, { why: "cancelled" });
        }
        return Promise.resolve();
      },
      continueOnMac(_agent, ref) {
        const s = sessions.get(ref);
        if (s) {
          s.running = true;
        }
        fake.continued.push(ref);
        return Promise.resolve();
      },
      keep(_agent, ref) {
        if (sessions.get(ref)?.running) {
          return Promise.reject(new SessionLive(`session ${ref} is running`));
        }
        fake.kept.push(ref);
        return Promise.resolve();
      },
      async send(_agent, ref, message) {
        const s = sessions.get(ref);
        if (s?.running) {
          throw new SessionLive(`session ${ref} is running`);
        }
        if (fake.isFailing || !s) {
          throw new Error(`cannot run ${ref}`);
        }
        s.running = true;
        fake.said.push({ message, ref });
        await fake.duringSend?.();
        return run(ref);
      },
      start(agent, brief) {
        if (fake.isFailing) {
          return Promise.reject(new Error("cannot start"));
        }
        startedCount += 1;
        const ref = `${agent.id}-${startedCount}`;
        sessions.set(ref, { running: true });
        fake.said.push({ message: brief, ref, title: agent.title });
        return Promise.resolve({ ...run(ref), link: `fake://${ref}`, ref });
      },
      state(ref) {
        const s = sessions.get(ref);
        if (!s) {
          return Promise.resolve("gone");
        }
        return Promise.resolve(s.running ? "running" : "idle");
      },
      stop(ref: string) {
        fake.stopped.push(ref);
        fake.exit(ref, false);
        return Promise.resolve();
      },
      talk(agent, ref, message, onUpdate) {
        if (ref && sessions.get(ref)?.running) {
          return Promise.reject(new SessionLive(`session ${ref} is running`));
        }
        if (fake.isFailing) {
          return Promise.reject(new Error("cannot talk"));
        }
        if (!ref) {
          startedCount += 1;
        }
        const r = ref ?? `${agent.id}-${startedCount}`;
        sessions.set(r, { running: true });
        hearers.set(r, onUpdate);
        fake.said.push({ message, ref: r });
        return Promise.resolve({ ...run(r), link: `fake://${r}`, ref: r });
      },
    } satisfies Runtime,
    /** Every message given to a session, in order: `start`'s brief and each `send`. */
    said: [] as { message: string; ref: string; title?: string }[],
    sessions,
    /** The sessions `stop` was called for, in order. */
    stopped: [] as string[],
  };
  return fake;
}
