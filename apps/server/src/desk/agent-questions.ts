import { randomBytes } from "node:crypto";
import { clock, MIN } from "../core/clock";
import { log } from "../core/log";
import { agentOf, assignmentOf } from "../host/desk-read";
import type { Desk } from "./desk-store";
import { queue } from "./event-queue";
import { checkedTextOf } from "./main-session-lines";

// The main session's question to an agent about its matter (agents together, his yes of 25 Nov 2026): the agent's
// side. One turn at once (`main_question`, woken like his answer), his words read at the door as data
// (`readQuestion`), the reply handed back (`answerQuestion`); research stays in the agent's context. Its `finish` and
// `set_wait` are refused while his words are unread (`turnRefusalOf`). A reply past `QUESTION_WAIT`, once the main
// session answered from the record, lands in his thread as an entry that follows his ask (`follows`, v4.1); a question
// stays answerable until a turn of its assignment that began after it ends, in the store across a restart of the helper.

/** The event a question queues, and its turn's cause. */
export const MAIN_QUESTION = "main_question";

/** How long the main session waits for a question's reply: past it, it answers from the record and the reply comes later. */
export const QUESTION_WAIT = MIN;

interface QuestionRow {
  asked_at: string;
  assignment_id: string;
  /** His thread entry it was asked from, which a late reply follows. */
  entry: number | null;
  read_at: string | null;
  words: string;
}

/** The main session's wait for a reply: this process's only, so a reply after a restart is a late one. */
interface Waiter {
  /** Whether the main session stopped waiting for it (`QUESTION_WAIT`): its reply then lands as an entry of its own. */
  isLate: boolean;
  reply: PromiseWithResolvers<string>;
}
const held = new WeakMap<Desk["db"], Map<string, Waiter>>();
const waitersOf = (db: Desk["db"]) => {
  const w = held.get(db) ?? new Map<string, Waiter>();
  held.set(db, w);
  return w;
};

/**
 * Question `id`, while answerable: kept in the store, so it outlives a restart of the desk helper. One goes once a turn
 * of its assignment that began after it ended, so its agent is never held by it; a turn cut by a restart (`cut`) does
 * not count.
 */
function questionRowOf(db: Desk["db"], id: string) {
  dropExpired(db);
  return db
    .query<QuestionRow, [string]>("select * from main_question where id = ?")
    .get(id);
}
function dropExpired(db: Desk["db"]) {
  const gone = db
    .query<{ id: string }, []>(
      "delete from main_question where exists (select 1 from turn t where t.assignment_id = main_question.assignment_id and t.started_at >= main_question.asked_at and t.ended_at is not null and t.outcome is not 'cut') returning id"
    )
    .all();
  for (const { id } of gone) {
    waitersOf(db).delete(id);
  }
}

/**
 * Asks open assignment `assignment` his words `words` (the main session's, found in his ask of thread entry `entry`):
 * queues `main_question`, which wakes its agent at once. Its id, the reply, which settles when the agent answers
 * (`answerQuestion`) before `late` is called, and `late`: the main session stops waiting, so a reply after it is an
 * entry of its own that follows `entry`. Refused for an assignment not open, or the main session's own.
 */
export function askAssignment(
  desk: Desk,
  assignment: string,
  words: string,
  entry: number | null = null
) {
  const s = assignmentOf(desk.db, assignment);
  const a = s && agentOf(desk.db, s.agent_id);
  if (
    !(s && s.closed_at === null && a?.status === "active") ||
    a.role === "main"
  ) {
    return {
      error: `Not done: ${assignment} is not an open assignment of an active agent.`,
    };
  }
  const id = `q_${randomBytes(6).toString("hex")}`;
  const w: Waiter = { isLate: false, reply: Promise.withResolvers<string>() };
  waitersOf(desk.db).set(id, w);
  desk.db.transaction(() => {
    desk.db.run(
      "insert into main_question (id, assignment_id, asked_at, entry, words) values (?, ?, ?, ?, ?)",
      [id, assignment, clock().toISOString(), entry, words]
    );
    queue(desk.db, MAIN_QUESTION, [
      { assignment, eventId: id, payload: { question: id } },
    ]);
  })();
  return {
    id,
    late: () => {
      w.isLate = true;
    },
    reply: w.reply.promise,
  };
}

/** Question `id` of assignment `s`, or why not. */
function questionOf(db: Desk["db"], s: { id: string }, id: string) {
  const q = questionRowOf(db, id);
  if (q?.assignment_id !== s.id) {
    throw new Error(`Not done: ${id} is no question to ${s.id}.`);
  }
  return q;
}

/** `read_question`: his words of question `id` to assignment `s`, as data; read, its turn may then end. */
export function readQuestion({ db }: Desk, s: { id: string }, id: string) {
  const q = questionOf(db, s, id);
  db.run(
    "update main_question set read_at = coalesce(read_at, ?) where id = ?",
    [clock().toISOString(), id]
  );
  return { words: q.words };
}

/**
 * `answer_question`: the agent's reply to question `id`, handed to the main session; or, once it stopped waiting, a
 * thread entry of the reply alone (its blocks checked, `checkedTextOf`) that follows his ask, while that entry stands
 * (none for an ask with no entry, or one deleted or blanked). The question is done.
 */
export async function answerQuestion(
  { db }: Desk,
  s: { id: string },
  id: string,
  text: string
) {
  const q = questionOf(db, s, id);
  const done = () => db.run("delete from main_question where id = ?", [id]);
  const w = waitersOf(db).get(id);
  waitersOf(db).delete(id);
  if (w && !w.isLate) {
    done();
    w.reply.resolve(text);
    return { answered: id };
  }
  const checked = q.entry === null ? null : await checkedTextOf(db, text);
  // The reply's entry and the question's end in one write: a restart between them never loses the reply.
  db.transaction(() => {
    done();
    if (checked?.text) {
      db.run(
        "insert into thread_entry (asked_at, answer, refs, answered_at, follows) select ?1, ?2, ?3, ?1, id from thread_entry where id = ?4 and deleted_at is null",
        [
          clock().toISOString(),
          checked.text,
          JSON.stringify(checked.refs),
          q.entry,
        ]
      );
    }
  })();
  if (checked?.text) {
    log("desk.turn", { entry: q.entry, what: "question.late_reply" });
  }
  return { answered: id, late: true };
}

/** Whether assignment `s` holds a question whose words its agent has not read: it may not end its turn yet. */
export function hasUnreadQuestion(db: Desk["db"], s: { id: string }) {
  dropExpired(db);
  return !!db
    .query(
      "select 1 from main_question where assignment_id = ? and read_at is null"
    )
    .get(s.id);
}
