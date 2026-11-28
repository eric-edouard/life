import { join } from "node:path";
import { z } from "zod";
import { clock } from "../core/clock";
import { filesIn, readJson } from "../core/files";
import { digest } from "../core/hash";
import { log } from "../core/log";
import { errorOf } from "../core/log-line";
import type { Cut } from "../records/observation";
import { Situation } from "../records/situation";
import type { Unit } from "../records/unit";
import { openTodoItemKeysOf } from "../todo-list/todo-items-from-ledger";
import { decisionsNow, withdrawDeletedCards } from "./decisions";
import {
  cutOf,
  type DeletionLayers,
  type Dependents,
  dependentsOf,
  type HoldsDeleted,
  isGone,
  NO_DELETIONS,
  refKeyOf,
  shownKeyOf,
} from "./deletions";
import { findMessage, findTurn } from "./find-refs";
import { gather } from "./gather";
import { reindex } from "./index-writer";
import { instructionsHolding } from "./instructions";
import { mattersNow, readMatters } from "./matters";
import {
  HISTORIES,
  PERSONAS,
  readEpisodes,
  readIndex,
  readLedger,
  readObservations,
  readUnit,
  readUnitsOf,
  recordCorrection,
  SITUATIONS,
} from "./memory-files";
import { locked } from "./memory-lock";
import { readFiles } from "./message-files";
import { locate } from "./quote-check";
import { deletionRefusalOf, lifeRefsOf, parseRef } from "./refs";
import { search } from "./search";
import { MATTER_SITUATIONS, PROJECT_SITUATIONS } from "./situation-parts";
import { publishUnits } from "./unit-writer";
import { clip, isFrozen } from "./units";
import { readPeople } from "./who";
import { transcripts } from "./words";
import { localDate } from "./zones";

// A deletion's door (docs/glossary.md, "deletion"): what he would lose, as a preview he reads first, then the one write
// of it, which also reads the days it touched again. Nothing of the words goes in the record: a cut keeps its places and
// the digest of what was there. Read by the connector's `delete_from_memory`, the main session's door and the CLI.

/** One named ref as the preview shows it: what it is, one short line of it, and the day its words sat on. */
export interface DeletionNamed {
  day: string | null;
  id: string;
  kind: string;
  line: string;
}

/** A copy of his words a deletion blanks (a thread entry, an instruction line): its id and kind, never its words. */
export interface DeletionCopy {
  id: string;
  kind: "instruction" | "thread entry";
}

/** The thread's finder, which memory cannot read (the desk's store): the entries `holds` names. Given by the host's door. */
export type ThreadEntriesHolding = (holds: HoldsDeleted) => DeletionCopy[];

/** `HoldsDeleted` for `words` (the deleted words) and `refs` (the deleted refs, a turn however it is spelled). Pure. */
export function copyMatchOf(
  words: readonly string[],
  refs: readonly string[]
): HoldsDeleted {
  const gone = { ...NO_DELETIONS, refs: new Set(refs.map(refKeyOf)) };
  return (texts, cited) =>
    cited.some((r) => isGone(r, gone)) ||
    texts.some(
      (t) => t !== null && t !== "" && words.some((w) => locate(w, [t]))
    );
}

/** What a deletion would do: the refs it names, the words it cuts, what it reaches, the days to read again and the digest of that set. */
export interface DeletionPlan {
  /** The digest of the exact set: the second call's `confirm`, so nothing is written that he did not see. */
  confirm: string;
  /** The copies of his words outside memory that hold them: named by the write's record; the thread entries listed, never digested. */
  copies: DeletionCopy[];
  cuts: Cut[];
  days: string[];
  named: DeletionNamed[];
  /** The hashes of the units holding the deleted words, as they stand before it: what was read under them is gone, not replaced. */
  oldHashes: string[];
  reaches: Dependents;
  withSources: boolean;
}

