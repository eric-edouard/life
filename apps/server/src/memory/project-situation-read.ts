import { join } from "node:path";
import { readJson } from "../core/files";
import { MAY_KEEP, promptNameOf } from "../models/prompt-parts";
import { ProjectSituation } from "../records/situation";
import { MEMORY } from "./memory-files";
import { readMayKeep } from "./read-truth";
import { linesCitingOnly } from "./situations";

// Reading a project's stored situation (written by `memory/project-situations.ts`).

/** Where each project underway stands, one file per project, apart from the people's: `situated` and the person step's clean-up treat every file of `SITUATIONS` as a person's. */
export const PROJECT_SITUATIONS = join(MEMORY, "project-situations");
export const projectSituationPath = (project: string) =>
  join(PROJECT_SITUATIONS, `${project}.json`);

export const PROMPT = "memory-project-situation.v1";

/** The prompt's name as the add-ons choose it now: a toggle hides what another variant wrote at once. */
export const promptNameNow = (mayKeep = readMayKeep()) =>
  promptNameOf(PROMPT, mayKeep === undefined ? [] : [MAY_KEEP]);

export const readStored = (project: string) => {
  const p = ProjectSituation.safeParse(readJson(projectSituationPath(project)));
  return p.success ? p.data : null;
};

/**
 * A project's situation lines a reader may show: those whose every cited step is among `held` (the steps of the matters
 * that show under the project, running or not: `projectStepRefsOf`), and only when made by the prompt variant in force.
 */
export function readProjectSituationNow(
  project: string,
  held: ReadonlySet<string>
) {
  const stored = readStored(project);
  return stored?.madeBy.prompt === promptNameNow()
    ? linesCitingOnly(stored.lines, held)
    : [];
}
