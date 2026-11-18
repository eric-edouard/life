import type { Runtime } from "./contract";

// A runtime for tests: sessions in memory. The test plays the agent (its door calls and its turn's end) and sets what
// the runtime does: fail, report a context size, forget a session, run a turn of his.

export function fakeRuntime() {
  const sessions = new Map<string, { running: boolean; tokens: number }>();
  const fake = {
    /** Runs inside `send` before it answers: a turn that ends (or calls the door) before its runtime's CLI returns. */
    duringSend: undefined as (() => Promise<void>) | undefined,
    /** While set, `start` and `send` throw, as a CLI that fails. */
    isFailing: false as boolean,
    runtime: {
      contextTokens: (ref) =>
        Promise.resolve(sessions.get(ref)?.tokens ?? null),
      async send(ref, message) {
        const s = sessions.get(ref);
        if (fake.isFailing || !s) {
          throw new Error(`cannot run ${ref}`);
        }
        s.running = true;
        fake.said.push({ message, ref });
        await fake.duringSend?.();
        return { ref };
      },
      start(agent, brief) {
        if (fake.isFailing) {
          return Promise.reject(new Error("cannot start"));
        }
        const ref = `${agent.id}-${sessions.size + 1}`;
        sessions.set(ref, { running: true, tokens: 1000 });
        fake.said.push({ message: brief, ref });
        return Promise.resolve({ link: `fake://${ref}`, ref });
      },
      state(ref) {
        const s = sessions.get(ref);
        if (!s) {
          return Promise.resolve("gone");
        }
        return Promise.resolve(s.running ? "running" : "idle");
      },
    } satisfies Runtime,
    /** Every message given to a session, in order: `start`'s brief and each `send`. */
    said: [] as { message: string; ref: string }[],
    sessions,
  };
  return fake;
}
