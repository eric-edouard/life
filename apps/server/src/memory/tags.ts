import { normalize } from "./units";

// The area and topic tags the models return (a verdict's, an episode's, an observation's), as stored.

const TOPICS_MAX = 3;
const SINGULAR_KEEPS = /(?:ss|us|is|ics|news)$/;
const SINGULAR_ES = /(?:xes|ches|shes)$/;

/** "Constructions" -> "construction": a tag's last word singular where that is trivial. */
function singular(w: string) {
  if (w.length < 4 || SINGULAR_KEEPS.test(w)) {
    return w;
  }
  if (SINGULAR_ES.test(w)) {
    return w.slice(0, -2);
  }
  if (w.endsWith("ies")) {
    return `${w.slice(0, -3)}y`;
  }
  return w.endsWith("s") ? w.slice(0, -1) : w;
}

/** The model's topic tags as stored: at most three, lower case, dashed, singular, no repeats. */
export function normalizeTopics(raw: string[] | null | undefined) {
  const tags = (raw ?? []).flatMap((t) => {
    const words = normalize(t).split(" ").filter(Boolean);
    const last = words.pop();
    return last ? [[...words, singular(last)].join("-")] : [];
  });
  return [...new Set(tags)].slice(0, TOPICS_MAX);
}

/** Every area id and name, normalized, to its id: the model may answer with either. */
export const areaLookup = (areas: { id: string; name: string }[]) =>
  new Map(
    areas.flatMap((a) => [a.id, a.name].map((k) => [normalize(k), a.id]))
  );

/** The area id for what the model said (id or name, any case), or null when it names none. */
export const areaOf = (said: string | null, lookup: Map<string, string>) =>
  (said && lookup.get(normalize(said))) || null;