/** What a caller asks for: refs, words to cut, or anything about `about`; with no `confirm`, a preview and no write. */
export const DeletionRequest = z
  .object({
    about: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe(
        "Anything about this, found by `search` and previewed only: never written from it alone"
      ),
    confirm: z
      .string()
      .regex(/^[0-9a-f]{16}$/)
      .optional()
      .describe(
        "The `confirm` of the preview just read: that exact set is written; another one is previewed again"
      ),
    cuts: z
      .array(
        z
          .object({
            quote: z.string().min(1).max(600),
            ref: z.string().min(1).max(400),
          })
          .strict()
      )
      .max(50)
      .default([])
      .describe(
        "Words to blank inside one line (a `msg:…` message or a `…@…` turn), by a quote of them"
      ),
    refs: z
      .array(z.string().min(1).max(400))
      .max(200)
      .default([])
      .describe(
        "What goes whole: a unit_…, an obs_…, an ep_…, a msg:<source>|<id>, a turn, a file:…, a matter, a card"
      ),
    said: z.string().trim().min(1).max(300),
    withSources: z.boolean().default(false),
  })
  .strict();
export type DeletionRequest = z.infer<typeof DeletionRequest>;

/** Why a deletion asks for nothing: one names refs, cuts or `about`. */
export const deletionProblemOf = (ask: DeletionRequest) =>
  ask.about === undefined && ask.refs.length + ask.cuts.length === 0
    ? "a deletion names refs, cuts or about"
    : null;

/** The digest of a plan's exact set: its refs, its cuts' places and digests, and `withSources`. */
export const deletionDigestOf = (p: {
  copies?: readonly { id: string }[];
  cuts: readonly Cut[];
  named: readonly { id: string }[];
  withSources: boolean;
}) =>
  digest(
    "sha256",
    JSON.stringify({
      copies: (p.copies ?? []).map((c) => c.id).sort(),
      cuts: p.cuts.map((c) => [c.ref, c.from, c.to, c.digest]).sort(),
      refs: p.named.map((n) => n.id).sort(),
      withSources: p.withSources,
    }),
    16
  );

/**
 * `quote`'s words in a line's `text` as a cut: where they sit and the digest of what was there, or null when they are not
 * in it. The quote check is extraction's (`locate`: no accents, case, quote style or spacing counted).
 */
export function cutInLine(text: string, quote: string, ref: string) {
  const found = locate(quote, [text]);
  const from = found ? text.indexOf(found.verbatim) : -1;
  return found && from >= 0
    ? cutOf(ref, text, from, from + found.verbatim.length)
    : null;
}

/** A turn as a deletion names it, its day from the ref: refused unless the voice server's store still has it. */
async function namedTurn(id: string, t: { jobId: string; turnIndex: number }) {
  const found = await findTurn(id, t);
  if (!found.found) {
    throw new Error(`Not done: ${found.why}.`);
  }
  return {
    day: localDate(id.slice(id.indexOf("@") + 1)),
    id,
    kind: "turn",
    line: clip(id, 120),
  };
}

/** A ref's kind and one short line of it, with the day its words sat on when it has one. Throws when it is not there. */
async function namedOf(id: string): Promise<DeletionNamed> {
  const refusal = deletionRefusalOf(id);
  if (refusal) {
    throw new Error(`Not done: ${refusal}.`);
  }
  const ref = parseRef(id);
  if ("error" in ref) {
    throw new Error(`Not done: ${ref.error}.`);
  }
  const named = (kind: string, line: string, day: string | null = null) => ({
    day,
    id,
    kind,
    line: clip(line, 120),
  });
  switch (ref.kind) {
    case "unit": {
      const unit = await readUnit(id);
      if (!unit) {
        throw new Error(`Not done: no unit ${id}.`);
      }
      return named(
        "unit",
        `${unit.source}: ${unit.title}`,
        localDate(unit.start)
      );
    }
    case "observation": {
      const o = readIndex((db) =>
        db
          .query<{ date: string; text: string }, [string]>(
            "select date, text from observations where id = ?"
          )
          .get(id)
      );
      if (!o) {
        throw new Error(`Not done: no observation ${id}.`);
      }
      return named("observation", o.text, o.date);
    }
    case "episode": {
      const line = (await readEpisodes()).find((l) => l.id === id);
      if (!line) {
        throw new Error(`Not done: no episode ${id}.`);
      }
      return named("episode", line.day, line.day.slice(0, 10));
    }
    case "message": {
      const found = findMessage(ref);
      if (!found.found) {
        throw new Error(`Not done: ${found.why}.`);
      }
      return named("message", found.event.text, localDate(found.event.at));
    }
    case "turn":
      return await namedTurn(id, ref);
    case "file": {
      const file = readFiles().get(ref.file);
      if (!file) {
        throw new Error(`Not done: no file ${ref.file}.`);
      }
      return named("file", file.description ?? file.text ?? ref.file);
    }
    case "matter": {
      const matter = mattersNow(readMatters()).matters.find((m) => m.id === id);
      if (!matter) {
        throw new Error(`Not done: no matter ${id}.`);
      }
      return named("matter", matter.name);
    }
    case "card": {
      const card = decisionsNow().find((d) => d.id === id);
      if (!card) {
        throw new Error(`Not done: no card ${id}.`);
      }
      return named("card", card.title);
    }
    default:
      throw new Error(
        `Not done: a deletion names no ${ref.kind}: its units, its messages or its turns instead.`
      );
  }
}

