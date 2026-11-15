import { clock } from "../core/clock";
import type { Episode } from "../records/episode";
import type { FactCheck } from "../records/fact-check";
import type { Observation } from "../records/observation";
import { pagedNow } from "./closeness";
import {
  episodesNow,
  observationStatusOf,
  readEpisodes,
  shows,
} from "./memory-files";
import { placed } from "./page-format";
import { SURE_AT } from "./quote-check";
import { observationsNow, type People, readPeople } from "./who";
import { when } from "./zones";

// What the memory holds in words (`memoryLinesNow`, which the eval judges too) and which lines are doubtful (`doubtsOf`).
// Who he is asked about is `checksNow`'s (`checks.ts`).

/** A local `YYYY-MM-DD[ HH:MM]` as he'd say it: "7 Sep 23:00", with the year when it isn't this one. */
export const plain = (t: string) =>
  `${when(t.slice(0, 10)).date}${t.startsWith(String(clock().getFullYear())) ? "" : ` ${t.slice(0, 4)}`}${t.slice(10)}`;

/** An episode in plain words: "Dinner, 7 Sep 20:00–22:30, at Chez Paul; with Zoé; told Dad." */
export function episodeText(m: Episode, name: (ref: string) => string) {
  const end = m.end?.startsWith(m.start?.slice(0, 10) ?? "-")
    ? m.end.slice(11)
    : m.end && plain(m.end);
  const time = [m.start && plain(m.start), end].filter(Boolean).join("–");
  const roles = (["with", "organizer", "told"] as const)
    .map((role) => {
      const them = m.people
        .filter((p) => p.role === role)
        .map((p) => name(p.ref));
      return them.length > 0 ? `; ${role} ${them.join(", ")}` : "";
    })
    .join("");
  return `${m.title}${time && `, ${time}`}${m.place ? `, at ${m.place}` : ""}${roles}.`;
}

/** Where an episode is checked: the one person with a page it was with (as who.ts says today), else `episodes`. */
export function episodeGroup(
  m: Episode,
  paged: ReadonlySet<string>,
  refOf: (ref: string) => string
) {
  const withPage = new Set(
    m.people.flatMap((p) => (p.role === "with" ? [refOf(p.ref)] : []))
  ).intersection(paged);
  return withPage.size === 1 ? ([...withPage][0] as string) : "episodes";
}
type Draft = Omit<FactCheck, "at" | "schemaVersion">;

/** Why a memory line may be wrong, by rules on what is stored: who it is about is only inferred, the model was unsure. */
export type Doubt = "guessed-person" | "low-confidence";

/** The guessed people a line rests on (`isGuess`, folded as read today), each once: the one rule for "who it is about is only guessed". */
export const guessedOf = (
  o: Pick<Observation, "about" | "subjects">,
  people: Pick<People, "isGuess" | "refOf">
) => [
  ...new Set(
    [o.about, ...o.subjects].flatMap((ref) =>
      ref && people.isGuess(ref) ? [people.refOf(ref)] : []
    )
  ),
];

/** An observation's doubts (the one place "doubtful" is decided): low confidence counts only beside another doubt. */
export function doubtsOf(
  o: Pick<Observation, "about" | "confidence" | "subjects" | "unit">,
  people: Pick<People, "isGuess" | "refOf">
): Doubt[] {
  const found: Doubt[] =
    guessedOf(o, people).length > 0 ? ["guessed-person"] : [];
  return found.length > 0 && o.confidence < SURE_AT
    ? [...found, "low-confidence"]
    : found;
}

export type MemoryLine = Omit<Draft, "group"> & {
  doubts: Doubt[];
  group: Draft["group"] | null;
  importance: number;
};

/** A fact check's `kind` for an observation: its modality when plan or reported, else a fact. */
export const factCheckKindOf = (o: {
  modality?: string | null;
}): "fact" | "plan" | "reported" =>
  o.modality === "plan" || o.modality === "reported" ? o.modality : "fact";

/**
 * What the memory holds now, in the words it is stated and judged in: the active observations and the episodes.
 * `group` is where the owner would rate it, or null: an observation's home page when it is a line there (`placed`,
 * not hidden on it); an episode's `episodeGroup`.
 */
export async function memoryLinesNow(): Promise<MemoryLine[]> {
  const people = await readPeople();
  const { observations, statusInputs } = await observationsNow(people);
  const paged = await pagedNow(people);
  const { homes } = placed(observations, people.truth, paged);
  const home = new Map(
    [...homes].flatMap(([page, list]) => list.map(({ o }) => [o.id, page]))
  );
  const episodes = episodesNow(await readEpisodes(), people.corrections);
  const facts = observations.flatMap((o) => {
    const s = observationStatusOf(o, statusInputs);
    if (s.state !== "active") {
      return [];
    }
    const page = home.get(o.id);
    return [
      {
        date: o.date,
        doubts: doubtsOf(o, people),
        group: page && shows(s, page) ? page : null,
        importance: o.importance,
        kind: factCheckKindOf(o),
        ref: o.id,
        source: o.source.channel,
        text: o.when ? `${o.text} (for ${plain(o.when)})` : o.text,
        units: [o.unit],
      },
    ];
  });
  return [
    ...facts,
    ...episodes.map((m) => ({
      date: m.day,
      doubts: [],
      group: episodeGroup(m, paged, people.refOf),
      importance: m.importance,
      kind: "episode" as const,
      ref: m.id,
      source: null,
      text: episodeText(m, people.nameOf),
      units: m.units,
    })),
  ];
}
