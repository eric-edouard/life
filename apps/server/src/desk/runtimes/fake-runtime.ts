import type { Runtime } from "./contract";

// A runtime for tests: sessions in memory. The test plays the agent (its door calls and its turn's end) and sets what
// the runtime does: fail, report a session's growth, forget a session, run a turn of his, end a run.

export function fakeRuntime() {
  const sessions = new Map<string, { grownBy: number; running: boolean }>();
  /** Each session's last run, ended by `exit`. */
  const runs = new Map<string, (ok: boolean) => void>();
  /** Each session's pending `begun`, settled by `begin` or, failing, by `exit`. */
  const begins = new Map<
    string,
    { fail: (e: Error) => void; ok: () => void }
  >();
  /** Set by `holdBegun`: a run is under way only when the test says. */
  let isBegunHeld = false;
  /** The sessions whose last run has begun, as its own record would say (`hasBegun`). */
  const begun = new Set<string>();
  const run = (ref: string) => ({
    begun: (isBegunHeld
      ? new Promise<void>((ok, fail) => begins.set(ref, { fail, ok }))
      : Promise.resolve()
    ).then(() => {
      begun.add(ref);
    }),
    ended: new Promise<{ ok: boolean }>((resolve) =>
      runs.set(ref, (ok) => resolve({ ok }))
    ),
  });
  const fake = {
    /** Its record says the session's last run began, though no `begun` of this process heard it (a run before a restart). */
    beganBefore(ref: string) {
      begun.add(ref);
    },
    /** Settles the session's last run as under way (after `holdBegun`). */
    begin(ref: string) {
      begins.get(ref)?.ok();
    },
    /** Why the runtime can't run, as `Runtime.block`; none: it can. */
    blocked: undefined as string | undefined,
    /** Runs inside `send` before it answers: a turn that calls the door before its runtime's CLI returns. */
    duringSend: undefined as (() => Promise<void>) | undefined,
    /** Ends the session's last run, as its process exiting. */
    exit(ref: string, ok = true, isBegunLate = false) {
      const s = sessions.get(ref);
      if (s) {
        s.running = false;
      }
      runs.get(ref)?.(ok);
      // A run whose `begun` settles just after `ended`, as a transcript poll does.
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
      hasBegun: (ref: string) => Promise.resolve(begun.has(ref)),
      async send(_agent, ref, message) {
        const s = sessions.get(ref);
        if (fake.isFailing || !s || s.running) {
          throw new Error(`cannot run ${ref}`);
        }
        s.running = true;
        begun.delete(ref);
        fake.said.push({ message, ref });
        await fake.duringSend?.();
        return run(ref);
      },
      start(agent, brief) {
        if (fake.isFailing) {
          return Promise.reject(new Error("cannot start"));
        }
        const ref = `${agent.id}-${sessions.size + 1}`;
        sessions.set(ref, { grownBy: 0, running: true });
        fake.said.push({ message: brief, ref });
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
      usage(ref) {
        const s = sessions.get(ref);
        return Promise.resolve(
          s
            ? { grownBy: s.grownBy, tokensCached: 0, tokensIn: 0, tokensOut: 0 }
            : null
        );
      },
    } satisfies Runtime,
    /** Every message given to a session, in order: `start`'s brief and each `send`. */
    said: [] as { message: string; ref: string }[],
    sessions,
    /** The sessions `stop` was called for, in order. */
    stopped: [] as string[],
  };
  return fake;
}
