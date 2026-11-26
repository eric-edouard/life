import { existsSync, readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { hasAddOn } from "../core/add-ons";
import { removeAllBut } from "../core/files";
import { digest } from "../core/hash";
import { endingAtNewest } from "../core/lists";
import type { Episode } from "../records/episode";
import type { Situation } from "../records/situation";
import { KEEP_AT } from "../records/unit";
import {
  contextPeopleBy,
  levelsWith,
  pagedNow,
  personallyClose,
} from "./closeness";
import { shownKeyOf } from "./deletions";
import {
  daysOf,
  episodesNow,
  pagePath,
  readEpisodes,
  SITUATIONS,
  situationPath,
} from "./memory-files";
import { refContext } from "./model-context";
import { OWNER, readMayKeep } from "./read-truth";
import { begin, inBatches, inputsOf, readsOf } from "./run";
import {
  partsOf,
  promptNameNow,
  readStoredSituation,
  situationPartsNow,
} from "./situation-parts";
import { readPeople } from "./who";

// `bun life memory situations`: the situation step (docs/architecture.md, "The pipeline"). For him, each person with a
// page and each organization of his directory, one call reads the page, their story and persona (while the `histories`
// and `personas` add-ons are on) and the DAYS days of episodes with them that end at their newest, and writes the page he
// sees when opening them, as Markdown parts to him, each citing what it rests on. A situation is rebuilt whole, never
// from its last version, and only when what it was shown changed (`situationInputOf`): its episodes, the page, the
// persona and the prompt's variant, never the story (another summary) or today's date (AGENTS.md, "Invariants"). One
// with nothing new costs no call, ever. Nothing is sent.

const SITUATION_PROMPT = "memory-situation.v4";
/** Days of episodes a situation reads, ending at the newest; older ones live on in the page and the story. */
const DAYS = 30;

const readSituation = (ref: string) =>
  readStoredSituation(situationPath(ref), shownKeyOf.situation(ref));

/** The episodes there are, as a reader holds them: their ids and people. */
type StandingEpisodes = readonly {
  id: string;
  people: readonly { ref: string }[];
}[];

/**
 * Someone's situation parts a reader may show (search and a person's read alike): those whose every cited episode stands
 * among `episodes` (`episodesNow`, or a function of the cited ids) and, for anyone but him, is still with them (`refOf`
 * reads its people as of today; his episodes leave him out of their people, so his own may cite any); a part may also
 * cite their page and their story. Only when made by the prompt variant the add-ons choose now.
 */
export const readSituationNow = (
  ref: string,
  episodes: StandingEpisodes | ((cited: string[]) => StandingEpisodes),
  refOf: (ref: string) => string
) => {
  const cited = [
    ...new Set(readSituation(ref)?.parts.flatMap((p) => p.cites) ?? []),
  ];
  const live = new Set([
    ref,
    `${ref}/story`,
    ...(typeof episodes === "function" ? episodes(cited) : episodes)
      .filter(
        (m) => ref === OWNER || m.people.some((p) => refOf(p.ref) === ref)
      )
      .map((m) => m.id),
  ]);
  return situationPartsNow(
    situationPath(ref),
    shownKeyOf.situation(ref),
    SITUATION_PROMPT,
    live
  );
};

/** Who has a situation: by their ref, sorted (a folder listing has no order). */
export const situated = async () =>
  (await readdir(SITUATIONS).catch(() => [] as string[]))
    .filter((f) => f.endsWith(".json"))
    .map((f) => `person:${f.slice(0, -".json".length)}`)
    .toSorted();

/**
 * The episodes a subject's situation reads: those of weight (`KEEP_AT`) with them, in the `DAYS` days ending at the
 * newest of them (which may be months ago). What the call is shown and its digest.
 */
export const situationEpisodesOf = (
  all: Episode[],
  isWith: (m: Episode) => boolean
) =>
  endingAtNewest(
    all.filter((m) => m.importance >= KEEP_AT && isWith(m)),
    (m) => daysOf(m)[1],
    DAYS
  );

/** An episode as the situation call is shown it, names as of now. */
const episodeInput = (m: Episode, nameOf: (ref: string) => string) => ({
  day: m.start ?? m.day,
  id: m.id,
  people: m.people.map((p) => nameOf(p.ref)),
  place: m.place,
  title: m.title,
  what: m.what,
});

/**
 * What a situation's digest holds: its episodes, the page's digest and, while the `personas` add-on is on, the persona's
 * readings (their text, not their backing, which moves with the clock); never the clock itself.
 */
export const situationInputOf = (
  episodes: Episode[],
  nameOf: (ref: string) => string,
  page = "",
  persona: PersonaReading[] = []
) => ({
  episodes: episodes.map((m) => episodeInput(m, nameOf)),
  page: digest("sha256", page, 16),
  persona: persona.map(({ facet, text }) => ({ facet, text })),
});

/** What a person's persona says to the call, to tell what repeats from what is new: handed in by the host (`personal/`). */
export interface PersonaReading {
  backing: string;
  facet: string;
  text: string;
}

/** What the host hands the step from `personal/`, which memory cannot read: the persona's readings and the story's text. */
export interface SituationReadings {
  personaOf: (ref: string, today: string) => PersonaReading[];
  storyOf: (ref: string) => string | undefined;
}

/**
 * Who has a situation (`subjects`: him, everyone with a page and each organization of his directory, whose files are
 * kept) and who gets a call (`targets`: those of them with an episode, each with theirs).
 */
export const targetsOf = (
  subjects: Iterable<string>,
  all: Episode[],
  refOf: (ref: string) => string
) => {
  const kept = [...new Set([OWNER, ...subjects])];
  return {
    kept,
    targets: kept.flatMap((ref) => {
      const episodes = situationEpisodesOf(
        all,
        (m) => ref === OWNER || m.people.some((p) => refOf(p.ref) === ref)
      );
      return episodes.length > 0 ? [{ episodes, ref }] : [];
    }),
  };
};

async function situationTargets() {
  const people = await readPeople();
  const all = episodesNow(await readEpisodes(), people.corrections);
  const subjects = [
    ...(await pagedNow(people)),
    ...people.truth.organizations.map((o) => `person:${o.id}`),
  ];
  return {
    levels: levelsWith(people),
    people,
    ...targetsOf(subjects, all, people.refOf),
  };
}

const pageText = (ref: string) =>
  existsSync(pagePath(ref)) ? readFileSync(pagePath(ref), "utf8") : "";

export async function situations({ personaOf, storyOf }: SituationReadings) {
  const step = await begin("situation", "main", { prompt: SITUATION_PROMPT });
  const mayKeep = readMayKeep();
  const { kept, levels, people, targets } = await situationTargets();
  const refs = refContext(
    people,
    personallyClose(levels),
    contextPeopleBy(levels)
  );
  let written = 0;
  await inBatches(targets, step, (t, dir) =>
    step.attempt(
      async () => {
        const persona = hasAddOn("personas")
          ? personaOf(t.ref, step.today)
          : [];
        const text = pageText(t.ref);
        const digested = situationInputOf(
          t.episodes,
          people.nameOf,
          text,
          persona
        );
        // His words on what Life may keep are an input: adding or changing them rebuilds the situation.
        const inputs = inputsOf(promptNameNow(SITUATION_PROMPT, mayKeep), {
          ...digested,
          ...(mayKeep === undefined ? {} : { mayKeep }),
        });
        if (readSituation(t.ref)?.inputs === inputs) {
          return;
        }
        // The story is another summary: shown, never in the digest (AGENTS.md, "A summary is redone only when…").
        const story = t.ref === OWNER ? undefined : storyOf(t.ref);
        const input = {
          episodes: digested.episodes,
          page: { ref: t.ref, text },
          // To tell what repeats from what is new (its prompt part is cut while the add-on is off).
          ...(hasAddOn("personas") ? { persona } : {}),
          ...(story ? { story: { ref: `${t.ref}/story`, text: story } } : {}),
          today: step.today,
        };
        const reply = await step.ask({
          context: refs.context,
          dir,
          input,
          prompt: SITUATION_PROMPT,
          // The page, the story and the episodes are Life's own lines.
          reads: readsOf([
            { source: "memory", unit: t.ref },
            ...t.episodes.map((m) => ({
              source: "memory" as const,
              unit: m.id,
            })),
          ]),
        });
        const situation: Situation = {
          built: step.now.toISOString(),
          inputs,
          madeBy: step.madeBy(SITUATION_PROMPT),
          parts: partsOf(
            reply,
            new Set([
              t.ref,
              ...(story ? [`${t.ref}/story`] : []),
              ...t.episodes.map((m) => m.id),
            ]),
            input
          ),
          schemaVersion: 2,
          subject: t.ref,
        };
        await Bun.write(
          situationPath(t.ref),
          `${JSON.stringify(situation, null, 1)}\n`
        );
        written += 1;
      },
      { page: t.ref }
    )
  );
  // A situation whose person has no page any more, or whose organization left his directory, goes.
  const gone = await removeAllBut(
    SITUATIONS,
    new Set(kept.map((ref) => situationPath(ref)))
  );
  return step.end({
    gone,
    situations: targets.length,
    written,
  });
}
