import { parseArgs } from "node:util";
import { clock } from "../clock";
import { closeness } from "./closeness";
import { extract } from "./extract";
import { changeFeed, claim } from "./feed";
import { locked, readBackfill, recordBackfill } from "./guard";
import { lifeStatus, runs } from "./history";
import { recordCorrection } from "./ledger";
import { moments } from "./moments";
import { midday, nightly } from "./nightly";
import { pages } from "./pages";
import { placesOf } from "./places";
import { chatsOf, fetchOf } from "./raw";
import { mapRepos, reposOf } from "./repos";
import {
  area,
  day,
  person,
  reindex,
  search,
  topicsOf,
  unresolved,
} from "./search";
import { addStatements } from "./statements";
import { DAYS, gather, lastDays } from "./units";
import { firstZoneDay } from "./zones";

// The memory command line: parses the arguments and calls the steps.

const OPTIONS = {
  about: { type: "string" },
  at: { type: "string" },
  before: { type: "string" },
  chat: { type: "string" },
  cursor: { type: "string" },
  days: { type: "string" },
  force: { type: "boolean" },
  from: { type: "string" },
  "from-turn": { type: "string" },
  latitude: { type: "string" },
  limit: { type: "string" },
  longitude: { type: "string" },
  only: { type: "string" },
  person: { type: "string" },
  place: { type: "string" },
  radius: { type: "string" },
  rebuild: { type: "boolean" },
  run: { type: "string" },
  scan: { type: "boolean" },
  since: { type: "string" },
  steps: { type: "string" },
  to: { type: "string" },
  types: { type: "string" },
  who: { type: "string" },
} as const;

const parse = (args: string[]) =>
  parseArgs({ allowPositionals: true, args, options: OPTIONS });
type Values = ReturnType<typeof parse>["values"];

/**
 * A step command: prints the step's summary; a non-zero exit when anything failed. It holds the nightly's lock, so the
 * watcher doesn't sync while a hand-run step writes memory/.
 */
const step =
  (run: (values: Values) => Promise<{ failed: number }>): Handler =>
  async (values) => {
    const summary = await locked(() => run(values));
    if (!summary) {
      return 1;
    }
    console.log(JSON.stringify(summary));
    return summary.failed > 0 ? 1 : 0;
  };

type Handler = (values: Values, rest: string[]) => Promise<number>;

/** A hand-run step's evidence: its last `--days` days, gathered once for it (a sweep gathers once for all its steps). */
const gathered = (v: Values) =>
  gather(lastDays(clock(), Number(v.days ?? DAYS)));

const scan = step(() => mapRepos());

/** Prints a read command's answer; no answer (arguments missing) is a usage error. */
async function printed(answer: Promise<string | null> | string | null) {
  const text = await answer;
  if (!text) {
    return usage();
  }
  console.log(text);
  return 0;
}

/** Prints a dashboard read as JSON. */
async function json(answer: Promise<unknown>) {
  try {
    console.log(JSON.stringify(await answer, null, 1));
    return 0;
  } catch (e) {
    console.error((e as Error).message);
    return 1;
  }
}

