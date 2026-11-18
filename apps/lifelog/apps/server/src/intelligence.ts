// Runs, one kind: a roll. A roll reads a conversation's turns past what its previous run read
// (`commonPrefix`), at most `windowChars` of them, in one voices call (voices-call.ts): who each
// unnamed speaker is. Its answer is merged with the previous run's over the turns they share. A
// roll is a run of its own: the Mac dropping it leaves it waiting, and it resumes in place, asking
// only what it has no usable answer to (intelligence_calls). Rolling.ts decides when a
// conversation rolls. Runs are on the Mac's
// subscription.
// - A call whose answer is unusable is asked again, twice at most, with backoff. Each call keeps
//   its stage, tokens and the turns it read.
// - An open conversation rolls only a full window; once closed, its tail too.

import type { Db } from "@lifelog/db";
import {
  type Coverage,
  intelligenceCalls,
  type RawCall,
  intelligenceRuns as runs,
  type TurnRef,
} from "@lifelog/db/schema";
import { and, eq } from "drizzle-orm";
import { logChange, turnRef } from "./change-log";
import { sha256Hex } from "./config";
import { logged } from "./diagnostics";
import { record } from "./events";
import { isCalled } from "./people";
import {
  MacGone,
  type ModelCall,
  type ModelReply,
  type Provider,
} from "./providers";
import { latestRun, latestValid, type Run } from "./runs";
import {
  type Attempt,
  PROMPT_VERSION,
  type TurnRange as Range,
  type Result,
  type Voices,
  voicesCall,
  within,
} from "./voices-call";
import { type Input, loadInput, voiceOf, windows } from "./voices-input";

// How often an unusable answer is asked again within a run, waiting delayMs, then 3× that.
// ponytail: fixed; 5 s and 15 s ride out a provider hiccup, and a model that answers badly
// three times is left invalid until its words change.
const RETRIES = { count: 2, delayMs: 5000 };
export type Retries = typeof RETRIES;

function frozen(provider: Provider) {
  return provider.snapshot?.() ?? provider;
}

function stamp(provider: Provider) {
  return {
    model: provider.model,
    provider: provider.name,
    reasoningEffort: provider.reasoningEffort ?? null,
  };
}

// A started run's work, which never rejects. Only a write can throw: the run waits, so the next
// drain resumes it; if even that write fails, the next restart does (index.ts).
function settling(db: Db, run: Run, work: Promise<Run>) {
  return work.catch((error: unknown) => {
    console.error(`intelligence run ${run.id}: ${String(error)}`);
    try {
      db.update(runs)
        .set({ state: "waiting" })
        .where(and(eq(runs.id, run.id), eq(runs.state, "running")))
        .run();
    } catch {
      // The restart will.
    }
    return run;
  });
}

// One stage of a run: a call, asked again while its answer is unusable or the call throws.
// The last answer's errors (or error) are the stage's. `turns` is what it read, if any. A
// usable answer is kept (intelligence_calls), so the run, resumed, never asks for it again.
type Ask = <T>(
  stage: string,
  call: ModelCall,
  read: (reply: string) => Attempt<T>,
  turns?: Range
) => Promise<Attempt<T>>;

const labelled = <T>(stage: string, { errors, output }: Attempt<T>) => ({
  errors: errors.map((e) => `${stage}: ${e}`),
  output,
});