/** A line's own words, for the cuts on it: a message's text, a turn's words, as the reads give them. */
async function textOf(ref: string): Promise<string> {
  const parsed = parseRef(ref);
  if (!("error" in parsed) && parsed.kind === "message") {
    const found = findMessage(parsed);
    if (found.found) {
      return found.event.text;
    }
    throw new Error(`Not done: ${found.why}.`);
  }
  if (!("error" in parsed) && parsed.kind === "turn") {
    const lines = await transcripts([{ jobId: parsed.jobId }]);
    const line = lines.get(parsed.jobId)?.[parsed.turnIndex];
    if (line) {
      return line.text;
    }
    throw new Error(`Not done: the voice server has no turn ${parsed.id}.`);
  }
  throw new Error(
    `Not done: a cut names a message (msg:<source>|<id>) or a turn, never ${ref}.`
  );
}

/** A search line's ref: the id it opens with (`index-rows.ts`). */
const LINE_ID = /^- (\S+) /;

/** The kinds a deletion names, one by one (`namedOf`); a search's person, conversation or voice lines are none of them. */
const DELETABLE = new Set([
  "card",
  "episode",
  "file",
  "matter",
  "message",
  "observation",
  "turn",
  "unit",
]);

/** The refs a search for `about` names, from its own lines' ids (each line opens with one): the preview's only answer to it. */
export async function refsAbout(about: string) {
  const found = await search(about);
  return found.split("\n").flatMap((line) => {
    const id = LINE_ID.exec(line)?.[1];
    const ref = id === undefined ? { error: "" } : parseRef(id);
    return id !== undefined && !("error" in ref) && DELETABLE.has(ref.kind)
      ? [id]
      : [];
  });
}

/** The refs of the derived reads that exist now, one folder's files: `person:<id>` each. */
const readRefsInFolder = async (dir: string) =>
  new Set(
    (await filesIn(dir, ".json")).map(
      (f) => `person:${f.slice(0, -".json".length)}`
    )
  );

/**
 * The derived reads the words of `units` could have been shown: a persona, a history's month and a situation of each
 * person the unit holds (`Unit.people`), which is who they read it for. The derived reads store no list of the units they
 * read, so this is who a unit could have reached, never what one was handed: hiding one too many costs a redo, hiding one
 * too few shows words he deleted.
 */
async function readShownDerivedOf(units: readonly Unit[]) {
  const [personas, histories, situations] = await Promise.all([
    readRefsInFolder(PERSONAS),
    readRefsInFolder(HISTORIES),
    readRefsInFolder(SITUATIONS),
  ]);
  const shown = new Map<string, string[]>();
  const add = (key: string, unit: string) =>
    shown.set(key, [...new Set([...(shown.get(key) ?? []), unit])]);
  for (const u of units) {
    for (const ref of u.people) {
      if (personas.has(ref)) {
        add(shownKeyOf.persona(ref), u.id);
      }
      if (histories.has(ref)) {
        add(shownKeyOf.history(ref, u.date.slice(0, 7)), u.id);
      }
      if (situations.has(ref)) {
        add(shownKeyOf.situation(ref), u.id);
      }
    }
  }
  return [...shown]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, held]) => ({ id, units: held }));
}

