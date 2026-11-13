import { parseArgs } from "node:util";
import { clock } from "../core/clock";
import { settings } from "../core/settings";
import { appointments } from "../memory/appointments";
import { changeFeed, claim } from "../memory/changes";
import { closeness, readWithPeople } from "../memory/closeness";
import { writeContactPeople } from "../memory/contact-people";
import { drawDoubtful } from "../memory/doubts";
import { episodes } from "../memory/episodes";
import { writeExchangeCounts } from "../memory/exchange-counts";
import { exchangeReads, readExchangeReadWork } from "../memory/exchange-reads";
import { extract } from "../memory/extract";
import { collectHistorical } from "../memory/historical-collection";
import { histories, readHistoryWork } from "../memory/histories";
import { reindex } from "../memory/index-writer";
import { links, readEndings, readLinkWork } from "../memory/links";
import { recordCorrection, recordRating } from "../memory/memory-files";
import { locked } from "../memory/memory-lock";
import { pages } from "../memory/pages";
import { rebuildPassages } from "../memory/passage-rebuild";
import { personas } from "../memory/personas";
import { placesOf } from "../memory/places";
import { area, topicsOf } from "../memory/read-area-page";
import { day } from "../memory/read-day";
import { person } from "../memory/read-person-page";
import { unresolved } from "../memory/read-unresolved";
import { writeRecordedDays } from "../memory/recorded-days";
import { mapRepos, reposOf } from "../memory/repos";
import { runs } from "../memory/run-log";
import { readBackfill, recordBackfill } from "../memory/schedule";
import { search } from "../memory/search";
import { situations } from "../memory/situations";
import { DAYS, gather } from "../memory/units";
import { meant, readPeople } from "../memory/who";
import { chatsOf, fetchOf } from "../memory/words";
import { dayNow, firstZoneDay, isDay, lastDays } from "../memory/zones";
import { Rating } from "../records/fact-check";
import { nightly } from "./nightly";
import { lifeStatus } from "./status/life";

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
export const step =
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
const gathered = async (v: Values) =>
  gather(lastDays(clock(), Number(v.days ?? DAYS)), await readPeople());

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

/** Prints a status read as JSON. */
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

