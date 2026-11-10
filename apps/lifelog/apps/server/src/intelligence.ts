// Summary runs, one kind: a roll. A roll reads a conversation's tail, the turns past the chapters
// its latest valid run closed (`carriedTurns`), at most `windowChars` of them: one chapters call
// over the tail (summary-calls.ts), then each chapter that closed is summarized and the title and
// TLDR are written again from every chapter. The closed chapters it carries cost no call. A roll
// is a run of its own: the Mac dropping it leaves it waiting, and it resumes in place, asking only
// what it has no usable answer to (intelligence_calls). Rolling.ts decides when a conversation
// rolls; the owner's Generate rolls it from its first turn. Runs are on the Mac's subscription.
// - A call whose answer is unusable is asked again, twice at most, with backoff, alone: a failing
//   chapter retries without the others. Each call keeps its stage, tokens and the turns it read.
// - A valid run's high-confidence boundaries become AI splits at once, the medium ones are offered
//   as "Split here?" (`splitsOf`, summaries.ts).

import { clock } from "@life/server/src/core/clock";
import type { Db } from "@lifelog/db";
import {
  type Coverage,
  conversations,
  intelligenceCalls,
  ownerEdits,
  type RawCall,
  intelligenceRuns as runs,
  type TurnRef,
} from "@lifelog/db/schema";
import { and, eq, isNull, ne } from "drizzle-orm";
import { logChange, turnRef } from "./change-log";
import { sha256Hex } from "./config";
import { logged } from "./diagnostics";
import { record } from "./events";
import { aiSplitId, groupSource, markDirty } from "./grouping";
import { MAC_SLOTS } from "./mac-socket";
import { isCalled } from "./people";

import {
  MacGone,
  type ModelCall,
  type ModelReply,
  type Provider,
} from "./providers";
import {
  latestRun,
  latestValid,
  type Run,
  splitsOf,
  writeChapters,
} from "./summaries";
import {
  type Attempt,
  type Chapter,
  chapterCall,
  overviewCall,
  type Plan,
  type PlannedChapter,
  PROMPT_VERSION,
  planCall,
  type TurnRange as Range,
  type ReadPlan,
  Result,
  within,
} from "./summary-calls";
import {
  adopt,
  type Input,
  loadInput,
  voiceOf,
  windows,
} from "./summary-input";

// Chapter calls in flight at once within a run: what the Mac runs at once. More would only wait
// in the socket's queue.
const CHAPTERS_AT_ONCE = MAC_SLOTS;
// A roll that found no chapter to close keeps nothing: its run is deleted.
const NOTHING_CLOSED = "nothing closed yet";

// How often an unusable answer is asked again within a run, waiting delayMs, then 3× that.
// ponytail: fixed; 5 s and 15 s ride out a provider hiccup, and a model that answers badly
// three times is left invalid for the owner's Generate.
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
    logged(db, "chapters", () => writeChapters(db, run.conversationId));
    logged(db, "splits", () => splitAtBoundaries(db, run));
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

