import { appendFileSync, readFileSync } from "node:fs";
import { clock } from "../../core/clock";

// A pi session's repair before it resumes (the v4 plan, bundle C, after Nod's `checkpoint.ts`): a turn killed mid-call
// (a crash, a desk restart, a stop) leaves its last tool calls with no result in the session file. pi's request would
// answer them "No result provided", which reads as if the call ran and gave nothing; each is closed instead with a
// result that says what is known: it was interrupted, and whether it ran is unknown. Only the session's trailing calls:
// a dangling call further back was answered by the talk after it.

/** The result a dangling call is closed with. */
export const INTERRUPTED =
  "Interrupted: this call's outcome is unknown (it may or may not have run). Check before you repeat it.";

interface Entry {
  id?: string;
  message?: {
    content?: { id?: string; name?: string; type: string }[] | string;
    role?: string;
    toolCallId?: string;
  };
  type: string;
}

const parsed = (line: string): Entry | undefined => {
  try {
    return JSON.parse(line) as Entry;
  } catch {
    // a torn last line: pi skips it too
    return undefined;
  }
};

/** Closes session file `file`'s trailing tool calls that have no result, appending one result each; how many it closed. */
export function closeDanglingCalls(file: string, now = clock()) {
  const text = readFileSync(file, "utf8");
  const entries = text.split("\n").flatMap((l) => parsed(l) ?? []);
  const at = entries.findLastIndex(
    (e) => e.type === "message" && e.message?.role === "assistant"
  );
  const asked = entries[at]?.message?.content;
  const after = entries.slice(at + 1).filter((e) => e.type === "message");
  // Anything but tool results after the last answer: its calls were answered, the talk went on.
  if (
    !Array.isArray(asked) ||
    after.some((e) => e.message?.role !== "toolResult")
  ) {
    return 0;
  }
  const answered = new Set(after.map((e) => e.message?.toolCallId));
  const dangling = asked.filter(
    (c) => c.type === "toolCall" && c.id && !answered.has(c.id)
  );
  let parentId = entries.findLast((e) => e.id)?.id ?? null;
  const lines = dangling.map((c) => {
    const id = crypto.randomUUID().replaceAll("-", "").slice(0, 8);
    const line = {
      id,
      message: {
        content: [{ text: INTERRUPTED, type: "text" }],
        isError: true,
        role: "toolResult",
        timestamp: now.getTime(),
        toolCallId: c.id,
        toolName: c.name ?? "",
      },
      parentId,
      timestamp: now.toISOString(),
      type: "message",
    };
    parentId = id;
    return `${JSON.stringify(line)}\n`;
  });
  if (lines.length > 0) {
    appendFileSync(file, (text.endsWith("\n") ? "" : "\n") + lines.join(""));
  }
  return lines.length;
}