const HANDLERS: Record<string, Handler> = {
  appointments: step(() => appointments()),
  area: (_values, rest) => printed(rest.length > 0 ? area(words(rest)) : null),
  backfill(v) {
    if (!(v.from && v.to && isDay(v.from) && isDay(v.to) && v.from <= v.to)) {
      return Promise.resolve(usage());
    }
    // His zones must cover it first: a past zone can't be added once memory has units of its days (SCHEMA.md).
    if (v.from < firstZoneDay()) {
      console.error(
        `record his zones from ${v.from} first (memory/zones.jsonl starts on ${firstZoneDay()})`
      );
      return Promise.resolve(1);
    }
    // The ticks read it, a week each, when no night is due (nightly.ts); not while a week runs.
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
  closeness: step(async () => closeness(await readWithPeople())),
  /** `contact-people`: names the senders his Contacts know (the night does; this is its first build and a replay). */
  "contact-people": step(() => Promise.resolve(writeContactPeople())),
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
  day: (_values, [date = ""]) => printed(isDay(date) ? day(date) : null),
  /** `doubtful <n>`: draws the n claims he should check first into memory/statements.jsonl and prints them with their doubts. */
  doubtful: (_values, [n = ""]) =>
    Number(n) > 0
      ? locked(() => drawDoubtful(Number(n))).then((drawn) =>
          drawn ? json(Promise.resolve(drawn)) : 1
        )
      : usage(),
  episodes: step(async (v) => episodes(await gathered(v))),
  /** `exchange-counts`: counts every exchange of every year again (the night does; this is its first build and a replay). */
  "exchange-counts": step(async () =>
    writeExchangeCounts(
      await readWithPeople(new Date(0)),
      (await readPeople()).resolve
    )
  ),
  /**
   * `exchange-reads [--force]`: what the exchange reads would ask (calls and exchanges, before the night's cap), with no
   * model; `--force` asks the night's share, as the night does once his `exchangeReads` setting is on.
   */
  "exchange-reads": step(async (v) => {
    const pending = readExchangeReadWork(
      await readWithPeople(new Date(0)),
      await readPeople(),
      clock()
    );
    if (!pending) {
      return { failed: 1 };
    }
    return v.force ? exchangeReads(pending) : { ...pending.counts, failed: 0 };
  }),
  extract: step(async (v) => extract(await gathered(v))),
  fetch: (values, [id]) =>
    printed(
      id ? fetchOf(id, count(values["from-turn"]), count(values.limit)) : null
    ),
  /**
   * `histories [--from YYYY-MM] [--force]`: what the histories would read (people, months, calls and a token ceiling),
   * with no model; `--force` reads it, as the night does once his `history` setting is on.
   */
  histories: step(async (v) => {
    const from = v.from ?? settings().history?.from;
    if (!from) {
      throw new Error("histories needs --from YYYY-MM, or his history setting");
    }
    const pending = await readHistoryWork(
      await readWithPeople(new Date(0)),
      await readPeople(),
      { from, today: dayNow() }
    );
    if (!pending) {
      return { failed: 1 };
    }
    return v.force ? histories(pending) : { ...pending.counts, failed: 0 };
  }),
  async index() {
    await reindex();
    return 0;
  },
  /**
   * `links [<person>] [--force]`: what the links step would judge (people, open things, calls, a token ceiling), with
   * no model; with a person, their open things and the ending found for each; `--force` judges, as the night does
   * once his `links` setting is on.
   */
  async links(values, rest) {
    const people = await readPeople();
    const name = words(rest);
    if (name) {
      const { known } = meant(name, people);
      const lines = known
        ? await readEndings(people, `person:${known}`)
        : [`no one is ${name}`];
      return printed(lines.join("\n") || "(nothing open with them)");
    }
    return step(async () => {
      const pending = await readLinkWork(people);
      if (!pending) {
        return { failed: 1 };
      }
      return values.force
        ? links(pending, people)
        : { ...pending.counts, failed: 0 };
    })(values, rest);
  },
  nightly: (values) => nightly(Number(values.days ?? DAYS), values.force),
  pages: step((v) => pages({ only: v.only, rebuild: v.rebuild })),
  passages: step((v) => rebuildPassages(v)),
  person: (values, rest) => printed(person(words(rest) || undefined, values)),
  personas: step(async () => personas(await readWithPeople())),
  places: (v) =>
    printed(
      placesOf({
        ...v,
        latitude: count(v.latitude),
        longitude: count(v.longitude),
        radiusM: count(v.radius),
      })
    ),
  /** `rate <ref> <answer> [note]`: appends his answer to a fact check, with his why (memory/ratings.jsonl). */
  async rate(_values, [ref = "", answer = "", ...note]) {
    const said = Rating.shape.answer.safeParse(answer);
    if (!(ref && said.success && said.data)) {
      return usage();
    }
    try {
      await recordRating(ref, said.data, words(note) || undefined);
      console.log(`recorded ${said.data} for ${ref} in memory/ratings.jsonl`);
      return 0;
    } catch (e) {
      console.error((e as Error).message);
      return 1;
    }
  },
  /** `recorded-days`: asks lifelog again which days the pendant recorded (the night does; this is its first build and a replay). */
  "recorded-days": step(writeRecordedDays),
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
  situations: step(() => situations()),
  status: () => json(lifeStatus()),
  topics: (values, rest) =>
    printed(topicsOf(words(rest) || undefined, values.person)),
  units: step((v) => collectHistorical(v)),
  async unresolved() {
    console.log(await unresolved());
    return 0;
  },
};

function usage() {
  console.error(
    "usage: bun life memory episodes [--days 7] | extract [--days 7] | appointments | units [--from d --to d] | passages [--from d --to d] | backfill --from d --to d | closeness | contact-people | exchange-counts | exchange-reads [--force] | recorded-days | histories [--from YYYY-MM] [--force] | links [<person>] [--force] | personas | pages [--only <id>] [--rebuild] | nightly [--force] | repos [project|area|repo] [--scan] | index | correct '<json>' | doubtful <n> | rate <obs_ or ep_ id> true|false|partly|outdated|skip [why] | search <words> [--from d] [--to d] | fetch <id> [--from-turn n] [--limit n] | day <YYYY-MM-DD> | person [name] [--before d] | places --at <instant|date> | --place <name> | --latitude n --longitude n [--radius m] [--from d] [--to d] | area <id> | chats --who <name|handle> | --chat <id> [--from d] [--to d] [--before instant] | topics [tag] [--person <id>] | unresolved | status | runs [--steps a,b] [--cursor c] [--limit n] | changes [--types a,b] [--about ref] [--run r] [--since iso] [--cursor c] [--limit n] | claim <obs_id>"
  );
  return Promise.resolve(2);
}

export function memoryCommand(args: string[]): Promise<number> {
  const { positionals, values } = parse(args);
  const [name = "", ...rest] = positionals;
  const handler = HANDLERS[name];
  return handler ? handler(values, rest) : usage();
}
