import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type AddOn, hasAddOn } from "../core/add-ons";
import { LIFE_CODE_DIR } from "../core/paths";

// Prompt parts (docs/architecture.md, "Prompt parts"): a paragraph of a prompt about a person, a relationship or his
// own life sits between `<!-- part:<add-on> -->` and `<!-- /part -->` (inline, no nesting). The marker lines of a part
// that is on are removed and nothing else: with every part on a prompt renders as its file read before parts existed,
// so its cached outputs stay. A part that is off is cut out with its text.

const PART = /<!-- part:(\w+) -->([\s\S]*?)<!-- \/part -->/g;

const sources = new Map<string, string>();
/** A prompt's file as written, by its name (`prompts/<name>.md`); throws when there is none. */
const sourceOf = (prompt: string) => {
  let text = sources.get(prompt);
  if (text === undefined) {
    text = readFileSync(join(LIFE_CODE_DIR, "prompts", `${prompt}.md`), "utf8");
    sources.set(prompt, text);
  }
  return text;
};

/** The parts a text holds, sorted. */
export const partsIn = (text: string) =>
  [...new Set([...text.matchAll(PART)].map((m) => m[1] as string))].sort();

/** `text` with its off parts cut out and the markers of the rest removed. */
export const renderedOf = (text: string, keeps: (part: string) => boolean) =>
  text.replace(PART, (_, part: string, body: string) =>
    keeps(part) ? body : ""
  );

/** The part that is on while the owner has said what Life may keep (`mayKeep`, docs/SCHEMA.md): not an add-on. */
export const MAY_KEEP = "mayKeep";

const isOn = (part: string, mayKeep: boolean) =>
  part === MAY_KEEP ? mayKeep : hasAddOn(part as AddOn);

/**
 * What a call is shown of `prompt` (its name): its file, parts of the add-ons that are off cut out, and the `mayKeep`
 * part cut out unless `mayKeep` (the call's context holds his text).
 */
export const promptText = (prompt: string, mayKeep = false) =>
  renderedOf(sourceOf(prompt), (p) => isOn(p, mayKeep));

/**
 * The name a call's output is stamped with: `prompt` while every add-on part it holds is on, else
 * `<prompt>-without-<its off parts, sorted, joined by "-">`; then `-with-mayKeep` when `mayKeep` and the prompt holds
 * that part. With no text of his the name is what it was before the part existed.
 */
export function promptNameOf(prompt: string, mayKeep = false) {
  const parts = partsIn(sourceOf(prompt));
  const off = parts.filter((p) => p !== MAY_KEEP && !isOn(p, false));
  const without =
    off.length === 0 ? prompt : `${prompt}-without-${off.join("-")}`;
  return mayKeep && parts.includes(MAY_KEEP)
    ? `${without}-with-${MAY_KEEP}`
    : without;
}

/**
 * Whether `stamped`, a prompt's name on a stored output, is `base` or a variant of it: a prompt part switched by an
 * add-on is not a new version, so what was made under any variant counts as made by the base.
 */
export const isPromptVersion = (stamped: string, base: string) =>
  stamped === base ||
  stamped.startsWith(`${base}-without-`) ||
  stamped.startsWith(`${base}-with-`);

/** Whether `prompt` holds the `mayKeep` sentence: the only prompts a call gives his text to. */
export const hasMayKeep = (prompt: string) =>
  partsIn(sourceOf(prompt)).includes(MAY_KEEP);
