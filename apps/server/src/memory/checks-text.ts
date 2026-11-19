import type { Check } from "./checks";

const BIG = 5;
/** How many ride on an open matter, and of the rest on one line, two to five, more than five. */
const spread = (list: Check[]) => {
  const rest = list.filter((c) => c.ridesOn.matters === 0);
  const lines = (from: number, to: number) =>
    rest.filter(
      (c) => c.ridesOn.observations >= from && c.ridesOn.observations <= to
    ).length;
  return `Riding on: ${list.length - rest.length} on an open matter; of the other ${rest.length}, ${lines(1, 1)} on 1 line, ${lines(2, BIG)} on 2 to ${BIG} lines, ${lines(BIG + 1, Number.POSITIVE_INFINITY)} on more than ${BIG}.`;
};

/** `bun life memory checks`: the count by kind and by what rides, then every row, most load-bearing first. */
export function checksText(list: Check[]) {
  const groups = Map.groupBy(list, (c) => c.group);
  return [
    `${list.length} checks: ${[...groups].map(([g, l]) => `${l.length} ${g}`).join(", ") || "none"}.`,
    spread(list),
    "",
    ...list.flatMap((c, i) => [
      `${i + 1}. [${c.group}] ${c.ref}: ${c.question}`,
      ...(c.about.length > 0 ? [`   about: ${c.about.join(", ")}`] : []),
      ...(c.goal ? [`   goal: ${c.goal}`] : []),
      ...(c.said ? [`   ${c.said.by ?? "?"}: "${c.said.text}"`] : []),
      ...(c.evidence ? [`   "${c.evidence.quote}" (${c.evidence.from})`] : []),
      `   rides on: ${c.ridesOn.observations} observations, ${c.ridesOn.matters} open matters, ${c.ridesOn.pages} pages. His answer: ${c.options.map((o) => o.id).join(" | ")}`,
      "",
    ]),
  ].join("\n");
}
