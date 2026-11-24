import { clock, daysBefore } from "../core/clock";
import { log } from "../core/log";
import type { Engine } from "../core/names";
import { ownerIn } from "../records/truth";
import type { Unit } from "../records/unit";
import { repoMap } from "../sources/git";
import { readConversations, type Store, withStore } from "../sources/lifelog";
import {
  deletionsNow,
  keptConversations,
  readInferredRepos,
  readUnits,
} from "./memory-files";
import {
  asChatOrNot,
  describeFiles,
  keptFileLines,
  showFiles,
} from "./message-files";
import type { Truth } from "./read-truth";
import {
  enabledSources,
  kindOf,
  quietly,
  readySources,
  SOURCES,
  safely,
} from "./sources";
import {
  applyRules,
  type Built,
  frozenBuilt,
  frozenUnits,
  lifelogNames,
  lifelogUnits,
  type Resolve,
  readEventsOf,
  sourceUnitsOf,
} from "./units";
import { dayStart, lastDays, localDate, type Window } from "./zones";

/**
 * The default look-back of every step: yesterday, plus what a sleeping Mac or a late transcript left behind, and the
 * conversations lifelog regroups a few days later (their new hash needs a new verdict). Files are described
 * (`describeFiles`) only on messages of these days: an older one stays a tag. Today's are described on arrival too.
 */
export const DAYS = 7;

/**
 * The evidence of a window of local days: every source (lifelog,
 * chats, mail, notes, his commits), cut into units with the code rules applied, senders kept unresolved (`resolve` names them in the text only), in time order across channels; also
 * what the later stages need around them. The one reader of the sources for the memory steps: a processing run gathers once
 * and hands it to each step, which reads the days of its units. The recent messages' new files are read first
 * (`describeFiles`; the watcher's reads leave them, described on arrival), so a unit's hash moves once when its file
 * is described; an older window (a backfill) keeps its files as tags. A repo's units are never extracted nor read for people (extract skips them; the episodes step caps
 * their importance at 1).
 */
export async function gather(
  window: Window,
  { resolve, truth }: { resolve: Resolve; truth: Truth },
  options: {
    engine?: Engine;
    /** `false`: no files described here (an older window keeps them as tags; the watcher describes today's after its publish). */
    files?: false;
    /** How each source read is logged: `safely` every read (a processing run's), `quietly` only a failure (the watcher's). */
    log?: typeof safely;
    /** `false`: lifelog is not read (the watcher writes the voice units; a historical month has none). */
    voice?: false;
  } = {}
) {
  const since = dayStart(window.from);
  const before = dayStart(daysBefore(window.to, -1));
  const { failed, read, repos } = await readSourceEvents(
    since,
    before,
    truth,
    options.log
  );
  // Lifelog's units come from the watcher's store, cut first as the registry lists it (a chapter unit as stored); every
  // other source's from its events, in the registry's order. Only the sources he turned on that can be read now; the others' units are kept.
  const sources = readySources().filter(
    (s) => options.voice !== false || s.kind !== "voice"
  );
  const skipped = enabledSources().filter((s) => !sources.includes(s));
  for (const s of options.log === quietly ? [] : skipped) {
    log("source.read", { ok: true, skipped: s.missing?.(), source: s.name });
  }
  // The voice units the watcher writes, composed the same way (`voiceUnits`).
  let chapters: Unit[] = [];
  let voice: Built[] = [];
  const lifelog = sources.some((s) => s.kind === "voice")
    ? await safely(
        "lifelog",
        () =>
          withStore(async (store) => {
            const v = await voiceUnits(store, since, truth);
            ({ chapters } = v);
            voice = v.built;
            return v.conversations;
          }),
        failed
      )
    : [];
  // The recent messages' files are described, then every message's shown; only a chat's audio is heard.
  const recent = dayStart(lastDays(clock(), DAYS).from).toISOString();
  const readable = read.flatMap(({ events, s }) =>
    events.map((e) => asChatOrNot(e, s.kind === "chat"))
  );
  const files =
    options.files === false
      ? undefined
      : await describeFiles(
          readable.filter((e) => e.at >= recent),
          { engine: options.engine }
        );
  const known = keptFileLines();
  const shown = read.map(({ events, s }) => ({
    events: showFiles(events, known),
    s,
  }));
  const built = [
    ...chapters.map(frozenBuilt),
    ...applyRules(voice, keptConversations()),
    ...sourceUnitsOf(
      shown.flatMap(({ events }) => events),
      resolve
    ),
  ]
    .filter((b) => b.unit.date >= window.from && b.unit.date <= window.to)
    .toSorted((a, b) => a.unit.start.localeCompare(b.unit.start));
  return {
    built,
    conversations: lifelog,
    engine: options.engine,
    events: shown.flatMap(({ events }) => events),
    failed,
    /** The raw events that carry files: the watcher describes today's on arrival (`describeFilesOnArrival`). */
    fileEvents: readable.filter((e) => e.files?.length),
    /** `files.jsonl` as the lines above were shown with it: the arrival reader's one snapshot of what waits for a file. */
    fileLines: known,
    files,
    // By source, what this gather read (a source it did not read has no key: its units stay as they were).
    read: {
      ...(sources.some((s) => s.kind === "voice") && {
        lifelog: lifelog.length,
      }),
      ...Object.fromEntries(
        shown.map(({ events, s }) => [s.name, events.length])
      ),
    },
    repos,
    /** Sources he turned on that can't be read now: their units stay as they were. */
    skipped: (options.voice === false
      ? SOURCES.filter((s) => !sources.includes(s))
      : skipped
    ).map((s) => s.name),
    truth,
    window,
  };
}
export type Evidence = Awaited<ReturnType<typeof gather>>;

/**
 * Every readable source's events but lifelog's, from `since` to `before`, in the registry's order, each read through
 * `guard`: `safely` logs every read (a processing run's), `quietly` only a failure (the watcher's, every few minutes). A source
 * that throws is named in `failed` and gives no rows.
 */
export async function readSourceEvents(
  since: Date,
  before: Date | undefined,
  truth: Truth,
  guard: typeof safely = safely
) {
  const failed: string[] = [];
  const repos = repoMap(truth, await readInferredRepos());
  const ctx = { me: ownerIn(truth.people), repos };
  const read = await Promise.all(
    readySources()
      .flatMap((s) => (s.kind === "voice" ? [] : [s]))
      .map(async (s) => ({
        events: await guard(
          s.name,
          () => readEventsOf(s, since, ctx, before),
          failed
        ),
        s,
      }))
  );
  return { failed, read, repos };
}

/**
 * The voice units from `since` on, composed once for both writers (`gather`, `syncLifelogUnits`): the conversations
 * lifelog has that end at or after it, built into conversation-days; `have`, the stored voice units they replace (of a
 * conversation read, or ending at or after `since`), read from the earliest day either begins; the frozen chapters
 * among them (`frozenUnits`).
 */
export async function voiceUnits(store: Store, since: Date, truth: Truth) {
  const conversations = readConversations(store, since, lifelogNames(truth));
  const read = new Set(conversations.map((c) => c.id));
  const from = [since.toISOString(), ...conversations.map((c) => c.startedAt)]
    .map(localDate)
    .sort()[0] as string;
  const have = (await readUnits(from)).filter(
    (u) =>
      kindOf(u.source) === "voice" &&
      (read.has(u.key) || u.end >= since.toISOString())
  );
  const chapters = frozenUnits(store, have);
  return {
    built: lifelogUnits(
      conversations,
      new Set(chapters.map((u) => u.key)),
      deletionsNow()
    ),
    chapters,
    conversations,
    have,
  };
}
