import { openChecksNow } from "../host/inbox";
import { readPeopleAndOrganizations } from "../host/matter-rows";
import {
  readsOnce,
  refsProblemOf,
  type SharedReads,
} from "../memory/find-refs";
import { openById } from "../memory/open-by-id";
import { lifeRefsOf, parseRef } from "../memory/refs";
import {
  type AnswerBlock,
  blockRefsOf,
  blockSourceOf,
  blockSplitter,
  parseBlock,
  valueProblemOf,
} from "../records/answer-blocks";
import type { Desk } from "./desk-store";

// What a main session's turn shows his phone beside its words (`main-session.ts`): a step for each tool call, written by
// code from the tool and its arguments, and each block once it passed its checks.

/** The kinds a block's `items` may name besides his inbox's asks: cards, matters and their steps. */
const ITEM_KINDS = new Set(["card", "matter", "observation"]);

const SETTINGS_FENCE = /```life:settings\n(.*?)\n```/gs;
/** The settings offered in the answers so far, per store: read once from them, then kept as each offer is drawn. */
const offered = new WeakMap<Desk["db"], Set<string>>();
function offeredOf(db: Desk["db"]) {
  let keys = offered.get(db);
  if (!keys) {
    keys = new Set();
    const answers = db
      .query<{ answer: string }, []>(
        "select answer from thread_entry where instr(answer, '```life:settings') > 0"
      )
      .all();
    for (const { answer } of answers) {
      for (const [, json = ""] of answer.matchAll(SETTINGS_FENCE)) {
        try {
          const key = (JSON.parse(json) as { offer?: { key?: unknown } }).offer
            ?.key;
          if (typeof key === "string") {
            keys.add(key);
          }
        } catch {
          // not a block Life drew
        }
      }
    }
    offered.set(db, keys);
  }
  return keys;
}

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
  // Each setting is offered once, whatever he did with it: a settings block has nothing else to check, so it is drawn.
  if (offer) {
    const keys = offeredOf(db);
    if (keys.has(offer.key)) {
      return "offered";
    }
    keys.add(offer.key);
  }
  const all = blockRefsOf(b);
  // An `items` ref may be any ask his inbox holds (a fix, a your move, a voice…), by the ref `read_inbox` gives it and
  // his phone draws it by: open now, so nothing more to find. Read only when a ref is of no other item kind.
  const isOther = (r: string) => {
    const ref = parseRef(r);
    return "error" in ref || !ITEM_KINDS.has(ref.kind);
  };
  const asks =
    b.kind === "items" && all.some(isOther)
      ? new Set((await openChecksNow()).map((c) => c.ref))
      : new Set<string>();
  const refs = all.filter((r) => !asks.has(r));
  const wrong = refs.find((r) => {
    if (b.kind === "items") {
      return isOther(r);
    }
    const ref = parseRef(r);
    return "error" in ref || (b.kind === "pictures" && ref.kind !== "file");
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

/**
 * Markdown `text` as his thread may show it (an agent's late reply): its words, and only its blocks that pass
 * `blockProblemOf`, in order; with the refs it cites.
 */
export async function checkedTextOf(db: Desk["db"], text: string) {
  const reads = readsOnce();
  const parts: (string | Promise<string>)[] = [];
  const refs: string[] = [];
  const splitter = blockSplitter({
    block: (f, isOpen) => {
      const b = isOpen ? { error: "open" } : parseBlock(f);
      parts.push(
        "error" in b
          ? ""
          : blockProblemOf(db, b, reads).then((why) => {
              if (why) {
                return "";
              }
              refs.push(...blockRefsOf(b));
              return `\`\`\`life:${b.kind}\n${JSON.stringify(b.body)}\n\`\`\`\n`;
            })
      );
    },
    words: (t) => parts.push(t),
  });
  splitter.push(text);
  splitter.end();
  const checked = (await Promise.all(parts)).join("").trim();
  return {
    refs: [...new Set([...lifeRefsOf(checked), ...refs])],
    text: checked,
  };
}
