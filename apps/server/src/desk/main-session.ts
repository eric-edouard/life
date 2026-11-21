import { clock } from "../core/clock";
import { log } from "../core/log";
import { errorOf } from "../core/log-line";
import { isOwnLife } from "../core/platform";
import {
  agentOf,
  assignmentOf,
  openTurn,
  turnModelOf,
} from "../host/desk-read";
import { MOVE_REASONS } from "../host/move-read";
import type {
  MainSessionAnswer,
  MainSessionAsk,
  MainSessionLine,
} from "../records/main-session-wire";
import { readPacket } from "./agent-actions";
import type { Desk } from "./desk-store";
import {
  roleAssignmentOf,
  roleStartBlockOf,
  standingAgentOf,
} from "./role-agents";
import { SessionLive, type Update } from "./runtimes/contract";
import {
  claimTurn,
  recordSession,
  sessionAgentOf,
  turnEnded,
  watch,
} from "./turn-ends";

// The main session (Tell Life, his decisions of 21 Nov 2026; the study of that day): the registered agent in role
// `main`, registered by the desk on his first words, woken only by them (never by the clock: `dueOf`). Each ask is one
// desk turn (cause `main_ask`, outcome `replied` from its start: `turnEnded` closes it with its usage, no reminder, no
// wait) on one session the runtime keeps open across asks (`Runtime.talk`), so his next words pay no start; his presence
// on the Tell Life screen keeps it open (`keepMainSession`). It only answers in this slice: its door refuses it every tool
// on its turn (`desk-door.ts`) and the send guard its connector's writes; the rest (it runs as one of his own sessions,
// shell and files included) rests on its brief.

/** A main session turn's cause: his words through Tell Life. */
export const MAIN_ASK = "main_ask";

/** The main session's brief: what it is, how it answers. His words come in each message after it. */
export const MAIN_BRIEF =
  "You are Life's main session. He talks to you from his phone (Tell Life): each message holds his words and the refs on his screen. Read Life through your Life connector (`fetch` opens a ref) and answer him in two short sentences at most, in his language, with no preamble and no emoji: your text is shown to him as you write it, and your text after your last tool call is your answer. For now you only read and answer: change nothing and send nothing; anything for someone else stays a card he taps.";

/** How many asks are kept by his app's key: a retry of one replays its lines and ends as it does, never asks twice. */
const ASKS_KEPT = 20;

interface Heard {
  end: Promise<MainSessionAnswer>;
  hearers: Set<(l: MainSessionLine) => void>;
  lines: MainSessionLine[];
  words?: string;
}
const asksOf = new WeakMap<Desk["db"], Map<string, Heard>>();

/** The main session's agent and its own assignment: registered when none stands, else why there is none. */
async function mainOf(desk: Desk) {
  const { db } = desk;
  const blocked = await roleStartBlockOf(desk, "main", () =>
    clock().toISOString()
  );
  const place = db.transaction(() =>
    roleAssignmentOf(desk, "main", MAIN_BRIEF, blocked)
  )();
  if ("why" in place) {
    return place;
  }
  const s = assignmentOf(db, place.assignment);
  const a = s && agentOf(db, s.agent_id);
  return a && s ? { a, s } : { why: "the main session is not registered" };
}

/**
 * His presence on the Tell Life screen: keeps the main session's session open, when it stands and has one (none: his
 * first words register it and make it; presence registers nothing). Why not, when it can't.
 */
export async function keepMainSession(desk: Desk) {
  const a = standingAgentOf(desk.db, "main");
  const runtime = a && desk.runtimes[a.runtime];
  if (!(a?.status === "active" && a.session && runtime)) {
    if (a?.status === "stopped") {
      return "Life's main session is stopped.";
    }
    return a?.session && !runtime
      ? MOVE_REASONS.blocked(a.runtime)
      : "Life's main session opens on your first words.";
  }
  try {
    await runtime.keep(sessionAgentOf(a), a.session);
  } catch (error) {
    log("desk.runtime", {
      agent: a.id,
      ...errorOf(error),
      ok: false,
      what: "keep",
    });
    return errorOf(error).error;
  }
}

/** The message of one ask: his words as he sent them, and his screen's refs. */
const messageOf = (ask: MainSessionAsk) =>
  [
    `His words, through Tell Life: ${JSON.stringify(ask.words)}`,
    ...(ask.screen
      ? [
          `On his screen (refs; \`fetch\` opens one): ${JSON.stringify(ask.screen)}`,
        ]
      : []),
  ].join("\n");

