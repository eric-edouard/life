import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type AddOn, hasAddOn } from "../core/add-ons";
import { LIFE_CODE_DIR } from "../core/paths";

// Prompt parts (docs/architecture.md, "Prompt parts"): a paragraph of a prompt about a person, a relationship or his
// own life sits between `<!-- part:<add-on> -->` and `<!-- /part -->` (inline, no nesting). The marker lines of a part
// that is on are removed and nothing else: with every part on a prompt renders as its file read before parts existed,
// so its cached outputs stay. A part that is off is cut out with its text.

const PART = /<!-- part:(\w+) -->([\s\S]*?)<!-- \/part -->/g;

const sources = new Map<string, string>();
/** A prompt's file as written, by its name (`prompts/<name>.md`); "" when it has none. */
const sourceOf = (prompt: string) => {
  const file = join(LIFE_CODE_DIR, "prompts", `${prompt}.md`);
  if (!sources.has(prompt)) {
    sources.set(prompt, existsSync(file) ? readFileSync(file, "utf8") : "");
  }
  return sources.get(prompt) as string;
};

/** The parts a text holds, sorted. */
export const partsIn = (text: string) =>
  [...new Set([...text.matchAll(PART)].map((m) => m[1] as string))].sort();

/** `text` with its off parts cut out and the markers of the rest removed. */
export const renderedOf = (text: string, keeps: (part: string) => boolean) =>
  text.replace(PART, (_, part: string, body: string) =>
    keeps(part) ? body : ""
  );

const isOn = (part: string) => hasAddOn(part as AddOn);

/** What a call is shown of `prompt` (its name): its file, parts of the add-ons that are off cut out. */
export const promptText = (prompt: string) =>
  renderedOf(sourceOf(prompt), isOn);

/**
 * The name a call's output is stamped with: `prompt` while every part it holds is on, else
 * `<prompt>-without-<its off parts, sorted, joined by "-">`.
 */
export function promptNameOf(prompt: string) {
  const off = partsIn(sourceOf(prompt)).filter((p) => !isOn(p));
  return off.length === 0 ? prompt : `${prompt}-without-${off.join("-")}`;
}

/**
 * Whether `stamped`, a prompt's name on a stored output, is `base` or a variant of it: a prompt part switched by an
 * add-on is not a new version, so what was made under any variant counts as made by the base.
 */
export const isPromptVersion = (stamped: string, base: string) =>
  stamped === base || stamped.startsWith(`${base}-without-`);
