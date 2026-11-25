import {
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type {
  ToolResultEvent,
  ToolResultEventResult,
} from "@earendil-works/pi-coding-agent";
import { DAY } from "../../core/clock";

// What a tool's result becomes before the model reads it, in Life's pi extension (the v4 plan, bundle C, after Nod's
// `untrusted.ts` and `context-output.ts`). A result from outside (an MCP server's but the door's, the web's) is wrapped
// as data, its closing tag neutralised inside, so its words never pass for Life's. A long result (any tool's but the
// door's and `read`'s, which pages itself) is kept whole in a file, the model given its start and where the rest is.
// The door's answers are Life's own words (its refusals are instructions), so they stay as they are.

/** The door's tools (`mcp__desk__…`). */
export const DOOR_TOOL = "mcp__desk__";

/** A result longer than this is kept in a file; the model gets its first `PREVIEW_CHARS`. */
const KEEP_OUT_AT = 20_000;
const PREVIEW_CHARS = 4000;

/** The tag around a result read as data. */
const DATA_TAG = "life-data";
const TAG_INSIDE = new RegExp(`<(/?)${DATA_TAG}`, "gi");

/** Whether `toolName`'s results come from outside Life: an MCP server's but the door's, or the web's. */
const isFromOutside = (toolName: string) =>
  (toolName.startsWith("mcp__") && !toolName.startsWith(DOOR_TOOL)) ||
  toolName.startsWith("web_");

/** `text` as data from `toolName`: in the data tag, the tag inside it made harmless. */
export const asDataOf = (toolName: string, text: string) =>
  `<${DATA_TAG} from="${toolName}">\n${text.replace(TAG_INSIDE, `‹$1${DATA_TAG}`)}\n</${DATA_TAG}>`;

/**
 * A tool's result as the model reads it, or none when it stays as it is. `dir` keeps long results, one file per call
 * (`toolCallId`).
 */
export function resultOf(
  call: Pick<ToolResultEvent, "content" | "toolCallId" | "toolName">,
  dir: string
): ToolResultEventResult | undefined {
  const { toolName } = call;
  if (toolName.startsWith(DOOR_TOOL)) {
    return;
  }
  const text = call.content
    .map((c) => (c.type === "text" ? c.text : ""))
    .join("\n");
  const isLong = text.length > KEEP_OUT_AT && toolName !== "read";
  if (!(isLong || isFromOutside(toolName))) {
    return;
  }
  let shown = text;
  if (isLong) {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${call.toolCallId.replace(/[^\w-]/g, "_")}.txt`);
    writeFileSync(file, text, { mode: 0o600 });
    shown = `${text.slice(0, PREVIEW_CHARS)}\n…(${text.length} characters in all: the whole result is in ${file}, read it there.)`;
  }
  const images = call.content.filter((c) => c.type !== "text");
  return {
    content: [
      {
        text: isFromOutside(toolName) ? asDataOf(toolName, shown) : shown,
        type: "text" as const,
      },
      ...images,
    ],
  };
}

/** Deletes kept results older than a day: a result is for its own turn (an earlier turn's answers leave the context, `contextOf`). */
export function pruneResults(dir: string, now: number) {
  for (const f of (() => {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  })()) {
    const path = join(dir, f);
    if (now - statSync(path).mtimeMs > DAY) {
      rmSync(path, { force: true });
    }
  }
}