/**
 * The project and matter situations, each with every ref its call was shown, cited or not (`Situation.shown`: ids only,
 * never its words): one is reached when a deletion reaches any of them, their fact or their unit; a matter's also when its
 * matter is named.
 */
export const readShownSituations = async () => {
  const of = async (
    dir: string,
    key: (id: string) => string,
    also: (id: string) => string[]
  ) =>
    (await filesIn(dir, ".json")).flatMap((f) => {
      const id = f.slice(0, -".json".length);
      const stored = Situation.safeParse(readJson(join(dir, f)));
      return stored.success
        ? [
            {
              id: key(id),
              units: [...also(id), ...stored.data.shown],
            },
          ]
        : [];
    });
  return [
    ...(await of(PROJECT_SITUATIONS, shownKeyOf.projectSituation, () => [])),
    ...(await of(MATTER_SITUATIONS, shownKeyOf.matterSituation, (id) => [id])),
  ];
};

/** What a deletion would reach: its refs read, its cuts made, the stored layers holding them, the days to read again. */
export async function planDeletion(
  ask: DeletionRequest,
  threadEntriesHolding: ThreadEntriesHolding = () => []
): Promise<DeletionPlan> {
  const problem = deletionProblemOf(ask);
  if (problem) {
    throw new Error(`Not done: ${problem}.`);
  }
  const wanted = [
    ...new Set([...ask.refs, ...ask.cuts.map((c) => c.ref)]),
    ...(ask.about ? await refsAbout(ask.about) : []),
  ];
  const named = await Promise.all(wanted.map(namedOf));
  const cuts = await Promise.all(
    ask.cuts.map(async ({ quote, ref }) => {
      const cut = cutInLine(await textOf(ref), quote, ref);
      if (!cut) {
        throw new Error(`Not done: those words are not in ${ref}.`);
      }
      return cut;
    })
  );
  const days = [
    ...new Set(named.flatMap((n) => (n.day ? [n.day] : []))),
  ].sort();
  const asked = new Set([...ask.refs, ...cuts.map((c) => c.ref)]);
  // The layers the cascade is worked out over: the days' units, every fact (the ones he names or whose unit he does, it
  // picks), the matters' steps, the cards' subjects and his open to-do items. The stored reads and the derived ones are
  // filtered where they are read, so they are no layer of it.
  const units = readUnitsOf(days);
  const layers: DeletionLayers = {
    cards: [...decisionsNow()].map((d) => ({
      id: d.id,
      refs: lifeRefsOf(d.context ?? ""),
      ...(d.subject === undefined ? {} : { subject: d.subject }),
    })),
    matters: mattersNow(readMatters()).matters.map((m) => ({
      id: m.id,
      steps: m.steps.map((s) => s.ref),
    })),
    observations: (await readObservations()).map((o) => ({
      id: o.id,
      source: o.source?.ref ?? "",
      unit: o.unit,
    })),
    shown: [],
    todoItems: openTodoItemKeysOf(await readLedger()),
    units: units.map((u) => ({ id: u.id, refs: u.refs })),
  };
  // The derived reads are settled over the units it reaches, in a second pass: those are the only ones whose words go.
  const first = dependentsOf([...asked], layers);
  const shown = await readShownDerivedOf(
    units.filter((u) => first.units.includes(u.id))
  );
  const reaches = dependentsOf([...asked], {
    ...layers,
    shown: [...shown, ...(await readShownSituations())],
  });
  // The copies of his words outside memory: the ones holding the words he deletes (a cut's, a message's or a turn's
  // whole), or citing what goes or what it reaches.
  const whole = await Promise.all(
    named
      .filter((n) => n.kind === "message" || n.kind === "turn")
      .map((n) => textOf(n.id).catch(() => ""))
  );
  const holds = copyMatchOf(
    [...ask.cuts.map((c) => c.quote), ...whole.filter((w) => w !== "")],
    [
      ...named.map((n) => n.id),
      ...reaches.cards,
      ...reaches.facts,
      ...reaches.matters,
      ...reaches.units,
    ]
  );
  const copies: DeletionCopy[] = [
    ...threadEntriesHolding(holds),
    ...instructionsHolding(holds).map((id) => ({
      id,
      kind: "instruction" as const,
    })),
  ];
  return {
    // The thread entries stay out of the digest: an answer to the preview quoting the words is a new match at confirm.
    confirm: deletionDigestOf({
      copies: copies.filter((c) => c.kind === "instruction"),
      cuts,
      named,
      withSources: ask.withSources,
    }),
    copies,
    cuts,
    days,
    named,
    // A chapter unit is never read again (.claude/rules/memory.md): its hash in `oldHashes` would hide every fact of it for good.
    oldHashes: units
      .filter((u) => !isFrozen(u) && reaches.units.includes(u.id))
      .map((u) => u.hash),
    reaches,
    withSources: ask.withSources,
  };
}

