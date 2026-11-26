import { join } from "node:path";
import { z } from "zod";
import { appendJsonl, readAppended, readChangeStamp } from "../core/files";
import { isOnline } from "../models/llm";
import {
  MATTER_ICONS,
  MatterIconKey,
  MatterIconPick,
} from "../records/matter-icon";
import { type MatterView, matterTextOf } from "./matter-read";
import { MATTER_BOOK_READS, readMatterBook } from "./matters";
import { MEMORY } from "./memory-files";
import { isLocked } from "./memory-lock";
import {
  begin,
  checkedEntries,
  chunks,
  inBatches,
  inputsOf,
  readsOf,
} from "./run";
import { readCallsToday } from "./run-log";
import type { People } from "./who";
import { dayNow } from "./zones";

// Life's pick of a matter's icon (docs/glossary.md: matter icon): the memory's fast tier is shown each matter's name
// and goal and the icons' lines, and gives one key or none (a wrong icon is worse than none). One line per matter text
// in memory/matter-icons.jsonl (this file is its only writer), keyed by `iconInputsOf`: a text is asked once, and again
// only when its name or goal, a line or the prompt changes. Asked by the night after the directions (a goal is part of
// the text) and, his yes of 27 Nov 2026 ("Cheap model picks"), by the watcher for open matters with none. His pick
// (`ownerIcon`) wins and is never asked.

const PROMPT = "memory-matter-icon.v1";
/** Life's picks (`readLifeIcons`): one line per matter text, append-only, the newest winning. */
export const MATTER_ICON_PICKS = join(MEMORY, "matter-icons.jsonl");
const CALL_ID = /^m(\d+)$/;
/** The icons a call is shown: every key but the fallback, which the phone draws when there is none. */
const SHOWN = MATTER_ICONS.filter(([key]) => key !== "folder").map(
  ([key, line]) => ({ key, line })
);
const SHOWN_DIGEST = inputsOf(PROMPT, SHOWN);
/** How many matters one call is shown (about 3k characters of matters beside the 6k of lines). */
const MATTERS_A_CALL = 40;
/** The watcher's calls in a local day, the night's included (`readCallsToday`): 800 matters, a runaway guard. */
export const ICON_CALLS_A_DAY = 20;

/** What a pick is kept under: the matter's text, the lines shown and the prompt. Pure. */
export const iconInputsOf = (v: Pick<MatterView, "goal" | "name">) =>
  inputsOf(SHOWN_DIGEST, matterTextOf(v));

/** Every pick made, by `iconInputsOf` (null: none fits), the newest winning. */
export const readLifeIcons = (): ReadonlyMap<string, MatterIconKey | null> =>
  readAppended<MatterIconPick, Map<string, MatterIconKey | null>>(
    MATTER_ICON_PICKS,
    MatterIconPick,
    (last) => new Map(last),
    (picks, row) => {
      picks.set(row.inputs, row.icon);
    }
  );

/** A matter's icon as the readers give it: his pick, else Life's (`readLifeIcons`); none with neither (the phone shows the area's). Pure. */
export const iconNow = (
  v: Pick<MatterView, "goal" | "name" | "ownerIcon">,
  picks: ReadonlyMap<string, MatterIconKey | null>
) => {
  if (v.ownerIcon) {
    return { by: "owner" as const, key: v.ownerIcon };
  }
  const key = picks.get(iconInputsOf(v));
  return key ? { by: "life" as const, key } : undefined;
};

/** `views` with no pick of his or Life's yet, one per text. */
const unpickedOf = (views: readonly MatterView[]) => {
  const picks = readLifeIcons();
  const seen = new Set<string>();
  return views.filter((v) => {
    const inputs = iconInputsOf(v);
    const isDue = !(v.ownerIcon || picks.has(inputs) || seen.has(inputs));
    seen.add(inputs);
    return isDue;
  });
};

const Picked = z
  .object({
    icon: MatterIconKey.exclude(["folder"]).nullable(),
    matter: z.string(),
  })
  .strict();

/**
 * Picks the icons of `views` with none yet (`unpickedOf`), `MATTERS_A_CALL` a call, at most `calls` calls: one line
 * per matter the reply names, appended as its call ends (one it leaves out, or a failed call, is asked next time).
 */
export async function pickMatterIcons(
  views: readonly MatterView[],
  calls = Number.POSITIVE_INFINITY
) {
  const due = chunks(unpickedOf(views), MATTERS_A_CALL).slice(0, calls);
  if (due.length === 0) {
    return { picked: 0 };
  }
  const step = await begin("matter-icons", "fast", { prompt: PROMPT });
  let picked = 0;
  await inBatches(due, step, async (batch, dir) => {
    await step.attempt(async () => {
      const reply = await step.ask({
        context: { icons: SHOWN },
        dir: join(dir, "call"),
        input: {
          matters: batch.map((v, i) => ({
            id: `m${i + 1}`,
            name: v.name,
            ...(v.goal ? { goal: v.goal.text } : {}),
          })),
        },
        prompt: PROMPT,
        reads: readsOf(batch.map((v) => ({ source: "memory", unit: v.id }))),
      });
      const list = (reply as { icons?: unknown } | null)?.icons;
      const { entries } = checkedEntries(
        Array.isArray(list) ? list : [],
        Picked,
        (e) => e.matter,
        (id) => {
          const n = Number(CALL_ID.exec(id)?.[1]);
          return n >= 1 && n <= batch.length;
        }
      );
      const at = step.now.toISOString();
      const madeBy = step.madeBy(PROMPT);
      appendJsonl(
        MATTER_ICON_PICKS,
        MatterIconPick,
        entries.flatMap((e) => {
          const v = batch[Number(e.matter.slice(1)) - 1];
          return v
            ? [
                {
                  at,
                  icon: e.icon,
                  inputs: iconInputsOf(v),
                  madeBy,
                  schemaVersion: 1 as const,
                },
              ]
            : [];
        })
      );
      picked += entries.length;
    });
  });
  return step.end({ picked });
}

/** The matter book and picks as last seen with nothing left to ask: a tick with the same reads nothing. */
let seenAllPicked: string | undefined;

/**
 * The watcher's pass: the open matters with no pick, one call a tick within `ICON_CALLS_A_DAY`; skipped while a run
 * holds the memory lock (the night picks after it), offline, or when nothing the book reads changed since a pass left
 * nothing to ask. Its lines are one synchronous append each, outside the lock.
 */
export async function pickIconsOnArrival(people: People) {
  const seenKey = () =>
    JSON.stringify([
      readChangeStamp([...MATTER_BOOK_READS, MATTER_ICON_PICKS]),
      dayNow(),
    ]);
  const key = seenKey();
  if (key === seenAllPicked || isLocked()) {
    return;
  }
  const open = (await readMatterBook(people, dayNow())).filter((v) => v.open);
  if (unpickedOf(open).length === 0) {
    seenAllPicked = key;
    return;
  }
  if (
    (await readCallsToday([PROMPT])) >= ICON_CALLS_A_DAY ||
    !(await isOnline())
  ) {
    return;
  }
  await pickMatterIcons(open, 1);
}
