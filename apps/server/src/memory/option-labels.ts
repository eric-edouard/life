import type { CheckGroup, CheckOption } from "./life-checks";

/**
 * The options as his buttons say them: the one that takes a person for a name, a voice or a card says who it proposes by
 * first name ("It is Léo", a voice's just "Léo"): the first of its `likelyPeople`, else the name a voice was called or the one name a name check asks about; a voice with none says "Name them…". A guessed
 * person's "someone Life already knows" is another person, so it keeps its words; with no one to name the label stays.
 */
export function namedOptionsOf(check: {
  about: string[];
  group: CheckGroup;
  likelyPeople: { name: string }[];
  options: CheckOption[];
}) {
  const isVoice = check.group === "voice";
  const proposed =
    check.likelyPeople[0]?.name ??
    (isVoice || (check.group === "name" && check.about.length === 1)
      ? check.about[0]
      : undefined);
  const first = proposed?.split(" ")[0];
  let label: string | undefined;
  if (first) {
    label = isVoice ? first : `It is ${first}`;
  } else if (isVoice) {
    label = "Name them…";
  }
  return check.options.map((o, i) =>
    label &&
    i === 0 &&
    o.takes?.startsWith("person") &&
    check.group !== "guessed person"
      ? { ...o, label }
      : o
  );
}
