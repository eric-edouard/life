// The sends at ElevenLabs at once, at most ELEVENLABS_SLOTS: the submitted jobs it may still be
// working on (`atScribe`, read each time) and the sends this process has under way, each counted once
// by its key (a job keeps its id from its send to its webhook, so taking over a send's slot never
// counts it twice). A send holds its slot from before it leaves until its answer; reading audio and
// the speech service take none. Dictation ("interactive") waits ahead of everything else, each
// priority in arrival order; a send under way is never cut. Every wait is bounded, and one aborted
// leaves the line at once.

export type Priority = "interactive" | "ordinary";
// Gives the slot back; a second call does nothing.
export type Release = () => void;

interface Waiter {
  grant: (release: Release | null) => void;
  key: string;
  priority: Priority;
}

export function scribeSlots(size: number, atScribe: () => string[]) {
  const sending = new Set<string>();
  const line: Waiter[] = [];

  const free = () => size - new Set([...atScribe(), ...sending]).size;

  function hold(key: string): Release {
    sending.add(key);
    let held = true;
    return () => {
      if (held) {
        held = false;
        sending.delete(key);
        wake();
      }
    };
  }

  // Grants the free slots to the line, in its order. Called when a send of this process ends, and by
  // whoever may have freed a submitted job's (a webhook, reconcile).
  function wake() {
    while (line.length > 0 && free() > 0) {
      const next = line.shift() as Waiter;
      next.grant(hold(next.key));
    }
  }

  return {
    // The slots a job may take now without a wait: none while anyone waits.
    room() {
      wake();
      return line.length > 0 ? 0 : Math.max(0, free());
    },
    // A slot for the send `key` (unique per send: a job's id), or null when none came within
    // `waitMs` or `signal` aborted first.
    wait(
      key: string,
      {
        priority,
        signal,
        waitMs,
      }: { priority: Priority; signal?: AbortSignal; waitMs: number }
    ): Promise<Release | null> {
      if (signal?.aborted) {
        return Promise.resolve(null);
      }
      return new Promise((resolve) => {
        const leave = () => {
          const at = line.indexOf(waiter);
          if (at >= 0) {
            line.splice(at, 1);
            waiter.grant(null);
          }
        };
        const timer = setTimeout(leave, waitMs);
        const waiter: Waiter = {
          grant(release) {
            clearTimeout(timer);
            signal?.removeEventListener("abort", leave);
            resolve(release);
          },
          key,
          priority,
        };
        signal?.addEventListener("abort", leave);
        const behind =
          priority === "interactive"
            ? line.findIndex((w) => w.priority === "ordinary")
            : -1;
        line.splice(behind < 0 ? line.length : behind, 0, waiter);
        wake();
      });
    },
    wake,
  };
}

export type ScribeSlots = ReturnType<typeof scribeSlots>;
