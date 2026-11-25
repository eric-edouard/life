import { readPeopleAndOrganizations } from "../host/matter-rows";
import { refsProblemOf, type SharedReads } from "../memory/find-refs";
import { openById } from "../memory/open-by-id";
import { parseRef } from "../memory/refs";
import {
  type AnswerBlock,
  blockRefsOf,
  blockSourceOf,
  valueProblemOf,
} from "../records/answer-blocks";
import type { Desk } from "./desk-store";

// What a main session's turn shows his phone beside its words (`main-session.ts`): a step for each tool call, written by
// code from the tool and its arguments, and each block once it passed its checks.

/** The kinds a block's `items` may name: asks, matters and their steps. */
const ITEM_KINDS = new Set(["card", "matter", "observation"]);

/** Whether setting `key` was offered in an earlier answer: each is offered once, whatever he did with it. */
const wasOffered = (db: Desk["db"], key: string) =>
  db
    .query("select 1 from thread_entry where instr(answer, ?) > 0 limit 1")
    .get(`"offer":${JSON.stringify({ key }).slice(0, -1)}`) !== null;

/**
 * Why block `b` can't be drawn: a setting offered before, a ref of the wrong kind or that opens nothing, or a written
 * value not in its `from` (`valueProblemOf`, over the text `fetch` shows of it); none when it can.
 */
export async function blockProblemOf(
  db: Desk["db"],
  b: AnswerBlock,
  reads: SharedReads
) {
  const offer =
    b.kind === "settings" && (b.body as { offer?: { key: string } }).offer;
  if (offer && wasOffered(db, offer.key)) {
    return "offered";
  }
  const refs = blockRefsOf(b);
  const wrong = refs.find((r) => {
    const ref = parseRef(r);
    return (
      "error" in ref ||
      (b.kind === "items" && !ITEM_KINDS.has(ref.kind)) ||
      (b.kind === "pictures" && ref.kind !== "file")
    );
  });
  if (wrong) {
    return "refs";
  }
  if (await refsProblemOf(refs, reads, (r) => r, "a ref")) {
    return "refs";
  }
  const from = blockSourceOf(b);
  if (!from) {
    return;
  }
  const shown = await openById(
    from,
    undefined,
    undefined,
    readPeopleAndOrganizations,
    reads
  );
  return valueProblemOf(
    b,
    typeof shown === "string" ? shown : JSON.stringify(shown)
  )
    ? "values"
    : undefined;
}

/** The verb and object of a step, by the tool and what it is given (never a tool's name, an agent's or a ref). */
const STEPS: Record<
  string,
  (args: Record<string, unknown>) => [string, string]
> = {
  change_appointment: () => ["Updating", "your calendar"],
  change_directory_entry: () => ["Updating", "your people and projects"],
  change_registered_agent: () => ["Arranging", "the work"],
  change_todo_item: () => ["Updating", "your list"],
  complain: () => ["Passing on", "what went wrong"],
  correct_memory: () => ["Updating", "what Life knows"],
  fetch: () => ["Opening", "what Life holds"],
  read_assignment: () => ["Checking on", "the work"],
  read_chats: () => ["Reading", "your chats"],
  read_day: () => ["Reading", "your day"],
  read_inbox: () => ["Reading", "what waits on you"],
  read_matter: () => ["Opening", "the matter"],
  read_matters: () => ["Reading", "your matters"],
  read_people_and_organizations: (a) => [
    "Looking up",
    typeof a.name === "string" ? a.name : "your people",
  ],
  request_decision: () => ["Preparing", "an ask"],
  search: (a) => [
    "Searching",
    typeof a.query === "string" ? `for “${a.query}”` : "your life",
  ],
  tell_agent: (a) =>
    a.kind === "question"
      ? ["Checking on", "the work"]
      : ["Handing on", "the work"],
  tell_life: () => ["Remembering", "that"],
  web_search: (a) => [
    "Searching the web",
    typeof a.query === "string" ? `for “${a.query}”` : "",
  ],
};

/** A tool call as a step on his screen, by its tool's name (a runtime's prefix dropped) and its arguments when given. */
export function stepOf(title: string, args: Record<string, unknown> = {}) {
  const name = title.split("__").at(-1) ?? title;
  const [verb, what] = STEPS[name]?.(args) ?? ["Looking", "into it"];
  return { kind: "step" as const, verb, what };
}
