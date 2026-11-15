// `bun scripts/voice-naming-score.ts` scores the stored voice guesses (`voice_naming`, `memory/voice-guesses.ts`) against
// the voices he answered; `bun scripts/voice-naming-score.ts --hidden --trial <folder> [--from YYYY-MM-DD] [--run]` asks the naming
// again with his answered voices shown as unnamed, into a trial folder outside his data, and scores that (docs/operations.md,
// "Measuring"). Counts only: no name and no line of text is printed. Without `--run` the hidden mode asks nothing: it
// prints how many parts and voices it would ask.

import { isAbsolute, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { clock } from "@life/server/src/core/clock";
import { OWNER_DATA_DIR } from "@life/server/src/core/paths";
import { readConversationSummaryWork } from "@life/server/src/memory/conversation-summaries";
import { READ_REPLIES } from "@life/server/src/memory/memory-files";
import { READS, readReplies } from "@life/server/src/memory/read-replies";
import { chunks } from "@life/server/src/memory/run";
import { guessesOf } from "@life/server/src/memory/voice-guesses";
import {
  readVoiceNamingWork,
  voiceNaming,
} from "@life/server/src/memory/voice-naming";
import { readPeople } from "@life/server/src/memory/who";
import { transcripts } from "@life/server/src/memory/words";
import type { ReadReply } from "@life/server/src/records/read-reply";
import {
  openStore,
  parseTurnRef,
  withStore,
} from "@life/server/src/sources/lifelog";
import {
  isTurnNamed,
  readVoices,
  type VoiceRow,
  voiceKey,
} from "@life/server/src/sources/lifelog-voices";

/** One guess on one voice, with what is known of the voice now. `answer`: his person ref, `not_relevant`, or null when he did not answer the whole voice. */
export interface Guessed {
  answer: string | null;
  /** Why an answered voice is left out: lifelog says its sound mixes people, or he answered it turn by turn (no answer on the voice, each turn named). */
  apart?: "mixed" | "turn";
  at: string;
  confidence: "sure" | "likely" | "weak";
  /** Whether lifelog had a likeness to offer for it. */
  likeness: boolean;
  person: string;
  /** The person lifelog named it as by sound (`basis: recognized`), for the doubted names. */
  recognized: string | null;
  voice: string;
  /** The words of its turns in the part. */
  words: number;
}

const LEVELS = ["sure", "likely"] as const;
/** A guess that names someone: not `unknown`, not `me`, and sure or likely. */
const namesOther = (g: Guessed) =>
  g.person !== "unknown" &&
  g.person !== "me" &&
  (g.confidence === "sure" || g.confidence === "likely");
const per100 = (wrong: number, n: number) =>
  n === 0 ? null : Math.round((wrong / n) * 1000) / 10;
const rate = (list: Guessed[], wrongOf: (g: Guessed) => boolean) => {
  const wrong = list.filter(wrongOf).length;
  return { n: list.length, per100: per100(wrong, list.length), wrong };
};

/** The newest guess of each voice: a voice is counted once. */
const newestPerVoice = (list: Guessed[]) => [
  ...list
    .reduce((m, g) => {
      const had = m.get(g.voice);
      return had && had.at > g.at ? m : m.set(g.voice, g);
    }, new Map<string, Guessed>())
    .values(),
];

/**
 * The score, counts only. Over answered voices (a person, whole voice, not mixed, not turn by turn): wrong per 100 at
 * sure and at likely, by voice (each counted once, by its newest guess) and by guess. `me` guesses, voices with no
 * likeness, guesses on voices answered `not_relevant`, the talking words named right, and the doubted names are apart.
 */
export function scoreOf(all: Guessed[]) {
  const [left, kept] = [
    all.filter((g) => g.apart),
    all.filter((g) => !g.apart),
  ];
  const persons = kept.filter((g) => g.answer && g.answer !== "not_relevant");
  const wrong = (g: Guessed) => g.person !== g.answer;
  const byVoice = newestPerVoice(persons);
  const levels = (
    list: Guessed[],
    keep: (g: Guessed) => boolean = () => true
  ) =>
    Object.fromEntries(
      LEVELS.map((c) => [
        c,
        rate(
          list.filter((g) => namesOther(g) && g.confidence === c && keep(g)),
          wrong
        ),
      ])
    );
  const doubted = newestPerVoice(kept.filter((g) => g.recognized));
  return {
    byGuess: levels(persons),
    byVoice: levels(byVoice),
    doubted: {
      asked: doubted.length,
      sameAsLifelog: doubted.filter((g) => g.person === g.recognized).length,
    },
    leftOut: {
      mixed: newestPerVoice(left.filter((g) => g.apart === "mixed")).length,
      turnByTurn: newestPerVoice(left.filter((g) => g.apart === "turn")).length,
    },
    meGuesses: byVoice.filter(
      (g) => g.person === "me" && g.confidence !== "weak"
    ).length,
    noLikeness: levels(byVoice, (g) => !g.likeness),
    notRelevant: {
      guessed: newestPerVoice(
        kept.filter((g) => g.answer === "not_relevant")
      ).filter(namesOther).length,
      voices: newestPerVoice(kept.filter((g) => g.answer === "not_relevant"))
        .length,
    },
    voices: byVoice.length,
    words: {
      all: byVoice.reduce((n, g) => n + g.words, 0),
      right: byVoice
        .filter((g) => namesOther(g) && !wrong(g))
        .reduce((n, g) => n + g.words, 0),
    },
  };
}

/** The score as the lines it prints: numbers only. */
export function reportOf(s: ReturnType<typeof scoreOf>) {
  const row = (r: { n: number; per100: number | null; wrong: number }) =>
    `${r.wrong} wrong of ${r.n} (${r.per100 ?? "-"} per 100)`;
  const at = (name: string, by: typeof s.byVoice) =>
    LEVELS.map((c) => `${name} ${c}: ${row(by[c] as never)}`);
  return [
    `answered person voices: ${s.voices}`,
    ...at("by voice", s.byVoice),
    ...at("by guess", s.byGuess),
    ...at("no likeness, by voice", s.noLikeness),
    `me guesses (sure or likely, all wrong on a person he answered): ${s.meGuesses}`,
    `talking words named right: ${s.words.right} of ${s.words.all}`,
    `voices answered not relevant: ${s.notRelevant.voices}, guessed as a person: ${s.notRelevant.guessed}`,
    `doubted names: ${s.doubted.asked}, named again as the same person: ${s.doubted.sameAsLifelog}`,
    `left out: ${s.leftOut.mixed} mixed, ${s.leftOut.turnByTurn} answered turn by turn`,
  ];
}

/** Whether `folder` is inside his data: a trial never is (it holds replies, and nothing of his is written but by Life). */
export const isInsideData = (folder: string, data = OWNER_DATA_DIR) => {
  const rel = relative(data, resolve(folder));
  return !(rel.startsWith("..") || isAbsolute(rel));
};

const refOfKey = (key: string) => key.split(" ")[0] ?? "";
const WORD = /\S+/g;

/**
 * Each stored guess of `lines` with what lifelog says of its voice now (`GET /speakers/voices` over the line's span, one
 * read a line). He answered a voice after a guess when it is his answer now: a guess is made only for a voice no one had
 * answered, so an answer there is since (lifelog gives no date). A failed read throws.
 */
async function gather(lines: ReadReply[]) {
  const people = await readPeople();
  const per = [] as {
    g: ReturnType<typeof guessesOf>[number];
    row?: VoiceRow;
  }[];
  for (const group of chunks(lines, 8)) {
    // biome-ignore lint/performance/noAwaitInLoops: a few lines' voices at a time
    const rows = await Promise.all(
      group.map((line) => {
        const ats = line.messages.map((k) =>
          Date.parse(refOfKey(k).split("@")[1] ?? "")
        );
        return readVoices(
          new Date(Math.min(...ats)),
          new Date(Math.max(...ats) + 1)
        );
      })
    );
    for (const [i, line] of group.entries()) {
      const byVoice = new Map(
        (rows[i] ?? []).map((r) => [voiceKey(r.jobId, r.speakerLabel), r])
      );
      for (const g of guessesOf(line)) {
        per.push({ g, row: byVoice.get(g.voice) });
      }
    }
  }
  const person = (id: string | null) => (id ? people.resolve(id) : null);
  const recognizedOf = (row?: VoiceRow) => {
    const ref = row?.basis === "recognized" ? person(row.personId) : null;
    return ref ? people.refOf(ref) : null;
  };
  const answerOf = (row?: VoiceRow) => {
    if (row?.basis !== "owner") {
      return null;
    }
    return row.status === "not_relevant"
      ? "not_relevant"
      : person(row.personId);
  };
  const jobs = [
    ...new Set(
      per.flatMap(({ g, row }) =>
        answerOf(row)
          ? g.keys.map((k) => parseTurnRef(refOfKey(k))?.jobId ?? "")
          : []
      )
    ),
  ];
  const words = await transcripts(jobs.map((jobId) => ({ jobId })));
  const store = await withStore(
    (s) =>
      new Set(
        per.flatMap(({ g, row }) =>
          row?.basis !== "owner" &&
          row?.basis !== "recognized" &&
          g.keys.some((k) => isTurnNamed(s, refOfKey(k)))
            ? [g.voice]
            : []
        )
      ),
    openStore
  );
  return per.map(({ g, row }) => {
    const answer = answerOf(row);
    let apart: Guessed["apart"];
    if (row?.mixed) {
      apart = "mixed";
    } else if (store.has(g.voice)) {
      apart = "turn";
    }
    return {
      answer:
        answer && answer !== "not_relevant" ? people.refOf(answer) : answer,
      ...(apart ? { apart } : {}),
      at: g.at,
      confidence: g.confidence,
      likeness: (row?.likeness.length ?? 0) > 0,
      person:
        g.person === "me" || g.person === "unknown"
          ? g.person
          : people.refOf(g.person),
      recognized: recognizedOf(row),
      voice: g.voice,
      words: g.keys.reduce((n, k) => {
        const t = parseTurnRef(refOfKey(k));
        return (
          n +
          ((t && words.get(t.jobId)?.[t.turnIndex]?.text.match(WORD)?.length) ||
            0)
        );
      }, 0),
    };
  });
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      from: { type: "string" },
      hidden: { type: "boolean" },
      run: { type: "boolean" },
      trial: { type: "string" },
    },
  });
  let where = READ_REPLIES;
  if (values.hidden) {
    if (!values.trial) {
      throw new Error(
        "usage: bun scripts/voice-naming-score.ts [--hidden --trial <folder> [--from YYYY-MM-DD] [--run]]"
      );
    }
    if (isInsideData(values.trial)) {
      throw new Error(
        "the trial folder must be outside his data (the replies it keeps are not memory)"
      );
    }
    where = resolve(values.trial);
    const people = await readPeople();
    const work = await readVoiceNamingWork(
      await readConversationSummaryWork(clock(), people, { from: values.from }),
      people,
      where,
      openStore,
      undefined,
      true
    );
    const voices = work.asked.reduce(
      (n, a) => n + (a.call.input as { voices: unknown[] }).voices.length,
      0
    );
    console.table([
      { calls: work.counts.calls, parts: work.counts.parts, voices },
    ]);
    if (values.run) {
      console.table([await voiceNaming(work, Number.POSITIVE_INFINITY, where)]);
    } else {
      process.exit(0);
    }
  }
  const lines = readReplies(where)
    .flat()
    .filter(
      (l) =>
        l.read === "voice_naming" &&
        l.madeBy.prompt === READS.voice_naming.prompt
    );
  console.log(reportOf(scoreOf(await gather(lines))).join("\n"));
}