const list = (v?: string) => v?.split(",").filter(Boolean);
const words = (rest: string[]) => rest.join(" ").trim();
const count = (n?: string) => (n === undefined ? undefined : Number(n));
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const HANDLERS: Record<string, Handler> = {
  area: (_values, rest) => printed(rest.length > 0 ? area(words(rest)) : null),
  backfill(v) {
    if (
      !(v.from && v.to && DAY.test(v.from) && DAY.test(v.to) && v.from <= v.to)
    ) {
      return Promise.resolve(usage());
    }
    // His zones must cover it first: a past zone can't be added once memory has units of its days (SCHEMA.md).
    if (v.from < firstZoneDay()) {
      console.error(
        `record his zones from ${v.from} first (memory/zones.jsonl starts on ${firstZoneDay()})`
      );
      return Promise.resolve(1);
    }
    // The ticks read it, a week each, when no night or midday run is due (nightly.ts); not while a week runs.
    const { from, to } = v;
    return locked(() => {
      // A new range keeps the weeks this day read already: setting it again never lifts the day's cap.
      recordBackfill({ ...readBackfill(), failures: 0, next: from, to });
      console.log(`backfill set: ${from} to ${to}, a few weeks a day`);
      return Promise.resolve(0);
    }).then((code) => code ?? 1);
  },
  changes: (v) =>
    json(
      changeFeed({
        ...v,
        limit: count(v.limit),
        types: list(v.types),
      })
    ),
  chats: (values) => printed(chatsOf(values)),
  claim: (_values, [id = ""]) => json(claim(id)),
  closeness: step(() => closeness()),
  /** `correct '<json>'`: appends what the owner said to memory/corrections.jsonl (checked, stamped). */
  async correct(_values, rest) {
    try {
      const said = await recordCorrection(JSON.parse(rest.join(" ")));
      console.log(`recorded ${said.kind} in memory/corrections.jsonl`);
      return 0;
    } catch (e) {
      console.error((e as Error).message);
      return usage();
    }
  },
  day: (_values, [date = ""]) => printed(DAY.test(date) ? day(date) : null),
  extract: step(async (v) => extract(await gathered(v))),
  fetch: (values, [id]) =>
    printed(
      id ? fetchOf(id, count(values["from-turn"]), count(values.limit)) : null
    ),
  async index() {
    await reindex();
    return 0;
  },
  midday: (values) => midday(clock(), values.force),
  moments: step(async (v) => moments(await gathered(v))),
  nightly: (values) => nightly(Number(values.days ?? DAYS), values.force),
  pages: step((v) => pages({ only: v.only, rebuild: v.rebuild })),
  person: (values, rest) => printed(person(words(rest) || undefined, values)),
  places: (v) =>
    printed(
      placesOf({
        ...v,
        latitude: count(v.latitude),
        longitude: count(v.longitude),
        radiusM: count(v.radius),
      })
    ),
  repos: (values, rest) =>
    values.scan
      ? scan(values, rest)
      : printed(reposOf(words(rest) || undefined)),
  runs: (v) =>
    json(
      runs({ cursor: v.cursor, limit: count(v.limit), steps: list(v.steps) })
    ),
  search: (values, rest) =>
    printed(rest.length > 0 ? search(words(rest), values) : null),
  /** `statements <n>`: draws n more statements for the truth benchmark (memory/statements.jsonl). */
  statements: (values, [n = ""]) =>
    Number(n) > 0 ? step(() => addStatements(Number(n)))(values, []) : usage(),
  status: () => json(lifeStatus()),
  topics: (values, rest) =>
    printed(topicsOf(words(rest) || undefined, values.person)),
  async unresolved() {
    console.log(await unresolved());
    return 0;
  },
};

function usage() {
  console.error(
    "usage: bun life memory moments [--days 7] | extract [--days 7] | backfill --from d --to d | closeness | pages [--only <id>] [--rebuild] | nightly [--force] | midday [--force] | repos [project|area|repo] [--scan] | index | correct '<json>' | statements <n> | search <words> [--from d] [--to d] | fetch <id> [--from-turn n] [--limit n] | day <YYYY-MM-DD> | person [name] [--before d] | places --at <instant|date> | --place <name> | --latitude n --longitude n [--radius m] [--from d] [--to d] | area <id> | chats --who <name|handle> | --chat <id> [--from d] [--to d] [--before instant] | topics [tag] [--person <id>] | unresolved | status | runs [--steps a,b] [--cursor c] [--limit n] | changes [--types a,b] [--about ref] [--run r] [--since iso] [--cursor c] [--limit n] | claim <obs_id>"
  );
  return Promise.resolve(2);
}

export function memoryCommand(args: string[]): Promise<number> {
  const { positionals, values } = parse(args);
  const [name = "", ...rest] = positionals;
  const handler = HANDLERS[name];
  return handler ? handler(values, rest) : usage();
}
