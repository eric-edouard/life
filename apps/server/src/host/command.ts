import { parseArgs } from "node:util";
import { addOnOf } from "../core/add-ons";
import { clock, daysBefore } from "../core/clock";
import { answerCheck } from "../memory/answer-check";
import { appointments } from "../memory/appointments";
import { changeFeed, readObservation } from "../memory/changes";
import { checksText } from "../memory/checks";
import { closeness, readWithPeople } from "../memory/closeness";
import { communicationStyles } from "../memory/communication-styles";
import { writeContactPeople } from "../memory/contact-people";
import {
  conversationSummaries,
  NIGHT_CALLS,
  readConversationSummaryWork,
} from "../memory/conversation-summaries";
import { episodes } from "../memory/episodes";
import { writeExchangeCounts } from "../memory/exchange-counts";
import { exchangeReads, readExchangeReadWork } from "../memory/exchange-reads";
import { extract } from "../memory/extract";
import { collectHistorical } from "../memory/historical-collection";
import { reindex } from "../memory/index-writer";
import { links, readEndings, readLinkWork } from "../memory/links";
import { dueDirectionsOf, matterDirections } from "../memory/matter-directions";
import {
  callsOf,
  matterLines,
  matters,
  readMatterBook,
  readMatterRecords,
  readMatterWork,
} from "../memory/matters";
import { recordCorrection } from "../memory/memory-files";
import { locked } from "../memory/memory-lock";
import { readMentions } from "../memory/mentions";
import { openById } from "../memory/open-by-id";
import { pages } from "../memory/pages";
import { rebuildPassages } from "../memory/passage-rebuild";
import { placesOf } from "../memory/places";
import { area, topicsOf } from "../memory/read-area-page";
import { day } from "../memory/read-day";
import { writeRecordedDays } from "../memory/recorded-days";
import { mapRepos, reposOf } from "../memory/repos";
import { runs } from "../memory/run-log";
import { weekFrom } from "../memory/schedule";
import { search } from "../memory/search";
import { situations } from "../memory/situations";
import { readSourceUse, sourceUseText } from "../memory/source-use";
import { tiesNow } from "../memory/ties";
import { DAYS, gather } from "../memory/units";
import {
  readVoiceNamingWork,
  VOICE_NAMING_CALLS,
  voiceNaming,
} from "../memory/voice-naming";
import { placementOf, readPeople } from "../memory/who";
import { chatsOf } from "../memory/words";
import { dayNow, isDay, lastDays, type Window } from "../memory/zones";
import { histories, readHistoryWork } from "../personal/histories";
import { readPerson } from "../personal/person-parts";
import { personaReadingsOf, personas } from "../personal/personas";
import { inboxNow, openCheckOf } from "./inbox";
import { nightly } from "./nightly";
import { lifeStatus } from "./status/life";

// The memory command line: parses the arguments and calls the steps.

