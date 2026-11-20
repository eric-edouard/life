import type { RunEnd, Runtime } from "./contract";

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
  /** Set by `holdBegun`: a run is under way only when the test says. */
  let isBegunHeld = false;
  const run = (ref: string) => ({
    begun: isBegunHeld
      ? new Promise<void>((ok, fail) => begins.set(ref, { fail, ok }))
      : Promise.resolve(),
    ended: new Promise<RunEnd>((resolve) => runs.set(ref, resolve)),
  });
  const fake = {
    /** Settles the session's last run as under way (after `holdBegun`). */
    begin(ref: string) {
      begins.get(ref)?.ok();
    },
    /** Why the runtime can't run, as `Runtime.block`; none: it can. */
    blocked: undefined as string | undefined,
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
    /** From now on a run is under way only on `begin(ref)` (else it fails on `exit`), not as it is launched. */
    holdBegun() {
      isBegunHeld = true;
    },
    /** While set, `start` and `send` throw, as a CLI that fails. */
    isFailing: false as boolean,
    runtime: {
      block: (): Promise<string | undefined> => Promise.resolve(fake.blocked),
      async send(_agent, ref, message) {
        const s = sessions.get(ref);
        if (fake.isFailing || !s || s.running) {
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
        const ref = `${agent.id}-${sessions.size + 1}`;
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
    } satisfies Runtime,
    /** Every message given to a session, in order: `start`'s brief and each `send`. */
    said: [] as { message: string; ref: string; title?: string }[],
    sessions,
    /** The sessions `stop` was called for, in order. */
    stopped: [] as string[],
  };
  return fake;
}
