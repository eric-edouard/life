// The Mac helper's one WebSocket (apps/dictation), opened with the Mac's token at protocol
// MAC_PROTOCOL; another protocol is refused (routes/sync.ts). The helper is a sensor and a runner:
// it reports raw facts and runs what it is told, and every rule lives here (docs/sync.md).
//
// Its events: {type: "mic", seq, at, capturing} whenever the set of processes with the microphone
// on changes, and {type: "sleep", seq, at} before the Mac sleeps. Each is applied once (a seq no
// greater than the last applied is a resend), turned into quiet ranges by the dictation rules
// (dictation.ts, quiet-ranges.ts `applyMacEvent`) and answered {type: "ack", seq}; the helper keeps
// an event until the ack and resends it on every new socket, before its {type: "hello", engines,
// running}. An event that can't be applied (invalid, or the database) closes the socket unacked and
// blocks the watermark until an event applies again (`blockMac`, `mac.stuck`): events apply only
// in the order sent, and nothing after the refused one is vouched for (fail closed).
//
// The watermark: once the socket said hello, the Mac vouches through now, held back to a dictation
// not yet among the ranges. Closed (sleep, offline, crash), it freezes at the last hello, ping or
// pong heard, or event applied, in server time. The helper pings every 30 s. A hello means the Mac
// is awake; it lists the calls the Mac still runs (after a restart here), which count against the
// slots until they answer.
//
// The same socket carries model calls the other way (providers.ts macProvider): the server sends
// {type: "llm", id, engine, model, effort, system, prompt, schema, maxTokens, timeoutMs}; the Mac
// runs Codex or Claude Code on the owner's subscription, kills it at `timeoutMs`, and answers
// {type: "llm.output", id, stdout, stderr, final?, status, timedOut}, or {type: "llm.unrun", id,
// signedOut, unrun} when it couldn't start; mac-llm.ts reads that. At most MAC_SLOTS calls are on
// the Mac at once; the rest wait here, and each call's timer starts when it is sent. A timeout
// fails that call alone, with MacGone: the run waits, and resumes where it stopped. A closed socket
// fails the calls not sent yet; those sent stay, since the Mac keeps running them and answers on
// its next socket. An answer after its call failed still reaches the caller's `late` (the run keeps
// it for its resume). Reason "auth" (the CLI is signed out) or "limit" (the subscription's limit)
// fails that engine's calls and keeps them off the Mac for UNABLE_MS.
//
// ponytail: one replica, socket state in memory. The dictation state and when the Mac was heard
// are in mac_watch, so a restart falls back to them.

import { randomUUID } from "node:crypto";
import type { Db } from "@life/voice-db";
import { type MacEngine, macEngines } from "@life/voice-db/schema";
import type { Server, ServerWebSocket } from "bun";
import { z } from "zod";
import { logChange } from "./change-log";
import { logged } from "./config";
import {
  type DictatedRange,
  dictatingSince,
  isDictationApp,
  type MacReport,
  nextChange,
} from "./dictation";
import { record } from "./events";
import { MAC_KILL_MS, type MacOutput, macAnswer } from "./mac-llm";
import { MacGone, type ModelReply } from "./providers";
import {
  applyMacEvent,
  blockMac,
  macRow,
  macView,
  settleMac,
  storeMacHeard,
} from "./quiet-ranges";
import { SubscriptionMessage, storeSubscriptionUsage } from "./subscriptions";
import { switches } from "./switches";

// The helper's socket protocol: 2 sends raw events and output (1 sent ranges and answers).
export const MAC_PROTOCOL = 2;
// Close codes when an event is refused: invalid (the helper drops it), or a seq behind what was
// applied (its next welcome renumbers it).
const MAC_INVALID = 4400;
const MAC_BEHIND = 4409;
// Per call from when it is sent: the Mac's kill, and a little for its word to come back.
const LLM_TIMEOUT_MS = MAC_KILL_MS + 10_000;
// The Mac runs every call it gets; sending more at once would only spend the subscription faster.
export const MAC_SLOTS = 4;
// How long an answer to a failed call is still taken. ponytail: fixed; the Mac's own limit is
// 170 s a call, and a reconnect takes seconds.
const LATE_MS = 30 * 60_000;
const UNABLE_MS = 10 * 60_000;

