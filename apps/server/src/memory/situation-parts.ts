import { readJson } from "../core/files";
import { MAY_KEEP, promptNameOf, readOwnerName } from "../models/prompt-parts";
import { Situation, SituationPart } from "../records/situation";
import { isHiddenUntilRedone, shownKeyOf } from "./deletions";
import {
  deletionsNow,
  matterSituationPath,
  projectSituationPath,
} from "./memory-files";
import { locate } from "./quote-check";
import { readMayKeep } from "./read-truth";
import { lifeRefsOf } from "./refs";
import { replyLines } from "./run";

// The situations' one set of rules (docs/glossary.md: situation): a person's, a project's and a matter's are written by
// their own steps (`situations.ts`, `project-situations.ts`, `matter-situations.ts`) as Markdown parts to him ("you"),
// checked here when written (`partsOf`) and read here (`situationPartsNow`).

/** A prompt's name as the add-ons choose it now: a situation made by another variant is hidden at once, until redone. */
export const promptNameNow = (prompt: string, mayKeep = readMayKeep()) =>
  promptNameOf(prompt, mayKeep === undefined ? [] : [MAY_KEEP]);

/** A stored situation; null when there is none, it is of an older shape, or it was shown words he deleted (`key`): hidden until redone. */
export const readStoredSituation = (path: string, key: string) => {
  const p = Situation.safeParse(readJson(path));
  return p.success && !isHiddenUntilRedone(key, p.data.built, deletionsNow())
    ? p.data
    : null;
};

/** The parts whose every cite is among `live`. */
export const partsCitingOnly = (
  parts: readonly SituationPart[],
  live: ReadonlySet<string>
) => parts.filter((p) => p.cites.every((id) => live.has(id)));

/**
 * A situation's parts a reader may show: made by `prompt`'s variant in force, and, given `live` (the refs a reader holds
 * now), resting only on what still stands, so a step or an episode gone takes its part with it.
 */
export const situationPartsNow = (
  path: string,
  key: string,
  prompt: string,
  live?: ReadonlySet<string>
) => {
  const stored = readStoredSituation(path, key);
  if (stored?.madeBy.prompt !== promptNameNow(prompt)) {
    return [];
  }
  return live ? partsCitingOnly(stored.parts, live) : stored.parts;
};

export const PROJECT_SITUATION_PROMPT = "memory-project-situation.v2";
export const MATTER_SITUATION_PROMPT = "memory-matter-situation.v1";

/** A project's situation parts a reader may show: those resting only on `held`, the steps of the matters under it now (`projectStepRefsOf`). */
export const readProjectSituationNow = (
  project: string,
  held: ReadonlySet<string>
) =>
  situationPartsNow(
    projectSituationPath(project),
    shownKeyOf.projectSituation(project),
    PROJECT_SITUATION_PROMPT,
    held
  );

/**
 * A matter's situation parts a reader may show. Not filtered by its steps: it cites records from outside the matter too,
 * a matter whose steps change is redone that night, and a deletion hides it until then (`shownKeyOf`).
 */
export const readMatterSituationNow = (matter: string) =>
  situationPartsNow(
    matterSituationPath(matter),
    shownKeyOf.matterSituation(matter),
    MATTER_SITUATION_PROMPT
  );

/** A situation as an agent or a search reads it, under `title`: its "you" is him. Nothing when it has no part. */
export const situationBlock = (
  title: string,
  parts: readonly SituationPart[]
) =>
  parts.length > 0
    ? [
        `${title} (Life's reading, written to ${readOwnerName()} as "you"):`,
        ...parts.map((p) => `${p.markdown} [${p.cites.join(", ")}]`),
        "",
      ]
    : [];

/** Every string in a value: where a quote may be found. */
const stringsOf = (x: unknown): string[] =>
  typeof x === "string"
    ? [x]
    : Array.isArray(x)
      ? x.flatMap(stringsOf)
      : x && typeof x === "object"
        ? Object.values(x).flatMap(stringsOf)
        : [];

/** Words given as someone's: a `>` quote's line, or 12 characters or more in quotation marks. */
const QUOTED = /[“"«]([^”"»\n]{12,})[”"»]/g;
const quotesOf = (markdown: string) => [
  ...markdown
    .split("\n")
    .flatMap((l) =>
      l.trimStart().startsWith(">") ? [l.trimStart().slice(1).trim()] : []
    ),
  ...[...markdown.matchAll(QUOTED)].map((m) => m[1] ?? ""),
];

/** What a stored reading never holds: a heading, a fenced block (an answer block would act on a tap), an image, a web address. */
const NOT_ALLOWED = /^\s{0,3}#|^\s*(```|~~~)|!\[|https?:\/\//m;

/**
 * The reply's parts that hold only what the call was shown: every cite and `life:` link among `shown`, every quote found
 * word for word in `input`, and nothing a reading may not hold (`NOT_ALLOWED`). A reply with no such part is a failed
 * call: it throws, so the last situation stays and the next night retries.
 */
export function partsOf(
  reply: unknown,
  shown: ReadonlySet<string>,
  input: unknown
) {
  const lines = stringsOf(input);
  const parts = replyLines(reply, SituationPart, "parts").filter(
    (p) =>
      p.cites.every((c) => shown.has(c)) &&
      [...lifeRefsOf(p.markdown)].every((r) => shown.has(r)) &&
      !NOT_ALLOWED.test(p.markdown) &&
      quotesOf(p.markdown).every((q) => locate(q, lines) !== null)
  );
  if (parts.length === 0) {
    throw new Error("no part rests only on what the call was shown");
  }
  return parts;
}