/** A plan as a caller reads it: what it names and reaches, with the digest to repeat, and nothing written. */
const previewOf = (plan: DeletionPlan) => ({
  askAgain:
    "nothing is deleted yet: repeat the same call with `confirm` to write it",
  confirm: plan.confirm,
  copies: plan.copies,
  cuts: plan.cuts.map((c) => ({ from: c.from, ref: c.ref, to: c.to })),
  days: plan.days,
  reaches: plan.reaches,
  refs: plan.named,
  withSources: plan.withSources,
});

/** The days a deletion touched read again and the index rebuilt, under memory's lock. `null`: another run held it. */
async function readDaysAgain(days: readonly string[]) {
  return await locked(async () => {
    let published: string[] = [];
    try {
      if (days.length > 0) {
        await publishUnits(
          await gather(
            { from: days[0] as string, to: days.at(-1) as string },
            await readPeople()
          )
        );
        published = [...days];
      }
    } catch (e) {
      // The deletion stands: a day that could not be read again is the next night's.
      log("run.error", { ...errorOf(e), step: "delete.publish" });
    }
    await reindex().catch((e) => {
      log("run.error", { ...errorOf(e), step: "delete.index" });
    });
    return published;
  });
}

/**
 * His refs deleted: the preview, or, with its `confirm`, the one write: the record (refs, the instruction lines holding
 * the words, cuts' places and digests, the units' hashes before it, `withSources`), the open cards it reaches withdrawn,
 * then its days read again and the index rebuilt. Anything but the preview's exact set is previewed again, never
 * written. The thread entries it reaches (found by the host's `threadEntriesHolding`) go in the record too.
 */
export async function deleteFromMemory(
  ask: unknown,
  threadEntriesHolding?: ThreadEntriesHolding
) {
  const request = DeletionRequest.parse(ask);
  const plan = await planDeletion(request, threadEntriesHolding);
  if (request.confirm !== plan.confirm) {
    return previewOf(plan);
  }
  if (request.refs.length + request.cuts.length === 0) {
    throw new Error(
      "Not done: `about` only previews what it finds: name the refs it shows, or the words to cut."
    );
  }
  // What goes whole is what he named: a cut's ref keeps its line, with only its own words blanked.
  const deleted = await recordCorrection({
    at: clock().toISOString(),
    cuts: plan.cuts,
    kind: "deleted",
    oldHashes: plan.oldHashes,
    // An instruction line or a thread entry holding the words goes whole, applied at read (`instructionsFor`,
    // `readThread`); the desk blanks the entry on its tick, and the instructions' file is never rewritten.
    refs: [...request.refs, ...plan.copies.map((c) => c.id)],
    // His words could quote what he deleted: the record keeps their digest, never them.
    said: digest("sha256", request.said, 16),
    schemaVersion: 1,
    shown: plan.reaches.shown,
    withSources: plan.withSources,
  });
  const withdrawn = withdrawDeletedCards(plan.reaches.cards);
  const published = await readDaysAgain(plan.days);
  log("memory.deleted", {
    cards: withdrawn.length,
    days: plan.days.length,
    refs: request.refs.length,
  });
  return {
    at: deleted.at,
    days: plan.days,
    published: published ?? [],
    refs: request.refs,
    reindexed: published !== null,
    // His list's own: the host layer removes them (`deleteFromMemoryAndTodoItems`).
    todoItems: plan.reaches.todoItems,
    withdrawn,
  };
}