// The Mac silent this long is off, or its helper is gone.
const MAC_SILENCE_MS = 2 * 3_600_000;

// Up to when audio may go to transcription as far as the Mac is concerned: nothing dictated to it
// before then can be missing from the quiet ranges. Its watermark; `now` once it is asleep or was
// silent for MAC_SILENCE_MS (off, or the helper gone, which the owner accepts), or before the
// helper ever spoke. Silence frees nothing while a dictation is pending: the watermark then stops
// at its start, before the last frame heard (`macView`), and holds until it is a range.
// The cutter closes no block ending after it (cutter.ts), and the job worker sends no job ending
// after it (jobs.ts `claim`). Cases in apps/voice/fixtures/mac-vouches.json.
export function vouchedThrough(watch: MacView | null, now = new Date()) {
  const mark = watch ? new Date(watch.watchedThrough) : now;
  const free =
    !watch ||
    watch.asleep ||
    (now.getTime() - Date.parse(watch.heardAt) >= MAC_SILENCE_MS &&
      mark.getTime() >= Date.parse(watch.heardAt));
  return free && now > mark ? now : mark;
}

// Not strict, nor are the answers: a newer helper may add fields, and an older server must still
// hear it.
const Instant = z.iso.datetime({ offset: true });
const Seq = z.int().min(1);
const EventFrame = z.discriminatedUnion("type", [
  z.object({
    at: Instant,
    capturing: z.array(z.string().min(1).max(200)).max(200),
    seq: Seq,
    type: z.literal("mic"),
  }),
  z.object({ at: Instant, seq: Seq, type: z.literal("sleep") }),
]);
const CallId = z.string().min(1).max(100);
const Hello = z.object({
  engines: z.array(z.enum(macEngines)),
  // The calls the Mac still runs, from before this socket.
  running: z.array(CallId).max(100).default([]),
  type: z.literal("hello"),
});
const LlmOutput = z.discriminatedUnion("type", [
  z.object({
    final: z.string().optional(),
    id: CallId,
    status: z.int(),
    stderr: z.string(),
    stdout: z.string(),
    timedOut: z.boolean(),
    type: z.literal("llm.output"),
  }),
  z.object({
    id: CallId,
    signedOut: z.boolean(),
    type: z.literal("llm.unrun"),
    unrun: z.string(),
  }),
]);
const FromMac = z.union([Hello, LlmOutput]);

// One model call for the Mac, as sent (with its type, id and timeout).
export interface MacCall {
  effort?: string | undefined;
  engine: MacEngine;
  maxTokens: number;
  // The model to run through the selected CLI.
  model: string;
  prompt: string;
  schema: Record<string, unknown>;
  system: string;
}

// Whether model calls run on the Mac now; when not, an auth or limit failure says why (null:
// away or asleep). In the feed as `macLlm`.
export interface MacLlm {
  able: boolean;
  reason: Unable | null;
}
type Unable = "auth" | "limit";

// What becomes of an answer that comes after its call failed.
export type Late = (reply: ModelReply) => void;

interface Queued {
  call: MacCall;
  id: string;
  late: Late | undefined;
  reject: (error: Error) => void;
  resolve: (reply: ModelReply) => void;
}
interface Pending extends Queued {
  sentAt: number;
  timer: ReturnType<typeof setTimeout>;
}

interface Session {
  // Said "sleep": closing.
  asleep: boolean;
  // The engines its hello listed; null until it said hello.
  engines: MacEngine[] | null;
  // An event failed: the socket is closing, and nothing more on it counts.
  failed: boolean;
  heardAt: Date;
}
type Socket = ServerWebSocket<Session>;

