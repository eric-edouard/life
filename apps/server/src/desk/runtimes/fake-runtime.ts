import type { Runtime } from "./contract";

// A runtime for tests: sessions in memory. The test plays the agent (its door calls and its turn's end) and sets what
// the runtime does: fail, report a session's growth, forget a session, run a turn of his, end a run.

export function fakeRuntime() {
  const sessions = new Map<string, { grownBy: number; running: boolean }>();
  /** Each session's last run, ended by `exit`. */
  const runs = new Map<string, (ok: boolean) => void>();
  const run = (ref: string) => ({
    ended: new Promise<{ ok: boolean }>((resolve) =>
      runs.set(ref, (ok) => resolve({ ok }))
    ),
  });
  const fake = {
    /** Runs inside `send` before it answers: a turn that calls the door before its runtime's CLI returns. */
    duringSend: undefined as (() => Promise<void>) | undefined,
    /** Ends the session's last run, as its process exiting. */
    exit(ref: string, ok = true) {
      const s = sessions.get(ref);
      if (s) {
        s.running = false;
      }
      runs.get(ref)?.(ok);
    },
    /** While set, `start` and `send` throw, as a CLI that fails. */
    isFailing: false as boolean,
    runtime: {
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
  };
  return fake;
}
