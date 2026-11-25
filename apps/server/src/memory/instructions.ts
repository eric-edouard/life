import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { clock } from "../core/clock";
import { appendJsonl, readAppended } from "../core/files";
import { LIFE_CODE_DIR } from "../core/paths";
import { readOwnerName } from "../models/prompt-parts";
import { isoDateTime } from "../records/fields";
import { type HoldsDeleted, isGone } from "./deletions";
import { deletionsNow, MEMORY } from "./memory-files";

// What he wants of Life, in his words (an instruction: "never draft to my landlord", "keep it short"), each held to a
// scope and, when code enforces it, one effect of a closed list. Append-only, one synchronous line each, outside the
// lock like a correction (his yes of 25 Nov 2026, question 5). `recordInstruction` is the one writer, `instructionsFor`
// the one reader; a line is never rewritten: a correction is a new line that `replaces` an older one.

export const INSTRUCTIONS = join(MEMORY, "instructions.jsonl");

/** The effects code enforces (an instruction with none is text a model follows): each one's enforcement, by bundle, in the v4 plan. */
export const EFFECTS = [
  "quiet",
  "interrupt",
  "batch",
  "later",
  "drafts",
  "no-drafts",
  "hands-off",
  "intention",
  "style",
  "sensitive",
  "budget",
] as const;
type Effect = (typeof EFFECTS)[number];

/** Where an instruction holds: everything, or one person, project, matter or channel (a source, or a chat by its key). */
const SCOPE = /^(all|(person|project|matter|channel):\S+)$/;

/** What an asker gives `recordInstruction`: his instruction, its scope and words, and what it replaces. */
export const InstructionRequest = z
  .object({
    effect: z.enum(EFFECTS).optional(),
    /** An instruction it corrects: that one stops; nothing else it does not address changes. */
    replaces: z
      .string()
      .regex(/^ins_[0-9a-f]{12}$/)
      .optional(),
    /** His own words that gave it, verbatim (the door finds them in his ask). */
    said: z.string().min(1).max(2000),
    scope: z.string().regex(SCOPE),
    /** The instruction, as Life holds it, one or two lines. */
    text: z.string().min(1).max(500),
    until: isoDateTime.optional(),
  })
  .strict();
const Instruction = InstructionRequest.extend({
  at: isoDateTime,
  id: z.string().regex(/^ins_[0-9a-f]{12}$/),
  schemaVersion: z.literal(1),
}).strict();
type Instruction = z.infer<typeof Instruction>;

/** Appends his instruction `r`, stamped now; its line. */
export function recordInstruction(r: z.input<typeof InstructionRequest>) {
  const line: Instruction = {
    ...InstructionRequest.parse(r),
    at: clock().toISOString(),
    id: `ins_${randomBytes(6).toString("hex")}`,
    schemaVersion: 1,
  };
  appendJsonl(INSTRUCTIONS, Instruction, [line]);
  return line;
}

const readAll = () =>
  readAppended(
    INSTRUCTIONS,
    Instruction,
    (last?: Instruction[]) => [...(last ?? [])],
    (all, i) => {
      all.push(i);
    }
  );

/** What a reader holds an instruction against: the matter, people, projects and channels at hand; `all` always holds. */
export interface InstructionSubject {
  channels?: readonly string[];
  matter?: string;
  people?: readonly string[];
  projects?: readonly string[];
}

const PERSON_PREFIX = /^person:/;
const scopesOf = (s: InstructionSubject) =>
  new Set([
    "all",
    ...(s.matter ? [`matter:${s.matter}`] : []),
    ...(s.people ?? []).map((p) => `person:${p.replace(PERSON_PREFIX, "")}`),
    ...(s.projects ?? []).map((p) => `project:${p}`),
    ...(s.channels ?? []).map((c) => `channel:${c}`),
  ]);

/** Whether `i` is in force now among `all`: no later line replaces it and its `until` has not passed. */
const isLiveOf = (i: Instruction, replaced: ReadonlySet<string>, now: Date) =>
  !(replaced.has(i.id) || (i.until && Date.parse(i.until) <= now.getTime()));

/** Every instruction in force now, oldest first: one he deleted (a `deleted` correction naming its id) is none. */
function liveOf(now: Date) {
  const all = readAll();
  const replaced = new Set(all.flatMap((i) => i.replaces ?? []));
  const d = deletionsNow();
  return all.filter((i) => isLiveOf(i, replaced, now) && !isGone(i.id, d));
}

/** The ids of the instructions in force whose words (`said`, `text`) hold what a deletion removes: the door's preview. */
export const instructionsHolding = (holds: HoldsDeleted, now = clock()) =>
  liveOf(now).flatMap((i) => (holds([i.said, i.text], []) ? [i.id] : []));

/** The instructions in force now on `subject`, oldest first: of a scope it names (`all` always), not replaced, not past `until`. */
export function instructionsFor(subject: InstructionSubject, now = clock()) {
  const scopes = scopesOf(subject);
  return liveOf(now).filter((i) => scopes.has(i.scope));
}

/** How narrow a scope is, by its kind: a matter's, then a person's or a channel's, then a project's, then everything. */
const NARROWNESS: Record<string, number> = {
  all: 3,
  channel: 1,
  matter: 0,
  person: 1,
  project: 2,
};
const narrowness = (scope: string) =>
  NARROWNESS[scope.split(":")[0] ?? ""] ?? 3;

/**
 * Whether the grant (`drafts`) or its refusal (`no-drafts`) holds among `list`: the narrowest scope that has either
 * decides, and within it a refusal beats a grant; undefined when neither is given. Pure.
 */
export function effectOf(
  list: readonly Pick<Instruction, "effect" | "scope">[],
  grant: Effect,
  refusal: Effect
) {
  const given = list.filter((i) => i.effect === grant || i.effect === refusal);
  if (given.length === 0) {
    return;
  }
  const n = Math.min(...given.map((i) => narrowness(i.scope)));
  return !given.some((i) => i.effect === refusal && narrowness(i.scope) === n);
}

/** Life's voice (`prompts/life-voice.md`), his name in it: how Life talks to him, an ask in the same voice as an answer. */
export const lifeVoice = () =>
  readFileSync(join(LIFE_CODE_DIR, "prompts", "life-voice.md"), "utf8")
    .trim()
    .replaceAll("{{owner}}", readOwnerName());

/**
 * What holds on every request a session makes, read fresh each time so it never fades in a long session or at a
 * compaction: Life's voice, then each `style` and `sensitive` instruction in force, whatever its scope.
 */
export const inForceOf = (now = clock()) =>
  [
    lifeVoice(),
    ...liveOf(now).flatMap((i) =>
      i.effect === "style" || i.effect === "sensitive"
        ? [
            `${i.effect === "sensitive" ? "Never bring this up yourself" : "How to talk to {{owner}}"}${i.scope === "all" ? "" : ` (${i.scope})`}: ${i.text}`.replaceAll(
              "{{owner}}",
              readOwnerName()
            ),
          ]
        : []
    ),
  ].join("\n");
