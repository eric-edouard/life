import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type AddOn, hasAddOn } from "../core/add-ons";
import { LIFE_CODE_DIR, OWNER_DATA_DIR } from "../core/paths";
import { settings } from "../core/settings";
import { firstNameOf, ownerIn, PeopleFile } from "../records/truth";

// Prompt parts (docs/architecture.md, "Prompt parts"): a paragraph of a prompt about a person, a relationship or his
// own life sits between `<!-- part:<add-on> -->` and `<!-- /part -->` (inline, no nesting). The marker lines of a part
// that is on are removed and nothing else; a part that is off is cut out with its text. A prompt's name, not its text,
// keys its cached outputs.

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

/** The part that is on while the owner has said what Life may keep (`mayKeep`, docs/SCHEMA.md): a call part. */
export const MAY_KEEP = "mayKeep";
/** The part on while a history month's call shows a conversation he had in person with the person (`personal/histories.ts`). */
export const IN_PERSON = "inPerson";
/** The call parts: parts no add-on switches, on only when the call says so (`on`). */
const CALL_PARTS = [IN_PERSON, MAY_KEEP];

const isOn = (part: string, on: readonly string[]) =>
  CALL_PARTS.includes(part) ? on.includes(part) : hasAddOn(part as AddOn);

/**
 * What the owner is called in prompts and in what they write: the first word of his name in truth/people.yaml, read
 * at each call so an edit of truth/ shows at the next.
 * ponytail: the first word; a "called" field in truth/ when someone goes by another word.
 */
export const readOwnerName = (data = OWNER_DATA_DIR) =>
  firstNameOf(
    ownerIn(
      PeopleFile.parse(
        Bun.YAML.parse(readFileSync(join(data, "truth", "people.yaml"), "utf8"))
      ).people
    ).name
  );

/** Said first in every prompt: who `{{owner}}` is, and never a pronoun for him in what is written. */
const OWNER_RULE = `{{owner}} is the person whose memory this is: \`me\` in lines, \`person:me\` in refs. In everything you write, name {{owner}}; never write he, him, his, she, her, they or "the owner" for {{owner}}, not even later in a sentence that already named {{owner}}: "{{owner}} told Ana that {{owner}} would call {{owner}}'s father".\n\n`;

/**
 * What a call is shown of `prompt` (its name): the owner rule then its file, parts of the add-ons that are off cut
 * out, each call part cut out unless the call has it `on` (`mayKeep`: its context holds his text), `{{owner}}` his
 * name and `{{language}}` the language his memory is written in. A prompt's name, not this text, keys its outputs: its
 * wording changes nothing stored.
 */
export const promptText = (prompt: string, on: readonly string[] = []) =>
  renderedOf(`${OWNER_RULE}${sourceOf(prompt)}`, (p) => isOn(p, on))
    .replaceAll("{{owner}}", readOwnerName())
    .replaceAll("{{language}}", settings().memoryLanguage);

/**
 * The name a call's output is stamped with: `prompt` while every add-on part it holds is on, else
 * `<prompt>-without-<its off parts, sorted, joined by "-">`; then `-with-<the call parts it holds that are on, sorted,
 * joined by "-">`. With no call part on, the name is what it was before the call parts existed.
 */
export function promptNameOf(prompt: string, on: readonly string[] = []) {
  const parts = partsIn(sourceOf(prompt));
  const off = parts.filter((p) => !(CALL_PARTS.includes(p) || isOn(p, [])));
  const calls = parts.filter((p) => CALL_PARTS.includes(p) && on.includes(p));
  const without =
    off.length === 0 ? prompt : `${prompt}-without-${off.join("-")}`;
  return calls.length === 0 ? without : `${without}-with-${calls.join("-")}`;
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
