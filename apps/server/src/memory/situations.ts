import { existsSync, readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { hasAddOn } from "../core/add-ons";
import { daysBefore } from "../core/clock";
import { readJson, removeAllBut } from "../core/files";
import { digest } from "../core/hash";
import { endingAtNewest } from "../core/lists";
import { MAY_KEEP, promptNameOf } from "../models/prompt-parts";
import type { Episode } from "../records/episode";
import { Situation, SituationLine } from "../records/situation";
import { KEEP_AT } from "../records/unit";
import {
  contextPeopleBy,
  levelsWith,
  pagedNow,
  personallyClose,
} from "./closeness";
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
import { begin, inBatches, inputsOf, readsOf, replyLines } from "./run";
import { readPeople } from "./who";

// `bun life memory situations`: the situation step (docs/architecture.md, "The pipeline"). For him and each person with a
// page who has an episode in the last DAYS days, one call reads the page, their persona (what repeats, while the
// `personas` add-on is on) and the DAYS days of episodes with them that end at their newest and writes where things
// stand now, each line citing its episodes. A situation is rebuilt whole, never from its last version, and only when
// what it was shown changed (`situationInputOf`): its episodes, the page, the persona and the prompt's variant, never
// today's date (AGENTS.md, "Invariants"). Nothing is sent.

const SITUATION_PROMPT = "memory-situation.v3";
/** Days of episodes a situation reads, ending at the newest; older ones live on in the page's sections and Earlier. */
const DAYS = 30;

const readSituation = (ref: string) => {
  const p = Situation.safeParse(readJson(situationPath(ref)));
  return p.success ? p.data : null;
};

/**
 * A situation's lines a reader may show (search and a person's read alike): those whose every cited episode stands
 * among `episodes` (`episodesNow`, or a function of the cited ids) and, for anyone but him, is still with them (`refOf`
 * reads its people as of today; his episodes leave him out of their people, so his own may cite any), and only when it
 * was made by the prompt variant the add-ons choose now, so switching one hides what it wrote at once (the next night
 * rebuilds it, `situationInputOf`).
 */
const situationNameNow = (mayKeep = readMayKeep()) =>
  promptNameOf(SITUATION_PROMPT, mayKeep === undefined ? [] : [MAY_KEEP]);

/** The episodes there are, as a reader holds them: their ids and people. */
type StandingEpisodes = readonly {
  id: string;
  people: readonly { ref: string }[];
}[];

export const readSituationNow = (
  ref: string,
  episodes: StandingEpisodes | ((cited: string[]) => StandingEpisodes),
  refOf: (ref: string) => string
) => {
  const situation = readSituation(ref);
  if (situation?.madeBy.prompt !== situationNameNow()) {
    return [];
  }
  const cited = [...new Set(situation.lines.flatMap((l) => l.cites))];
  const live = new Set(
    (typeof episodes === "function" ? episodes(cited) : episodes)
      .filter(
        (m) => ref === OWNER || m.people.some((p) => refOf(p.ref) === ref)
      )
      .map((m) => m.id)
  );
  return situation.lines.filter((l) => l.cites.every((id) => live.has(id)));
};

/** Situation lines as a reader shows them, under `title`; nothing when there is none. */
export const situationBlock = (title: string, lines: SituationLine[]) =>
  lines.length > 0
    ? [
        `${title} (where things stand, read each night from the ${DAYS} days up to their newest episode):`,
        ...lines.map((l) => `- ${l.text} [${l.cites.join(", ")}]`),
        "",
      ]
    : [];

/** Who has a situation: him and the people with a page, by their ref, sorted (a folder listing has no order). */
export const situated = async () =>
  (await readdir(SITUATIONS).catch(() => [] as string[]))
    .filter((f) => f.endsWith(".json"))
    .map((f) => `person:${f.slice(0, -".json".length)}`)
    .toSorted();

/** The reply's lines that cite only episodes the call was shown. */
export const shownLines = (reply: unknown, shown: ReadonlySet<string>) =>
  replyLines(reply, SituationLine).filter((l) =>
    l.cites.every((id) => shown.has(id))
  );

/**
 * The episodes a subject's situation reads: those of weight (`KEEP_AT`) with them, in the `DAYS` days ending at the
 * newest of them. The one set that decides who has a situation (see `isRecent`), what the call is shown and its digest.
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

/** Whether the newest of a subject's episodes is within `DAYS` days of `today`: only then has the subject a situation. */
export const isRecent = (episodes: Episode[], today: string) =>
  episodes.some((m) => daysOf(m)[1] >= daysBefore(today, DAYS));

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

/** Who gets a situation: him and everyone with a page (`paged`) who has a recent episode (`isRecent`), each with theirs. */
export const targetsOf = (
  paged: Iterable<string>,
  all: Episode[],
  refOf: (ref: string) => string,
  today: string
) =>
  [...new Set([OWNER, ...paged])].flatMap((ref) => {
    const episodes = situationEpisodesOf(
      all,
      (m) => ref === OWNER || m.people.some((p) => refOf(p.ref) === ref)
    );
    return isRecent(episodes, today) ? [{ episodes, ref }] : [];
  });

async function situationTargets(today: string) {
  const people = await readPeople();
  const all = episodesNow(await readEpisodes(), people.corrections);
  const targets = targetsOf(await pagedNow(people), all, people.refOf, today);
  return { levels: levelsWith(people), people, targets };
}

const pageText = (ref: string) =>
  existsSync(pagePath(ref)) ? readFileSync(pagePath(ref), "utf8") : "";

export async function situations(
  personaOf: (ref: string, today: string) => PersonaReading[]
) {
  const step = await begin("situation", "main", { prompt: SITUATION_PROMPT });
  const mayKeep = readMayKeep();
  const { levels, people, targets } = await situationTargets(step.today);
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
        const inputs = inputsOf(situationNameNow(mayKeep), {
          ...digested,
          ...(mayKeep === undefined ? {} : { mayKeep }),
        });
        if (readSituation(t.ref)?.inputs === inputs) {
          return;
        }
        const reply = await step.ask({
          context: refs.context,
          dir,
          input: {
            episodes: digested.episodes,
            page: { ref: t.ref, text },
            // To tell what repeats from what is new (its prompt part is cut while the add-on is off).
            ...(hasAddOn("personas") ? { persona } : {}),
            today: step.today,
          },
          prompt: SITUATION_PROMPT,
          // The page and the episodes are Life's own lines.
          reads: readsOf([
            { source: "memory", unit: t.ref },
            ...t.episodes.map((m) => ({
              source: "memory" as const,
              unit: m.id,
            })),
          ]),
        });
        const lines = shownLines(reply, new Set(t.episodes.map((m) => m.id)));
        // A reply with no line citing what it was shown is a failed call: the last situation stays, the next run retries.
        if (lines.length === 0) {
          throw new Error("no line cites the episodes it was shown");
        }
        const situation: Situation = {
          built: step.now.toISOString(),
          inputs,
          lines,
          madeBy: step.madeBy(SITUATION_PROMPT),
          page: t.ref,
          schemaVersion: 1,
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
  // A situation whose person has no page any more or no recent episode goes.
  const gone = await removeAllBut(
    SITUATIONS,
    new Set(targets.map((t) => situationPath(t.ref)))
  );
  return step.end({
    gone,
    situations: targets.length,
    written,
  });
}
