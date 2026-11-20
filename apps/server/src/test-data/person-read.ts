import type { PartInputs } from "../memory/read-person-page";

// The made-up person read the part tests share (memory/ and personal/): a few years of months, each with three days of
// evidence and a held line, about 300 characters an entry, so a part has to be paged.

/** The months of these years, `YYYY-MM`. */
export const monthsOf = (years: number[]) =>
  years.flatMap((y) =>
    Array.from(
      { length: 12 },
      (_, i) => `${y}-${String(i + 1).padStart(2, "0")}`
    )
  );

/** Observations, an episode and a recorded conversation on three days a month, newest first. */
export const timelineOf = (months: string[]) =>
  months
    .flatMap((m) =>
      ["03", "12", "25"].flatMap((d) => [
        {
          day: `${m}-${d}`,
          kind: "observation" as const,
          line: `- obs ${m}-${d} ${"x".repeat(300)}`,
        },
        {
          day: `${m}-${d}`,
          kind: "episode" as const,
          line: `- episode ${m}-${d} ${"y".repeat(300)}`,
        },
        ...(d === "12"
          ? [
              {
                day: `${m}-${d}`,
                kind: "conversation" as const,
                line: `- conv ${m}-${d} 10:00: lunch`,
              },
            ]
          : []),
      ])
    )
    .toSorted((a, b) => b.day.localeCompare(a.day));

/** What Life holds, as `held` gives it: the sources, then a line a month. */
export const heldOf =
  (months: string[]) =>
  ({ sourcesOnly, span }: { sourcesOnly?: boolean; span?: string } = {}) => [
    ...(span ? [] : ["HELD sources"]),
    ...(sourcesOnly
      ? []
      : months.filter((m) => m.startsWith(span ?? "")).map((m) => `HELD ${m}`)),
  ];

/** The inputs of `partLines` for Ana, with no part an add-on supplies offered. */
export const baseOf = (years: number[]) => {
  const months = monthsOf(years);
  return {
    heard: [],
    held: heldOf(months),
    heldYears: years.map(String),
    offers: [] as PartInputs["offers"],
    ref: "person:ana",
    timeline: timelineOf(months),
  };
};
