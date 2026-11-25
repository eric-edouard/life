import { randomBytes } from "node:crypto";
import { clock, MIN } from "../core/clock";
import { agentOf, assignmentOf } from "../host/desk-read";
import type { Desk } from "./desk-store";
import { queue } from "./event-queue";

// The main session's question to an agent about its matter (agents together, his yes of 25 Nov 2026): the agent's
// side. One turn at once (`main_question`, woken like his answer), his words read at the door as data
// (`readQuestion`), the reply handed back (`answerQuestion`); research stays in the agent's context. Its `finish` and
// `set_wait` are refused while his words are unread (`turnRefusalOf`).

/** The event a question queues, and its turn's cause. */
export const MAIN_QUESTION = "main_question";

/** How long a question waits for its reply: the main session answers from the record past it, and the question goes. */
export const QUESTION_WAIT = MIN;

interface Question {
  assignment: string;
  /** When it was asked (ms). */
  at: number;
  isRead: boolean;
  reply: PromiseWithResolvers<string>;
  words: string;
}

// ponytail: held in the desk helper's memory, as the main session's wait is: a restart drops an unanswered question
// (its turn then reads nothing); store them if questions must outlive a restart.
const held = new WeakMap<Desk["db"], Map<string, Question>>();
/** The questions still waiting for their reply: one past `QUESTION_WAIT` goes, so its agent is never held by it. */
const questionsOf = (db: Desk["db"]) => {
  const q = held.get(db) ?? new Map<string, Question>();
  held.set(db, q);
  for (const [id, x] of q) {
    if (clock().getTime() - x.at > QUESTION_WAIT) {
      q.delete(id);
    }
  }
  return q;
};

/**
 * Asks open assignment `assignment` his words `words` (the main session's, found in his ask): queues `main_question`,
 * which wakes its agent at once. Its id and the reply, which settles when the agent answers (`answerQuestion`) within
 * `QUESTION_WAIT`; past it the question goes and never settles. Refused for an assignment not open, or the main
 * session's own.
 */
export function askAssignment(desk: Desk, assignment: string, words: string) {
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
  const reply = Promise.withResolvers<string>();
  questionsOf(desk.db).set(id, {
    assignment,
    at: clock().getTime(),
    isRead: false,
    reply,
    words,
  });
  queue(desk.db, MAIN_QUESTION, [
    { assignment, eventId: id, payload: { question: id } },
  ]);
  return { id, reply: reply.promise };
}

/** Question `id` of assignment `s`, or why not. */
function questionOf(db: Desk["db"], s: { id: string }, id: string) {
  const q = questionsOf(db).get(id);
  if (q?.assignment !== s.id) {
    throw new Error(`Not done: ${id} is no question to ${s.id}.`);
  }
  return q;
}

/** `read_question`: his words of question `id` to assignment `s`, as data; read, its turn may then end. */
export function readQuestion({ db }: Desk, s: { id: string }, id: string) {
  const q = questionOf(db, s, id);
  q.isRead = true;
  return { words: q.words };
}

/** `answer_question`: the agent's reply to question `id`, handed to the main session; the question is done. */
export function answerQuestion(
  { db }: Desk,
  s: { id: string },
  id: string,
  text: string
) {
  questionOf(db, s, id).reply.resolve(text);
  questionsOf(db).delete(id);
  return { answered: id };
}

/** Whether assignment `s` holds a question whose words its agent has not read: it may not end its turn yet. */
export const hasUnreadQuestion = (db: Desk["db"], s: { id: string }) =>
  [...questionsOf(db).values()].some((q) => q.assignment === s.id && !q.isRead);