// Up to `limit` of `each` at once, results in order. Once one throws, none starts; those under
// way finish, and their usable answers are kept for the run resumed.
async function inParallel<T, R>(
  items: T[],
  limit: number,
  each: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const out: R[] = [];
  let next = 0;
  let thrown = false;
  const worker = async () => {
    while (!thrown && next < items.length) {
      const index = next;
      next += 1;
      try {
        // biome-ignore lint/performance/noAwaitInLoops: each worker runs one call at a time
        out[index] = await each(items[index] as T, index);
      } catch (error) {
        thrown = true;
        throw error;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker)
  );
  return out;
}

type Outcome = Pick<Run, "error" | "state" | "validationErrors"> & {
  result: Result | null;
};

const NO_CLAIM = { evidenceTurnIds: [], text: "" };

// Every chapter's summary, a few at once, each retried alone. One that never answers usably
// carries its errors instead of failing the others. When
// every one threw, so does this: nothing was written, the run fails.
async function summarizeChapters(
  input: Input,
  chapters: PlannedChapter[],
  ask: Ask
) {
  const answers = await inParallel(chapters, CHAPTERS_AT_ONCE, (c, i) => {
    const stage = `chapter ${i + 1}`;
    const { call, read } = chapterCall(input, c, [i + 1, chapters.length]);
    return ask(stage, call, read, [c.startTurnId, c.endTurnId]).catch(
      (error: unknown) => {
        if (error instanceof MacGone) {
          throw error;
        }
        return {
          errors: [`${stage}: ${String(error)}`],
          output: null,
          thrown: error,
        };
      }
    );
  });
  if (answers.length > 0 && answers.every((a) => "thrown" in a)) {
    throw answers[0]?.thrown;
  }
  return {
    errors: answers.flatMap((a) => a.errors),
    written: chapters.map((c, i): Chapter => {
      const output = answers[i]?.output;
      return {
        ...c,
        evidenceTurnIds: output?.evidenceTurnIds ?? [],
        summary: output?.summary ?? "",
      };
    }),
  };
}

// The title and TLDR from the chapter summaries written; none without a summary.
function overviewOf(input: Input, written: Chapter[], ask: Ask) {
  if (written.every((c) => !c.summary)) {
    return Promise.resolve({ errors: [], output: null });
  }
  const { call, read } = overviewCall(input, written);
  return ask("overview", call, read);
}

// What the chapters call found besides the chapters.
function planResult(input: Input, plan: ReadPlan) {
  return {
    languages: plan.languages,
    speakerIdentities: speakerIdentities(plan.speakers, input),
    speakers: plan.speakers.map(({ kind, speaker }) => ({
      kind: kind === "announcement" ? ("media" as const) : kind,
      speaker,
    })),
  };
}

// Who the model says each unnamed speaker is. A name counts only with turns that show it,
// and only turns of this conversation; a known person only when an owner-named or confident linked Life person has that name
// or alias.
function speakerIdentities(speakers: Plan["speakers"], input: Input) {
  const last = input.turns.length - 1;
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

const span = (from: number, to: number) =>
  Array.from({ length: Math.max(0, to - from + 1) }, (_, k) => from + k);

type Valid = NonNullable<Awaited<ReturnType<typeof latestValid>>>;

// How many first turns the previous run's chapters still cover, in order and each summarized:
// up to the first chapter that lost or gained a turn (late audio, a split, a merge) or has no
// summary. Only those chapters stay the conversation's: past a split they belong to the piece
// after it, which rolls on its own.
function carriedTurns(
  previous: Pick<Valid, "result" | "turns">,
  refs: TurnRef[]
) {
  const position = new Map(
    refs.map((t, i) => [turnRef(t.jobId, t.turnIndex), i])
  );
  let next = 0;
  for (const c of previous.result.chapters) {
    const at = span(c.startTurnId, c.endTurnId).map((id) => {
      const ref = previous.turns[id];
      return ref ? position.get(turnRef(ref.jobId, ref.turnIndex)) : undefined;
    });
    if (!c.summary || at.some((p, k) => p !== next + k)) {
      break;
    }
    next += at.length;
  }
  return next;
}

// What a roll keeps of the previous run over its first `prefix` turns (`carriedTurns`: there its
// turn ids are this input's): the chapters with their summaries, a split suggestion at one of
// their starts or at the turn right after them (the next chapter's start), the speakers heard
// there and its languages.
function carry(previous: Valid, input: Input, prefix: number) {
  const { result } = previous;
  const inside = (ids: number[]) => ids.filter((id) => id < prefix);
  const chapters = result.chapters.filter((c) => c.endTurnId < prefix);
  const starts = new Set(chapters.map((c) => c.startTurnId));
  const next = input.refs[prefix];
  const boundarySuggestions = result.boundarySuggestions.flatMap((b) => {
    const ref = previous.turns[b.turnId];
    if (
      ref &&
      next &&
      turnRef(ref.jobId, ref.turnIndex) === turnRef(next.jobId, next.turnIndex)
    ) {
      return [{ ...b, evidenceTurnIds: [prefix], turnId: prefix }];
    }
    if (b.turnId === 0 || !starts.has(b.turnId)) {
      return [];
    }
    const evidence = inside(b.evidenceTurnIds);
    return [{ ...b, evidenceTurnIds: evidence.length ? evidence : [b.turnId] }];
  });
  const jobs = new Set(input.refs.slice(0, prefix).map((t) => t.jobId));
  const heard = new Set(input.turns.slice(0, prefix).map((t) => t.speaker));
  return {
    boundarySuggestions,
    chapters,
    languages: result.languages,
    speakerIdentities: (result.speakerIdentities ?? [])
      .filter((s) => jobs.has(s.jobId))
      .map((s) => {
        const evidence = inside(s.evidenceTurnIds);
        return {
          ...s,
          evidenceTurnIds: s.name ? evidence : [],
          name: evidence.length ? s.name : null,
        };
      }),
    speakers: (result.speakers ?? []).filter((k) => heard.has(k.speaker)),
  };
}

// The tail's chapters that close: those before a confident new conversation (`cut`), all once
// the conversation is closed and the window reaches its end, else all but the last, which may go
// on. A full window about one topic closes at the window's end.
function closing<T extends { endTurnId: number }>(
  chapters: T[],
  cut: number,
  full: boolean,
  open: boolean
) {
  if (Number.isFinite(cut)) {
    return chapters.filter((c) => c.endTurnId < cut);
  }
  if (!(open || full)) {
    return chapters;
  }
  return chapters.length > 1 || !full ? chapters.slice(0, -1) : chapters;
}

// Each key once, the fresh one winning.
const newest = <T>(old: T[] | undefined, fresh: T[], key: (t: T) => string) => [
  ...new Map([...(old ?? []), ...fresh].map((t) => [key(t), t])).values(),
];

interface Roll {
  open: boolean;
  // Turns the previous run's chapters cover.
  prefix: number;
  previous: Valid | null;
  // The tail it reads; none when only the previous chapters are left (a piece cut at a chapter).
  range: Range | null;
}

// What a roll read past the previous chapters: the chapters that close, its plan, and the split
// suggestions after its first turn (that one already starts a chapter: a boundary there was the
// last roll's).
interface Tail {
  closed: PlannedChapter[];
  plan: ReadPlan | null;
  suggestions: Result["boundarySuggestions"];
}
const NO_TAIL: Tail = { closed: [], plan: null, suggestions: [] };

// The tail's chapters call, or why the roll stops: an unusable plan, or nothing closed.
async function planTail(
  input: Input,
  { open, range }: Roll,
  ask: Ask
): Promise<Tail | { stop: Outcome }> {
  if (!range) {
    return NO_TAIL;
  }
  const full = range[1] < input.turns.length - 1;
  const { call, read } = planCall(input, range, open || full);
  const planned = await ask("chapters", call, read, range);
  const plan = planned.errors.length === 0 ? planned.output : null;
  if (!plan) {
    return { stop: stopped(null, planned.errors) };
  }
  const fresh = plan.boundaries.filter((b) => b.turnId > range[0]);
  const cut = Math.min(
    ...fresh.filter((b) => b.confidence === "high").map((b) => b.turnId)
  );
  const closed = closing(plan.chapters, cut, full, open);
  if (closed.length === 0) {
    return { stop: stopped(NOTHING_CLOSED, []) };
  }
  return { closed, plan, suggestions: fresh.filter((b) => b.turnId <= cut) };
}

const stopped = (
  error: string | null,
  validationErrors: string[]
): Outcome => ({ error, result: null, state: "invalid", validationErrors });

const NOTHING_CARRIED = {
  boundarySuggestions: [],
  chapters: [],
  languages: [],
  speakerIdentities: [],
  speakers: [],
};

const NOTHING_FOUND = { languages: [], speakerIdentities: [], speakers: [] };

async function rolled(input: Input, roll: Roll, ask: Ask): Promise<Outcome> {
  const tail = await planTail(input, roll, ask);
  if ("stop" in tail) {
    return tail.stop;
  }
  const { prefix, previous } = roll;
  const before =
    previous && prefix > 0 ? carry(previous, input, prefix) : NOTHING_CARRIED;
  const { errors, written } = await summarizeChapters(input, tail.closed, ask);
  const chapters = [...before.chapters, ...written];
  const overview = await overviewOf(input, chapters, ask);
  const found = tail.plan ? planResult(input, tail.plan) : NOTHING_FOUND;
  const result: Result = {
    boundarySuggestions: [...before.boundarySuggestions, ...tail.suggestions],
    chapters,
    languages: [...new Set([...before.languages, ...found.languages])],
    speakerIdentities: newest(
      before.speakerIdentities,
      found.speakerIdentities,
      voiceOf
    ),
    speakers: newest(before.speakers, found.speakers, (s) => s.speaker),
    speakerTokens: input.tokens,
    ...(overview.output ?? { title: NO_CLAIM, tldr: NO_CLAIM }),
  };
  const valid = overview.output && overview.errors.length === 0;
  return {
    error: null,
    result,
    state: valid ? "valid" : "invalid",
    validationErrors: [...errors, ...overview.errors],
  };
}

const sameTurns = (a: TurnRef[], b: TurnRef[]) =>
  a.length === b.length &&
  a.every((t, i) => t.jobId === b[i]?.jobId && t.turnIndex === b[i]?.turnIndex);

// Starts a roll of a conversation, or resumes the one the Mac dropped: "busy" while one runs or
// the Mac is away, null when there is nothing to roll (no words yet, or the latest valid run read
// exactly these words and left no tail). It goes on from the latest valid run's chapters, or from
// the first turn when `fromScratch` (the owner's Generate; its run waiting for the Mac never
// started, so it has no coverage yet). The newest valid run is the summary either way. Its work
// settles with the run and whether words are left past what it closed: a window that ended before
// the last turn, which the caller rolls next.
export function requestRoll(
  db: Db,
  selectable: Provider,
  conversationId: string,
  {
    fromScratch = false,
    open,
    retries = RETRIES,
    windowChars,
  }: {
    fromScratch?: boolean;
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
  const asked =
    fromScratch || (latest?.state === "waiting" && latest.coverage === null);
  const own = loadInput(db, conversationId);
  const previous = asked ? null : latestValid(db, conversationId);
  if (!own) {
    return null;
  }
  const input = adopt(own, previous?.result.speakerTokens);
  const prefix = previous ? carriedTurns(previous, input.refs) : 0;
  const [range = null] = windows(input.turns.slice(prefix), windowChars);
  if (!range && previous && sameTurns(previous.turns, input.refs)) {
    return null;
  }
  const coverage: Coverage = {
    mode: "rolling",
    turnCount: input.turns.length,
    windows: range ? [range] : [],
  };
  const values = {
    coverage,
    error: null,
    ...stamp(provider),
    promptVersion: PROMPT_VERSION,
    state: "running" as const,
    turns: input.refs,
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
  const roll = { open, prefix, previous, range };
  const work = execute(db, provider, run.id, {
    coverage,
    retries,
    steps: (ask) => rolled(input, roll, ask),
  }).then((done) => {
    if (done.error === NOTHING_CLOSED) {
      db.delete(runs).where(eq(runs.id, done.id)).run();
    }
    return done;
  });
  return {
    work: settling(db, run, work).then((done) => {
      const more =
        done.state === "valid" &&
        range !== null &&
        range[1] < input.turns.length - 1;
      return { more, run: done };
    }),
  };
}

// A valid run's high-confidence boundaries as AI splits, then grouped at once. Every valid run
// does this. Not for an imported recording or a conversation not grouped here.
function splitAtBoundaries(db: Db, run: Run) {
  const ats = splitsOf(Result.safeParse(run.result).data, run.turns, "high");
  const target = db
    .select({ sourceId: conversations.sourceId })
    .from(conversations)
    .where(
      and(
        eq(conversations.id, run.conversationId),
        isNull(conversations.retiredAt),
        ne(conversations.kind, "imported")
      )
    )
    .get();
  const sourceId = target?.sourceId;
  if (ats.length === 0 || !sourceId) {
    return;
  }
  const stored = db.transaction((tx) => {
    const rows = tx
      .insert(ownerEdits)
      .values(
        ats.map(({ at }) => ({
          at: new Date(at),
          editedAt: clock(),
          id: aiSplitId(at),
          kind: "split" as const,
          source: "ai" as const,
        }))
      )
      .onConflictDoNothing()
      .returning({ at: ownerEdits.at, id: ownerEdits.id })
      .all();
    const times = rows.flatMap((r) => (r.at ? [r.at.getTime()] : []));
    if (times.length > 0) {
      markDirty(tx, [sourceId], [Math.min(...times), Math.max(...times)]);
    }
    logChange(
      tx,
      "edit",
      rows.map((r) => r.id)
    );
    return rows.length;
  });
  if (stored > 0) {
    groupSource(db, sourceId);
  }
}
