// `bun scripts/pair-counts.ts <person>…`: code's counts over all their 1:1 messages, Markdown on stdout only.
import { parseArgs } from "node:util";
import { directOf, readWithPeople } from "@life/server/src/memory/closeness";
import { pairCountsOf } from "@life/server/src/memory/personas";
import { readPeople } from "@life/server/src/memory/who";
import { localDate } from "@life/server/src/memory/zones";
import type { SourceEvent } from "@life/server/src/records/source";

/** All the persona's counts, explained without its internal field names. */
function countLinesOf(messages: SourceEvent[]) {
  const c = pairCountsOf(messages);
  return [
    `- Days with a message: ${c.days}.`,
    `- Messages the owner sent: ${c.sent}.`,
    `- Messages the person sent: ${c.got}.`,
    `- Sent messages the owner deleted: ${c.sentDeleted}.`,
    `- Sent messages the person deleted: ${c.gotDeleted}.`,
    `- Owner wrote first after 6 hours of quiet (including the first exchange): ${c.heOpened}.`,
    `- Person wrote first after 6 hours of quiet (including the first exchange): ${c.theyOpened}.`,
    `- Owner's median minutes to answer within an exchange: ${c.heAnswersIn ?? "no answers"}.`,
    `- Person's median minutes to answer within an exchange: ${c.theyAnswerIn ?? "no answers"}.`,
  ];
}

export function pairMarkdownOf(name: string, messages: SourceEvent[]) {
  const years = [
    ...Map.groupBy(messages, (e) => localDate(e.at).slice(0, 4)),
  ].sort(([a], [b]) => a.localeCompare(b));
  return [
    `# ${name}`,
    "",
    "## Overall",
    "",
    ...countLinesOf(messages),
    ...years.flatMap(([year, list]) => [
      "",
      `## ${year}`,
      "",
      ...countLinesOf(list),
    ]),
    "",
  ].join("\n");
}

if (import.meta.main) {
  const { positionals } = parseArgs({ allowPositionals: true });
  if (positionals.length === 0) {
    throw new Error("usage: bun scripts/pair-counts.ts <person>…");
  }
  const people = await readPeople();
  const { events, failed } = await readWithPeople(new Date(0));
  for (const { known, messages } of directOf(positionals, events, people)) {
    if (!known) {
      throw new Error("no person matches a requested name");
    }
    console.log(pairMarkdownOf(people.nameOf(`person:${known}`), messages));
  }
  if (failed.length > 0) {
    console.log(`Not read, so missing above: ${failed.join(", ")}`);
  }
}
