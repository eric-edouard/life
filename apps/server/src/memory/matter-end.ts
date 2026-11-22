import { ACTIONABLE, type MatterView } from "./matter-read";

// How a closed matter ended, worked out when read from its steps (never stored): `read_day`'s Done and `read_matters`'
// closed rows.

const outcomeOf = (status: MatterView["status"], isDropped: boolean) => {
  if (status === "probably_done") {
    return "probably_done" as const;
  }
  return isDropped ? ("dropped" as const) : ("done" as const);
};

/** A closed matter's step that ended last among its to-dos, promises, waits and to-do items; none while it is open. Pure. */
export const lastEndedStepOf = (v: Pick<MatterView, "open" | "steps">) =>
  v.open
    ? undefined
    : v.steps
        .filter((s) => ACTIONABLE.includes(s.kind) && s.ending)
        .toSorted((a, b) =>
          (a.ending?.at ?? "").localeCompare(b.ending?.at ?? "")
        )
        .at(-1);

/**
 * How a closed matter ended (`read_matters`' closed rows): `at`, when its last step ended (`lastEndedStepOf`), else, for
 * one done by quiet or read over by Life with steps still open, its last step's instant; `outcome` `probably_done`
 * (`status`), `dropped` when that last ending was a Drop, else `done`. None while it is open. Pure.
 */
export function matterEndOf(
  v: Pick<MatterView, "open" | "openSteps" | "status" | "steps">
) {
  if (v.open) {
    return;
  }
  const ending = lastEndedStepOf(v)?.ending;
  const isDropped =
    ending !== undefined && "dropped" in ending && ending.dropped === true;
  return {
    at:
      ending && v.openSteps.length === 0
        ? ending.at
        : (v.steps.at(-1)?.at ?? ""),
    outcome: outcomeOf(v.status, isDropped),
  };
}