// What the phone reads in the feed (openapi `MacWatch`).
export interface MacView {
  asleep: boolean;
  heardAt: string;
  watchedThrough: string;
}

export type MacSocket = ReturnType<typeof macSocket>;

export function macSocket(db: Db, { timeoutMs = LLM_TIMEOUT_MS } = {}) {
  // The socket that said hello last.
  let current: Socket | null = null;
  // Calls on the Mac, and calls waiting for a slot.
  const pending = new Map<string, Pending>();
  let queue: Queued[] = [];
  // Calls that failed but may still be answered, by id.
  const lateOnes = new Map<string, { engine: MacEngine; late: Late }>();
  // Each engine's last auth or limit failure: a limit on one plan says nothing about the other.
  const unable = new Map<MacEngine, { reason: Unable; until: number }>();
  let onAble: (() => void) | null = null;
  let onState: (() => void) | null = null;
  // Calls the Mac said it still runs that aren't pending here (from before a restart, or failed here
  // already): they hold its slots until they answer, or the next hello says they ended.
  let foreign = new Set<string>();
  // When the dictation rules next change by time alone (a dictation done waiting, a flag let go).
  let tick: ReturnType<typeof setTimeout> | null = null;

  const unableNow = (engine: MacEngine = switches().engine): Unable | null => {
    const hold = unable.get(engine);
    return hold && hold.until > Date.now() ? hold.reason : null;
  };
  // Said hello, awake, and not held back by an auth or limit failure.
  const able = (engine: MacEngine = switches().engine) =>
    Boolean(current?.data.engines?.includes(engine) && !current.data.asleep) &&
    unableNow(engine) === null;
  // Sends what waits while the Mac has a free slot.
  const pump = () => {
    while (pending.size + foreign.size < MAC_SLOTS) {
      const next = queue.shift();
      if (!next) {
        return;
      }
      send(next);
    }
  };
  const send = (queued: Queued) => {
    const ws = current;
    if (!(ws && able(queued.call.engine))) {
      queued.reject(new MacGone("the Mac is away"));
      return;
    }
    const { id } = queued;
    const timer = setTimeout(() => {
      record(db, "mac.llm_timeout", { id, inFlight: pending.size - 1 });
      fail(id, "no answer from the Mac");
      pump();
    }, timeoutMs);
    pending.set(id, { ...queued, sentAt: Date.now(), timer });
    const message = { id, timeoutMs: MAC_KILL_MS, type: "llm", ...queued.call };
    // 0: Bun dropped it, the socket is closing.
    if (ws.send(JSON.stringify(message)) === 0) {
      pending.delete(id);
      clearTimeout(timer);
      queued.reject(new MacGone("the Mac's socket is closing"));
    }
  };
  // A sent call fails with MacGone; its answer may still come, for `late`.
  const fail = (id: string, why: string) => {
    const call = pending.get(id);
    if (!call) {
      return;
    }
    pending.delete(id);
    clearTimeout(call.timer);
    call.reject(new MacGone(why));
    if (call.late) {
      lateOnes.set(id, { engine: call.call.engine, late: call.late });
      setTimeout(() => lateOnes.delete(id), LATE_MS).unref();
    }
  };
  // Calls fail with MacGone (only `engine`'s when given), the sent ones too unless `sent` is
  // false: their runs wait for the Mac.
  const gone = (
    why: string,
    { engine, sent = true }: { engine?: MacEngine; sent?: boolean } = {}
  ) => {
    const hit = (c: Queued) => engine === undefined || c.call.engine === engine;
    for (const [id, call] of pending) {
      if (sent && hit(call)) {
        fail(id, why);
      }
    }
    for (const call of queue.filter(hit)) {
      call.reject(new MacGone(why));
    }
    queue = queue.filter((c) => !hit(c));
    pump();
  };
  // An answer to a call that already failed: its run keeps it when usable.
  const answerLate = (id: string, output: MacOutput) => {
    if (foreign.delete(id)) {
      pump();
    }
    const late = lateOnes.get(id);
    lateOnes.delete(id);
    const reply = late ? macAnswer(late.engine, output) : null;
    record(db, "mac.llm_late", { id, kept: Boolean(reply?.ok) });
    if (late && reply?.ok) {
      late.late(reply);
    }
  };
  const answer = (message: z.infer<typeof LlmOutput>) => {
    const output: MacOutput =
      message.type === "llm.unrun"
        ? { signedOut: message.signedOut, unrun: message.unrun }
        : message;
    const call = pending.get(message.id);
    if (!call) {
      return answerLate(message.id, output);
    }
    pending.delete(message.id);
    clearTimeout(call.timer);
    pump();
    const ms = Date.now() - call.sentAt;
    const { engine, model } = call.call;
    const reply = macAnswer(engine, output);
    if (reply.ok) {
      record(db, "mac.llm", {
        engine,
        id: message.id,
        inputTokens: reply.inputTokens,
        model,
        ms,
        outputTokens: reply.outputTokens,
      });
      call.resolve(reply);
      return;
    }
    record(db, "mac.llm_error", {
      detail: reply.detail,
      engine,
      id: message.id,
      model,
      ms,
      reason: reply.reason,
    });
    if (reply.reason === "auth" || reply.reason === "limit") {
      // That engine's calls wait; the other engine's go on.
      markUnable(engine, reply.reason);
      call.reject(new MacGone(`${engine} can't run: ${reply.reason}`));
      gone(`${engine} can't run: ${reply.reason}`, { engine });
      return;
    }
    call.reject(new Error(`the Mac's model call failed: ${reply.reason}`));
  };
  // The Mac said an engine can't run (signed out, or at its limit): for UNABLE_MS.
  const markUnable = (engine: MacEngine, reason: Unable) => {
    unable.set(engine, { reason, until: Date.now() + UNABLE_MS });
    record(db, "mac.llm_unable", {
      engine,
      minutes: UNABLE_MS / 60_000,
      reason,
    });
    // The feed's `mac.llm` changed: wake its long polls.
    logged("mac change", () =>
      db.transaction((tx) => logChange(tx, "mac", "mac"))
    );
  };

  const stored = (ranges: DictatedRange[]) => {
    for (const r of ranges) {
      record(db, "quiet_range.stored", {
        seconds: (r.endedAt - r.startedAt) / 1000,
        source: r.source,
      });
    }
  };
  // Records an applied event. Only dictation apps are named: the other processes capturing (calls,
  // browsers) are counted, never stored. The helper's own log names them, to find a missing app.
  const told = (fact: MacReport, ranges: DictatedRange[]) => {
    const capturing = fact.kind === "mic" ? fact.capturing : [];
    const dictating = capturing.filter(isDictationApp);
    record(db, "mac.event", {
      dictating: fact.kind === "mic" ? dictating.join(",") : null,
      kind: fact.kind,
      others: capturing.length - dictating.length,
    });
    stored(ranges);
  };
  // Settles the dictation rules when time alone next changes them, as far as the Mac is known:
  // now while a socket is open, else when it was last heard. The watermark may move.
  const schedule = () => {
    if (tick) {
      clearTimeout(tick);
    }
    const state = macRow(db)?.state;
    const due = state ? nextChange(state) : null;
    if (due === null) {
      return;
    }
    tick = setTimeout(
      () => {
        tick = null;
        logged("mac settle", () => {
          const known = current ? new Date() : (macRow(db)?.heardAt ?? null);
          if (known) {
            stored(settleMac(db, known));
          }
        });
        onState?.();
        if (current) {
          schedule();
        }
      },
      Math.max(0, due - Date.now())
    );
    tick.unref();
  };

  // Applies an event and acks it on the same socket. Whatever stops that (an invalid frame, the
  // database) closes the socket unacked and blocks the watermark: the helper sends it again, in
  // order, on the next one, and its applying clears the block.
  const event = (ws: Socket, body: unknown) => {
    const parsed = EventFrame.safeParse(body);
    if (!parsed.success) {
      record(db, "mac.event_invalid", {
        issue: parsed.error.issues[0]?.message.slice(0, 100) ?? null,
      });
      return refuse(ws, "invalid event", MAC_INVALID);
    }
    const { data } = parsed;
    // In server time: a Mac clock running ahead puts no hold or range in the server's future.
    const sent = Date.parse(data.at);
    const at = Math.min(sent, Date.now());
    const fact: MacReport =
      data.type === "mic"
        ? { at, capturing: data.capturing, kind: "mic" }
        : { at, kind: "sleep" };
    try {
      const applied = applyMacEvent(db, { ...fact, sent, seq: data.seq });
      if (applied === "behind") {
        record(db, "mac.seq_behind", { seq: data.seq });
        return refuse(ws, "seq behind", MAC_BEHIND);
      }
      if (applied) {
        told(fact, applied.ranges);
      }
    } catch (error: unknown) {
      record(db, "mac.event_failed", {
        error: String(error).slice(0, 100),
        seq: data.seq,
      });
      return refuse(ws, "event not stored", 1011);
    }
    ws.data.asleep ||= fact.kind === "sleep";
    ws.data.heardAt = new Date(Math.max(at, ws.data.heardAt.getTime()));
    ws.send(JSON.stringify({ seq: data.seq, type: "ack" }));
    schedule();
    onState?.();
  };
  // Closes the socket and holds the watermark until an event applies again: a stuck Mac, shown as
  // `mac.stuck` and as macAway on the conversations it holds. The close code says why (MAC_INVALID:
  // the helper drops that event; MAC_BEHIND: its next welcome renumbers it; 1011: it tries again).
  const refuse = (ws: Socket, why: string, code: number) => {
    ws.data.failed = true;
    logged("mac block not stored", () =>
      record(db, "mac.stuck", {
        since: blockMac(db, { lost: code === MAC_INVALID }).toISOString(),
        why,
      })
    );
    onState?.();
    ws.close(code, why);
  };

  // Usage frames store facts; events go through the rules; hello and model output continue to the
  // live dispatcher.
  const readFrame = (ws: Socket, raw: string | Buffer) => {
    try {
      const body: unknown = JSON.parse(String(raw));
      const usage = SubscriptionMessage.safeParse(body);
      if (usage.success) {
        try {
          storeSubscriptionUsage(db, usage.data);
        } catch {
          record(db, "mac.usage_store_failed", {
            engine: usage.data.engine,
          });
        }
        return null;
      }
      const type = (body as { type?: unknown } | null)?.type;
      if (type === "mic" || type === "sleep") {
        event(ws, body);
        return null;
      }
      return FromMac.parse(body);
    } catch {
      record(db, "mac.ignored", { bytes: String(raw).length });
      return null;
    }
  };
  const heard = (ws: Socket) => {
    if (ws.data.engines && !ws.data.failed) {
      ws.data.heardAt = new Date();
    }
  };

  return {
    able,
    // When the dictation under way began, while the open socket's rules still count it.
    dictatingSince: () => {
      const row = current ? macRow(db) : undefined;
      const since = row ? dictatingSince(row.state, Date.now()) : null;
      return since === null ? null : new Date(since).toISOString();
    },
    // The live view while a socket said hello, else null (the stored row stands).
    live(): MacView | null {
      const row = current ? macRow(db) : undefined;
      return current && row
        ? macView(
            { heardAt: current.data.heardAt, state: row.state },
            new Date()
          )
        : null;
    },
    // One model call on the Mac, sent when a slot is free. Rejects with MacGone when it isn't
    // able, closes, or leaves this call unanswered.
    llm(call: MacCall, late?: Late): Promise<ModelReply> {
      if (!able(call.engine)) {
        return Promise.reject(new MacGone("the Mac is away"));
      }
      return new Promise((resolve, reject) => {
        queue.push({ call, id: randomUUID(), late, reject, resolve });
        pump();
      });
    },
    llmState: (): MacLlm => ({ able: able(), reason: unableNow() }),
    // Called each time the Mac becomes able: a socket's hello.
    onAble(listener: () => void) {
      onAble = listener;
    },
    // Called whenever the watermark may move: a hello, an event, the rules settling.
    onState(listener: () => void) {
      onState = listener;
    },
    // Tests only: forgets every auth or limit failure.
    resetUnable() {
      unable.clear();
    },
    // Since when a refused event blocks the watermark, else null (`mac.stuck` recorded it). The
    // conversations ending after it are held by the watermark (grouping.ts: waiting reason
    // macAway).
    stuckSince(): Date | null {
      const since = macRow(db)?.state.blockedSince ?? null;
      return since === null ? null : new Date(since);
    },
    // Called once the Mac's token passed, with Hono's env: Bun's server, or nothing under
    // `app.request` (then false).
    upgrade(request: Request, env: unknown) {
      return (
        (env as Server<Session> | undefined)?.upgrade(request, {
          data: {
            asleep: false,
            engines: null,
            failed: false,
            heardAt: new Date(),
          },
        }) ?? false
      );
    },
    // `vouchedThrough` on the live view, else the stored row.
    vouchedThrough(now = new Date()) {
      const live = this.live();
      const row = live ? undefined : macRow(db);
      return vouchedThrough(live ?? (row ? macView(row) : null), now);
    },
    websocket: {
      close(ws: Socket, code: number, reason: string) {
        // Not current: a newer socket took over, or this one never said hello.
        record(db, "mac.close", {
          code,
          current: ws === current,
          reason: reason.slice(0, 100),
        });
        if (ws !== current) {
          return;
        }
        current = null;
        // Calls sent stay: the Mac answers them on its next socket, or their timers fail them.
        gone("the Mac's socket closed", { sent: false });
        logged("mac watch not stored", () => {
          storeMacHeard(db, ws.data.heardAt);
          // A dictation waiting for a neighbour goes now: a shutdown never holds the watermark.
          stored(settleMac(db, ws.data.heardAt, { closed: true }));
        });
        onState?.();
      },
      // Pings every 30 s from the helper keep it under this.
      idleTimeout: 70,
      message(ws: Socket, raw: string | Buffer) {
        if (ws.data.failed) {
          return;
        }
        const message = readFrame(ws, raw);
        if (!message) {
          return;
        }
        if (message.type !== "hello") {
          heard(ws);
          answer(message);
          return;
        }
        record(db, "mac.hello", {
          engines: message.engines.join(","),
          running: message.running.length,
        });
        foreign = new Set(message.running.filter((id) => !pending.has(id)));
        const wasAble = able();
        current = ws;
        ws.data.engines = message.engines;
        ws.data.asleep = false;
        ws.data.heardAt = new Date();
        // A hello means the Mac is awake: it opens a socket only then.
        logged("mac watch not stored", () =>
          stored(storeMacHeard(db, ws.data.heardAt, { awake: true }))
        );
        schedule();
        if (!wasAble && able()) {
          onAble?.();
        }
        onState?.();
      },
      // The helper waits for this before its outbox. A file no welcome has numbered yet (the old one
      // lost) goes above the last applied, so it is never taken for a resend; a numbered one keeps its
      // seqs, so an event applied whose ack was lost is acked again, never applied again out of order.
      open(ws: Socket) {
        record(db, "mac.open", { replaced: current !== null });
        const row = macRow(db);
        ws.send(
          JSON.stringify({ lastSeq: row?.lastSeq ?? 0, type: "welcome" })
        );
      },
      ping: heard,
      pong: heard,
    },
  };
}