async function execute(
  db: Db,
  provider: Provider,
  runId: string,
  {
    coverage,
    retries,
    steps,
  }: {
    coverage: Coverage;
    retries: Retries;
    // The run's calls (`rolled`).
    steps: (ask: Ask) => Promise<Outcome>;
  }
): Promise<Run> {
  const started = performance.now();
  const raw: RawCall[] = [];
  // One call, in raw. Its answer is kept when usable, even one that comes after the call
  // failed (`late`): the run, resumed, finds it instead of asking again.
  const once = async <T>(
    stage: string,
    call: ModelCall,
    key: string,
    read: (reply: string) => Attempt<T>,
    turns?: Range
  ) => {
    const t0 = performance.now();
    const keep = (answer: ModelReply) => {
      const made: RawCall = {
        inputTokens: answer.inputTokens,
        latencyMs: Math.round(performance.now() - t0),
        ...stamp(provider),
        outputTokens: answer.outputTokens,
        stage,
        text: answer.text,
        ...(turns ? { turns } : {}),
      };
      const attempt = read(answer.text);
      if (attempt.errors.length === 0) {
        db.insert(intelligenceCalls)
          .values({ call: made, key, runId, stage })
          .onConflictDoNothing()
          .run();
      }
      return { attempt, made };
    };
    const reply = await provider.call(call, (late) =>
      logged(db, "late answer", () => keep(late))
    );
    const { attempt, made } = keep(reply);
    raw.push(made);
    return attempt;
  };
  // A usable answer this run already has: it waited for the Mac, or a restart cut it off.
  const kept = (stage: string, key: string) =>
    db
      .select({ call: intelligenceCalls.call })
      .from(intelligenceCalls)
      .where(
        and(
          eq(intelligenceCalls.runId, runId),
          eq(intelligenceCalls.stage, stage),
          eq(intelligenceCalls.key, key)
        )
      )
      .all()[0]?.call;
  const ask: Ask = async (stage, call, read, turns) => {
    const key = sha256Hex(JSON.stringify(call));
    const answered = kept(stage, key);
    if (answered) {
      raw.push(answered);
      return labelled(stage, read(answered.text));
    }
    for (let tries = 0; ; tries += 1) {
      try {
        // biome-ignore lint/performance/noAwaitInLoops: a retry waits for the answer before it
        const attempt = await once(stage, call, key, read, turns);
        if (attempt.errors.length === 0 || tries >= retries.count) {
          return labelled(stage, attempt);
        }
      } catch (error) {
        // The Mac left: asking again can't help, the run waits.
        if (error instanceof MacGone || tries >= retries.count) {
          throw error;
        }
      }
      await Bun.sleep(retries.delayMs * 3 ** tries);
    }
  };

  let outcome: Outcome;
  try {
    outcome = await steps(ask);
  } catch (error) {
    if (error instanceof MacGone) {
      // The run waits; resumed, it asks only for what it has no usable answer to yet.
      const run = db
        .update(runs)
        .set({
          inputTokens: raw.reduce((sum, c) => sum + c.inputTokens, 0),
          outputTokens: raw.reduce((sum, c) => sum + c.outputTokens, 0),
          raw,
          state: "waiting",
        })
        .where(eq(runs.id, runId))
        .returning()
        .get();
      record(db, "intelligence.waiting", { reason: error.message, run: runId });
      if (!run) {
        throw new Error(`intelligence run ${runId} vanished`, { cause: error });
      }
      return run;
    }
    outcome = {
      error: String(error),
      result: null,
      state: "failed",
      validationErrors: [],
    };
  }
  const inputTokens = raw.reduce((sum, r) => sum + r.inputTokens, 0);
  const outputTokens = raw.reduce((sum, r) => sum + r.outputTokens, 0);
  const run = db
    .update(runs)
    .set({
      ...outcome,
      // The Mac runs on the owner's subscription.
      costUsd: 0,
      coverage,
      inputTokens,
      latencyMs: Math.round(performance.now() - started),
      outputTokens,
      raw,
    })
    .where(eq(runs.id, runId))
    .returning()
    .get();
  if (!run) {
    throw new Error(`intelligence run ${runId} vanished`);
  }
  if (run.state === "valid") {
    // The feed's run, and "Who's this?", read it.
    logged(db, "run", () => logChange(db, "conversation", run.conversationId));
  }
  record(db, "intelligence.run", {
    calls: raw.length,
    ms: run.latencyMs,
    provider: provider.name,
    run: runId,
    state: run.state,
  });
  return run;
}

// Who the model says each unnamed speaker is. A name counts only with turns that show it,
// and only turns of this conversation; a known person only when the owner has one by that name
// or alias. Its turns are those up to `last`, the end of the window read.
function speakerIdentities(
  speakers: Voices["speakers"],
  input: Input,
  last: number
) {
  return speakers.flatMap((s) => {
    const known = input.unnamed.get(s.speaker);
    if (!known) {
      return [];
    }
    const evidence = within(s.evidenceTurnIds, 0, last);
    const name = s.name.trim();
    return [
      {
        ...known,
        evidenceTurnIds: name && evidence.length > 0 ? evidence : [],
        kind: s.kind,
        name: name && evidence.length > 0 && name.length <= 80 ? name : null,
        personId:
          input.people.find((p) => isCalled(p, s.knownPerson))?.id ?? null,
        withOwner: s.withOwner,
      },
    ];
  });
}

type Valid = NonNullable<ReturnType<typeof latestValid>>;

// How many first turns `previous` read that are still the conversation's first turns, in order
// (late audio or a split changes them).
function commonPrefix(previous: Pick<Valid, "turns">, refs: TurnRef[]) {
  const same = (t: TurnRef, i: number) =>
    refs[i] &&
    turnRef(t.jobId, t.turnIndex) === turnRef(refs[i].jobId, refs[i].turnIndex);
  const differs = previous.turns.findIndex((t, i) => !same(t, i));
  return differs < 0 ? previous.turns.length : differs;
}

