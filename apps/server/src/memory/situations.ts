import { readdir } from "node:fs/promises";
import { daysBefore } from "../core/clock";
import { readJson, removeAllBut } from "../core/files";
import { endingAtNewest } from "../core/lists";
import { stamp } from "../models/llm";
import type { Episode } from "../records/episode";
import { Situation, SituationLine } from "../records/situation";
import { KEEP_AT } from "../records/unit";
import { contextPeopleBy, levelsWith, personallyClose } from "./closeness";
import {
  daysOf,
  episodesNow,
  pagePath,
  readEpisodes,
  SITUATIONS,
  situationPath,
} from "./memory-files";
import { refContext } from "./model-context";
import { backingOf, readingsOf, readPersona } from "./personas";
import { OWNER } from "./read-truth";
import { begin, inBatches, inputsOf } from "./run";
import { readPeople } from "./who";

// `bun life memory situations`: the situation step (docs/architecture.md, "The pipeline"). For him and each person close to
// him, one call reads the page, their persona (what repeats) and the DAYS days of episodes with them that end at their
// newest and writes where things stand now, each line citing its episodes. A situation is rebuilt whole, never from its
// last version, and only when those episodes changed: today's date, the page and the persona are shown to the call but
// never decide whether it runs (AGENTS.md, "One way to do each thing"). Nothing is sent.

const SITUATION_PROMPT = "memory-situation.v2";
/** Days of episodes a situation reads, ending at the newest; older ones live on in the page's sections and Earlier. */
const DAYS = 30;

const readSituation = (ref: string) => {
  const p = Situation.safeParse(readJson(situationPath(ref)));
  return p.success ? p.data : null;
};

/** A situation's lines a reader may show: those whose every cited episode is still live (`episodesNow`). */
export const readSituationNow = (ref: string, live: ReadonlySet<string>) =>
  (readSituation(ref)?.lines ?? []).filter((l) =>
    l.cites.every((id) => live.has(id))
  );

/** Situation lines as a reader shows them, under `title`; nothing when there is none. */
export const situationBlock = (title: string, lines: SituationLine[]) =>
  lines.length > 0
    ? [
        `${title} (where things stand, read each night from the ${DAYS} days up to their newest episode):`,
        ...lines.map((l) => `- ${l.text} [${l.cites.join(", ")}]`),
        "",
      ]
    : [];

/** Who has a situation: him and the people close to him, by their ref, sorted (a folder listing has no order). */
export const situated = async () =>
  (await readdir(SITUATIONS).catch(() => [] as string[]))
    .filter((f) => f.endsWith(".json"))
    .map((f) => `person:${f.slice(0, -".json".length)}`)
    .toSorted();

/** The reply's lines that cite only episodes the call was shown. */
export function shownLines(reply: unknown, shown: ReadonlySet<string>) {
  const list = (reply as { lines?: unknown } | null)?.lines;
  return (Array.isArray(list) ? list : []).flatMap((raw) => {
    const l = SituationLine.safeParse(raw);
    return l.success && l.data.cites.every((id) => shown.has(id))
      ? [l.data]
      : [];
  });
}

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

/** What a situation's digest holds: its episodes, nothing else (not the clock, not the page, not the persona). */
export const situationInputOf = (
  episodes: Episode[],
  nameOf: (ref: string) => string
) => ({ episodes: episodes.map((m) => episodeInput(m, nameOf)) });

export async function situations() {
  const step = await begin("situation", "main", { prompt: SITUATION_PROMPT });
  const people = await readPeople();
  const levels = levelsWith(people);
  const close = personallyClose(levels);
  const refs = refContext(people, close, contextPeopleBy(levels));
  const all = episodesNow(await readEpisodes(), people.corrections);
  const targets = [OWNER, ...close].flatMap((ref) => {
    const episodes = situationEpisodesOf(
      all,
      (m) => ref === OWNER || m.people.some((p) => people.refOf(p.ref) === ref)
    );
    return isRecent(episodes, step.today) ? [{ episodes, ref }] : [];
  });
  let written = 0;
  await inBatches(targets, step, (t, dir) =>
    step.attempt(
      async () => {
        const digested = situationInputOf(t.episodes, people.nameOf);
        const inputs = inputsOf(SITUATION_PROMPT, digested);
        if (readSituation(t.ref)?.inputs === inputs) {
          return;
        }
        const page = Bun.file(pagePath(t.ref));
        const input = {
          ...digested,
          page: {
            ref: t.ref,
            text: (await page.exists()) ? await page.text() : "",
          },
          // To tell what repeats from what is new.
          persona: readingsOf(readPersona(t.ref)?.lines ?? []).map((l) => ({
            backing: backingOf(l.quotes, step.today),
            facet: l.facet,
            text: l.text,
          })),
        };
        const reply = await step.ask({
          context: refs.context,
          dir,
          input: { ...input, today: step.today },
          prompt: SITUATION_PROMPT,
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
          madeBy: stamp(step.llm, SITUATION_PROMPT, step.run),
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
  // A situation whose person is no longer close or has no recent episode goes.
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