/** One ask, as one turn of the main session: each line `say`s as it comes; its answer. */
async function answer(
  desk: Desk,
  ask: MainSessionAsk,
  say: (l: MainSessionLine) => void,
  asked: () => void
): Promise<MainSessionAnswer> {
  const { db } = desk;
  const main = await mainOf(desk);
  if ("why" in main) {
    return { kind: "error", what: main.why };
  }
  const { a, s } = main;
  const runtime = desk.runtimes[a.runtime];
  if (!runtime) {
    return { kind: "error", what: `no runtime ${a.runtime}` };
  }
  // One ask at a time: its session answers one prompt at a time.
  const turn = db.transaction(() =>
    openTurn(db, a.id)
      ? null
      : Number(
          db.run(
            "insert into turn (agent_id, assignment_id, session, cause, started_at, model, outcome) values (?, ?, ?, ?, ?, ?, 'replied')",
            [
              a.id,
              s.id,
              a.session,
              MAIN_ASK,
              clock().toISOString(),
              turnModelOf(a),
            ]
          ).lastInsertRowid
        )
  )();
  if (turn === null) {
    return { kind: "error", what: "Life is still answering your last words." };
  }
  claimTurn(desk, turn);
  // A session gone (deleted) is made again from its packet; a kept one reads running, and is talked on.
  const state = a.session
    ? await runtime.state(a.session).catch(() => null)
    : "gone";
  const isFresh = state === "gone";
  let words = "";
  const hear = (u: Update) => {
    if (u.kind === "words") {
      words += u.text;
    } else if (u.kind === "working") {
      words = "";
    }
    say(u);
  };
  try {
    const run = await runtime.talk(
      sessionAgentOf(a),
      isFresh ? null : a.session,
      [
        ...(isFresh ? [await readPacket(desk, s, isOwnLife(), turn)] : []),
        messageOf(ask),
      ].join("\n\n"),
      hear
    );
    // His words reached the session only now: a failure before keeps no retry key, so a retry asks again.
    asked();
    watch(desk, turn, run);
    if (isFresh) {
      recordSession(desk, a, turn, run);
    }
    const end = await run.ended;
    if (!end.ok) {
      return { kind: "error", what: end.why ?? "the session failed" };
    }
    return words.trim()
      ? { kind: "reply", words: words.trim() }
      : { kind: "error", what: "Life gave no answer." };
  } catch (error) {
    // Nothing ran: a session his app holds deletes the turn, any other failure ends it failed.
    if (error instanceof SessionLive) {
      db.run("delete from turn where id = ? and begun_at is null", [turn]);
      return {
        kind: "error",
        what: "Life's main session is busy or closed: send your words again.",
      };
    }
    await turnEnded(desk, turn, { ok: false, why: errorOf(error).error });
    return { kind: "error", what: errorOf(error).error };
  }
}

/**
 * His words to the main session (`ask.words`), its lines heard by `hear` as they come; its answer. A retry under the same
 * key (one of the last `ASKS_KEPT` that reached the session) replays the lines so far and ends with the same answer: never
 * asked twice; the key with other words is refused. An ask that never reached the session (busy, no place, a session
 * that would not take it) is not kept.
 */
export function askMainSession(
  desk: Desk,
  ask: MainSessionAsk,
  hear: (l: MainSessionLine) => void
): Promise<MainSessionAnswer> {
  const byKey = asksOf.get(desk.db) ?? new Map<string, Heard>();
  asksOf.set(desk.db, byKey);
  const known = ask.key ? byKey.get(ask.key) : undefined;
  if (known && known.words !== ask.words) {
    return Promise.resolve({
      kind: "error",
      what: "Not done: this key asked other words.",
    });
  }
  if (known) {
    for (const l of known.lines) {
      hear(l);
    }
    known.hearers.add(hear);
    return known.end;
  }
  const lines: MainSessionLine[] = [];
  const hearers = new Set([hear]);
  const say = (l: MainSessionLine) => {
    lines.push(l);
    for (const h of hearers) {
      h(l);
    }
  };
  const { key } = ask;
  let isAsked = false;
  const end = answer(desk, ask, say, () => {
    isAsked = true;
  })
    .catch(
      (error: unknown): MainSessionAnswer => ({
        kind: "error",
        what: errorOf(error).error,
      })
    )
    .then((answered) => {
      if (key && !isAsked) {
        byKey.delete(key);
      }
      return answered;
    });
  if (key) {
    byKey.set(key, { end, hearers, lines, words: ask.words });
    const [oldest] = byKey.keys();
    if (byKey.size > ASKS_KEPT && oldest) {
      byKey.delete(oldest);
    }
  }
  return end;
}