// What the previous run said of the voices heard in its first `prefix` turns (there its turn ids
// are this input's); a name stays only with turns that still show it.
function carried(previous: Valid, input: Input, prefix: number) {
  const jobs = new Set(input.refs.slice(0, prefix).map((t) => t.jobId));
  return (previous.result.speakerIdentities ?? [])
    .filter((s) => jobs.has(s.jobId))
    .map((s) => {
      const evidence = s.evidenceTurnIds.filter((id) => id < prefix);
      return {
        ...s,
        evidenceTurnIds: s.name ? evidence : [],
        name: evidence.length ? s.name : null,
      };
    });
}

type Identity = NonNullable<Result["speakerIdentities"]>[number];

// Each voice once, the fresh reading winning, except that a name an earlier window found stays
// when the fresh one has none (the legend lists every voice, so a later window repeats them).
function newest(old: Identity[], fresh: Identity[]) {
  const merged = new Map(old.map((s) => [voiceOf(s), s]));
  for (const s of fresh) {
    const before = merged.get(voiceOf(s));
    merged.set(
      voiceOf(s),
      before?.name && !s.name
        ? {
            ...s,
            evidenceTurnIds: before.evidenceTurnIds,
            name: before.name,
            personId: s.personId ?? before.personId,
          }
        : s
    );
  }
  return [...merged.values()];
}

interface Roll {
  // The turns the previous run read, still the first ones here.
  prefix: number;
  previous: Valid | null;
  // The window it reads.
  range: Range;
}

type Outcome = Pick<Run, "error" | "state" | "validationErrors"> & {
  result: Result | null;
};

async function rolled(
  input: Input,
  { prefix, previous, range }: Roll,
  ask: Ask
): Promise<Outcome> {
  const { call, read } = voicesCall(input, range);
  const answered = await ask("voices", call, read, range);
  if (!answered.output) {
    return {
      error: null,
      result: null,
      state: "invalid",
      validationErrors: answered.errors,
    };
  }
  return {
    error: null,
    result: {
      speakerIdentities: newest(
        previous ? carried(previous, input, prefix) : [],
        speakerIdentities(answered.output.speakers, input, range[1])
      ),
    },
    state: "valid",
    validationErrors: [],
  };
}

// Starts a roll of a conversation, or resumes the one the Mac dropped: "busy" while one runs or
// the Mac is away, null when there is nothing to roll: no words yet, none past the previous run's,
// or an open conversation with less than a full window of new words. It goes on from the latest
// valid run's turns (of this prompt version), or from the first turn. Its
// work settles with the run and whether words are left past its window: the caller rolls them
// next.
export function requestRoll(
  db: Db,
  selectable: Provider,
  conversationId: string,
  {
    open,
    retries = RETRIES,
    windowChars,
  }: {
    open: boolean;
    retries?: Retries;
    windowChars: number;
  }
): { work: Promise<{ more: boolean; run: Run }> } | "busy" | null {
  const provider = frozen(selectable);
  if (provider.ready?.() === false) {
    return "busy";
  }
  const latest = latestRun(db, conversationId);
  if (latest?.state === "running") {
    return "busy";
  }
  const input = loadInput(db, conversationId);
  if (!input) {
    return null;
  }
  const valid = latestValid(db, conversationId);
  const previous = valid?.promptVersion === PROMPT_VERSION ? valid : null;
  const prefix = previous ? commonPrefix(previous, input.refs) : 0;
  const [range, ...later] = windows(input.turns.slice(prefix), windowChars);
  if (!range || (open && later.length === 0)) {
    return null;
  }
  const coverage: Coverage = {
    mode: "rolling",
    turnCount: input.turns.length,
    windows: [range],
  };
  const values = {
    coverage,
    error: null,
    ...stamp(provider),
    promptVersion: PROMPT_VERSION,
    state: "running" as const,
    turns: input.refs.slice(0, range[1] + 1),
  };
  // A waiting run starts again in place; anything else is a new run. Either way at most one runs.
  const [run] =
    latest?.state === "waiting"
      ? db
          .update(runs)
          .set(values)
          .where(and(eq(runs.id, latest.id), eq(runs.state, "waiting")))
          .returning()
          .all()
      : db
          .insert(runs)
          .values({ ...values, conversationId })
          .onConflictDoNothing()
          .returning()
          .all();
  if (!run) {
    return "busy";
  }
  const work = execute(db, provider, run.id, {
    coverage,
    retries,
    steps: (ask) => rolled(input, { prefix, previous, range }, ask),
  });
  return {
    work: settling(db, run, work).then((done) => ({
      more: done.state === "valid" && later.length > 0,
      run: done,
    })),
  };
}
