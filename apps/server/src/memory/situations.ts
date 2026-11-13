import { readdir } from "node:fs/promises";
import { daysBefore } from "../core/clock";
import { readJson, removeAllBut } from "../core/files";
import { stamp } from "../models/llm";
import type { Episode } from "../records/episode";
import { Situation, SituationLine } from "../records/situation";
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
import { readingsOf, readPersona, supportOf } from "./personas";
import { OWNER } from "./read-truth";
import { begin, inBatches, inputsOf } from "./run";
import { readPeople } from "./who";

// `bun life memory situations`: the situation step (docs/architecture.md, "The pipeline"). For him and each person close to
// him, one call reads the page, their persona (what repeats) and the last DAYS days' episodes with them and
// writes where things stand now, each line citing its episodes. A situation is rebuilt whole from those inputs, never from its last version, and only when they
// changed. Nothing is sent.

const SITUATION_PROMPT = "memory-situation.v2";
/** Days of episodes a situation reads; older ones live on in the page's sections and History. */
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
        `${title} (where things stand, read each night from the last ${DAYS} days):`,
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

export async function situations() {
  const step = await begin("situation", "main", { prompt: SITUATION_PROMPT });
  const people = await readPeople();
  const levels = levelsWith(people);
  const close = personallyClose(levels);
  const refs = refContext(people, close, contextPeopleBy(levels));
  const since = daysBefore(step.today, DAYS);
  const recent = episodesNow(await readEpisodes(), people.corrections).filter(
    (m) => daysOf(m)[1] >= since
  );
  const asInput = (m: Episode) => ({
    day: m.start ?? m.day,
    id: m.id,
    people: m.people.map((p) => people.nameOf(p.ref)),
    place: m.place,
    title: m.title,
    what: m.what,
  });
  const targets = [OWNER, ...close].flatMap((ref) => {
    const episodes = recent.filter(
      (m) => ref === OWNER || m.people.some((p) => people.refOf(p.ref) === ref)
    );
    return episodes.length > 0 ? [{ episodes, ref }] : [];
  });
  let written = 0;
  await inBatches(targets, step, (t, dir) =>
    step.attempt(
      async () => {
        const page = Bun.file(pagePath(t.ref));
        const input = {
          episodes: t.episodes.map(asInput),
          page: {
            ref: t.ref,
            text: (await page.exists()) ? await page.text() : "",
          },
          // To tell what repeats from what is new.
          persona: readingsOf(readPersona(t.ref)?.lines ?? []).map((l) => ({
            facet: l.facet,
            support: supportOf(l.quotes, step.today),
            text: l.text,
          })),
        };
        const inputs = inputsOf(SITUATION_PROMPT, input);
        if (readSituation(t.ref)?.inputs === inputs) {
          return;
        }
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