const OPTIONS = {
  about: { type: "string" },
  again: { type: "boolean" },
  all: { type: "boolean" },
  at: { type: "string" },
  before: { type: "string" },
  chat: { type: "string" },
  cursor: { type: "string" },
  days: { type: "string" },
  force: { type: "boolean" },
  from: { type: "string" },
  "from-turn": { type: "string" },
  json: { type: "boolean" },
  latitude: { type: "string" },
  limit: { type: "string" },
  longitude: { type: "string" },
  only: { type: "string" },
  part: { type: "string" },
  person: { type: "string" },
  place: { type: "string" },
  radius: { type: "string" },
  rebuild: { type: "boolean" },
  run: { type: "string" },
  scan: { type: "boolean" },
  since: { type: "string" },
  span: { type: "string" },
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

/**
 * A hand-run step's evidence: `--from` to `--to` (one day when `--to` is left out), else its last `--days` days,
 * gathered once for it (a processing run gathers once for all its steps).
 */
const gathered = async (v: Values) => {
  const to = v.to ?? v.from;
  if ((v.from || v.to) && !(v.from && isDay(v.from) && to && isDay(to))) {
    throw new Error("--from is a day (YYYY-MM-DD), and --to one only with it");
  }
  return gather(
    v.from && to
      ? { from: v.from, to }
      : lastDays(clock(), Number(v.days ?? DAYS)),
    await readPeople()
  );
};

const scan = step(() => mapRepos());

/** The weeks from `since` to `today`, oldest first (`weekFrom`). */
function weeksFrom(since: string, today: string) {
  const weeks: Window[] = [];
  for (let from = since; from <= today; from = daysBefore(from, -7)) {
    weeks.push(weekFrom(from, today));
  }
  return weeks;
}

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
  /** `answer-check <ref> <option> [note] [--person person:<id>]`: his answer to an open check (`answerCheck`), through its kind's writer. */
  "answer-check": (values, [ref = "", option = "", ...note]) =>
    ref && option
      ? json(
          openCheckOf(ref)
            .then((check) =>
              answerCheck(
                check,
                {
                  note: words(note) || undefined,
                  options: [option],
                  person: values.person,
                },
                "session"
              )
            )
            .then(({ done, ref: answered }) => ({ done, ref: answered }))
        )
      : usage(),
  appointments: step(() => appointments()),
  area: (_values, rest) => printed(rest.length > 0 ? area(words(rest)) : null),
  changes: (v) =>
    json(
      changeFeed({
        ...v,
        limit: count(v.limit),
        types: list(v.types),
      })
    ),
  chats: (values) => printed(chatsOf(values)),
  /** `checks`: everything Life would like him to verify (`inboxNow`), counted by kind and by what rides on it, then every row. Read-only. */
  async checks() {
    console.log(checksText(await inboxNow()));
    return 0;
  },
  closeness: step(async () => closeness(await readWithPeople())),
  "communication-styles": step(async () =>
    communicationStyles(await readWithPeople(new Date(0)))
  ),
  /** `contact-people`: names the senders his Contacts know (the night does; this is its first build and a replay). */
  "contact-people": step(() => Promise.resolve(writeContactPeople())),
  /**
   * `conversation-summaries [--from day] [--force]`: what the conversation summaries would write (conversations and
   * parts with none, in the night's window, or from `--from`), with no model; `--force` writes them, as the night does:
   * the night's share, or with `--from` all of them.
   */
  "conversation-summaries": step(async (v) => {
    const found = await readConversationSummaryWork(
      clock(),
      await readPeople(),
      { from: v.from }
    );
    return v.force
      ? conversationSummaries(
          found,
          v.from ? Number.POSITIVE_INFINITY : NIGHT_CALLS
        )
      : { ...found.counts, failed: 0 };
  }),
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
  episodes: step(async (v) => episodes(await gathered(v))),
  /** `exchange-counts`: counts every exchange of every year again (the night does; this is its first build and a replay). */
  "exchange-counts": step(async () =>
    writeExchangeCounts(
      await readWithPeople(new Date(0)),
      (await readPeople()).resolve
    )
  ),
  /**
   * `exchange-reads [--days n] [--force]`: what the exchange reads that are on would ask of the exchanges finished in the
   * last `n` days (the night's window by default), counted with no model; `--force` asks them, as the night does.
   */
  "exchange-reads": step(async (v) => {
    const now = clock();
    const pending = readExchangeReadWork(
      await readWithPeople(new Date(0)),
      await readPeople(),
      now,
      lastDays(now, Number(v.days ?? DAYS)).from
    );
    if (!pending) {
      return { failed: 1 };
    }
    return v.force
      ? exchangeReads(pending)
      : {
          calls: pending.length,
          exchanges: pending.reduce((n, p) => n + p.call.starts.length, 0),
          failed: 0,
        };
  }),
  extract: step(async (v) => extract(await gathered(v))),
  fetch: (values, [id]) =>
    printed(
      id
        ? openById(
            id,
            count(values["from-turn"]),
            count(values.limit),
            readPerson
          )
        : null
    ),
  "historical-units": step((v) => collectHistorical(v)),
  /**
   * `histories [--from YYYY-MM] [--force]`: what the histories would read (people, months, calls and a token ceiling),
   * with no model; `--force` reads it, as the night does once the `histories` add-on is on.
   */
  histories: step(async (v) => {
    const from = v.from ?? addOnOf("histories")?.from;
    if (!from) {
      throw new Error(
        "histories needs --from YYYY-MM, or the `histories` add-on"
      );
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
   * `links [<matter id>] [--force]`: what the links step would judge (matters, open steps, calls, a token ceiling), with
   * no model; with a matter, its open steps and the ending found for each; `--force` judges, as the night does.
   */
  async links(values, rest) {
    const people = await readPeople();
    const id = words(rest);
    if (id) {
      const lines = await readEndings(people, id);
      return printed(lines.join("\n") || "(no such matter, or nothing open)");
    }
    return step(async () => {
      const pending = await readLinkWork(people);
      return values.force ? links(pending) : { ...pending.counts, failed: 0 };
    })(values, rest);
  },
  /**
   * `matter-directions [--force] [--all]`: how many running matters are due a direction tonight, with no model;
   * `--force` drafts them as the night does, `--all` every due one past the night's size (the first fill).
   */
  "matter-directions": step(async (values) => {
    const people = await readPeople();
    return values.force
      ? await matterDirections(people, { all: values.all })
      : {
          due: dueDirectionsOf(await readMatterBook(people, dayNow())).length,
          failed: 0,
        };
  }),
  /**
   * `matters [list] [--force] [--since YYYY-MM-DD]`: what the matters step would place in the night's days (calls,
   * episodes, to-do items), with no model; `--force` places it, as the night does;
   * `--since` places every week from that day to today, in order (each week sees the matters of the weeks before);
   * `list` prints each matter.
   */
  matters(values, rest) {
    if (rest[0] === "list") {
      return printed(matterLines().join("\n") || "(no matters)");
    }
    const today = dayNow();
    if (values.since !== undefined && !isDay(values.since)) {
      return usage();
    }
    const spans = values.since
      ? weeksFrom(values.since, today)
      : [lastDays(clock(), DAYS)];
    return step(async () => {
      const people = await readPeople();
      const records = await readMatterRecords(people);
      const sum = {
        calls: 0,
        episodes: 0,
        failed: 0,
        placed: 0,
        refusedSteps: 0,
        todoItems: 0,
      };
      for (const span of spans) {
        // biome-ignore lint/performance/noAwaitInLoops: a week sees the matters of the weeks before
        const work = await readMatterWork(span, people, [], records);
        if (!work) {
          return { failed: 1 };
        }
        sum.episodes += work.episodes.length;
        sum.todoItems += work.todoItems.length;
        if (values.force || values.since) {
          const run = await matters(work, people, records);
          sum.calls += run.calls;
          sum.failed += run.failed;
          sum.placed += run.placed;
          sum.refusedSteps += run.refusedSteps;
        } else {
          sum.calls += callsOf(work).length;
        }
      }
      return sum;
    })(values, rest);
  },
  /** `mentions`: the kept mentions (the night's) counted by how they are placed, as of today. Counts only, never a word. */
  mentions: async () => {
    const kept = readMentions();
    if (!kept) {
      console.error("no mentions kept yet: the night keeps them");
      return 1;
    }
    const people = await readPeople();
    const ties = tiesNow(people);
    const all = Object.values(kept).flat();
    const byProof: Record<string, number> = {};
    for (const m of all) {
      const proof = placementOf(m, people, ties)?.proof ?? "unknown";
      byProof[proof] = (byProof[proof] ?? 0) + 1;
    }
    console.log(
      JSON.stringify({
        byProof,
        days: Object.keys(kept).length,
        mentions: all.length,
      })
    );
    return 0;
  },
  nightly: (values) => nightly(Number(values.days ?? DAYS), values.force),
  observation: (_values, [id = ""]) => json(readObservation(id)),
  pages: step((v) => pages({ only: v.only, rebuild: v.rebuild })),
  passages: step((v) => rebuildPassages(v)),
  person: (values, rest) =>
    printed(readPerson(words(rest) || undefined, values)),
  personas: step(async () => personas(await readWithPeople(new Date(0)))),
  places: (v) =>
    printed(
      placesOf({
        ...v,
        latitude: count(v.latitude),
        longitude: count(v.longitude),
        radiusM: count(v.radius),
      })
    ),
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
  situations: step(() => situations(personaReadingsOf)),
  /** `source-use [--days 7] [--json]`: what each source costs a day (items, units, readers, reads per unit, tokens, dollars). */
  "source-use": (v) => {
    const days = count(v.days) ?? 7;
    return v.json
      ? json(readSourceUse(days))
      : printed(readSourceUse(days).then((u) => sourceUseText(u, days)));
  },
  status: () => json(lifeStatus()),
  topics: (values, rest) =>
    printed(topicsOf(words(rest) || undefined, values.person)),
  /**
   * `voice-naming [--from day] [--force] [--again]`: how many parts of the conversations the summaries examine have voices to name
   * and how many calls are due, with no model; `--force` makes them as the night does once his `voiceNaming` setting is
   * on: the night's share, or with `--from` all of them; `--again` asks parts again even when a reply is stored. Needs a Lifelog Host with `GET /speakers/voices`.
   */
  "voice-naming": step(async (v) => {
    const work = await readVoiceNamingWork(
      await readConversationSummaryWork(clock(), await readPeople(), {
        from: v.from,
      }),
      await readPeople(),
      undefined,
      undefined,
      { again: v.again }
    );
    return v.force
      ? voiceNaming(
          work,
          v.from ? Number.POSITIVE_INFINITY : VOICE_NAMING_CALLS
        )
      : { ...work.counts, failed: 0 };
  }),
};

function usage() {
  console.error(
    "usage: bun life memory episodes [--days 7 | --from d [--to d]] | extract [--days 7 | --from d [--to d]] | appointments | historical-units [--from d --to d] | passages [--from d --to d] | closeness | communication-styles | contact-people | exchange-counts | exchange-reads [--days 7] [--force] | conversation-summaries [--from d] [--force] | voice-naming [--from d] [--force] [--again] | mentions | recorded-days | histories [--from YYYY-MM] [--force] | links [<matter id>] [--force] | matters [list] [--force] [--since YYYY-MM-DD] | matter-directions [--force] [--all] | personas | pages [--only <id>] [--rebuild] | nightly [--force] | repos [project|area|repo] [--scan] | index | correct '<json>' | answer-check <ref> <option> [why] [--person person:<id>] | search <words> [--from d] [--to d] | fetch <id> [--from-turn n] [--limit n] | day <YYYY-MM-DD> | person [name] [--before d] [--part now|page|persona|story|year|month|evidence|conversation] [--span YYYY[-MM]] | places --at <instant|date> | --place <name> | --latitude n --longitude n [--radius m] [--from d] [--to d] | area <id> | chats --who <name|handle> | --chat <id> [--from d] [--to d] [--before instant] | topics [tag] [--person <id>] | checks | status | runs [--steps a,b] [--cursor c] [--limit n] | source-use [--days 7] [--json] | changes [--types a,b] [--about ref] [--run r] [--since iso] [--cursor c] [--limit n] | observation <obs_id>"
  );
  return Promise.resolve(2);
}

export function memoryCommand(args: string[]): Promise<number> {
  const { positionals, values } = parse(args);
  const [name = "", ...rest] = positionals;
  const handler = HANDLERS[name];
  return handler ? handler(values, rest) : usage();
}
