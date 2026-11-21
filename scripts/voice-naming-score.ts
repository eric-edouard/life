// `bun scripts/voice-naming-score.ts` scores the stored voice guesses (`voice_naming`, `memory/voice-guesses.ts`) against
// the voices he answered; `bun scripts/voice-naming-score.ts --hidden --trial <folder> [--from YYYY-MM-DD] [--run]` asks the naming
// again with his answered voices shown as unnamed, into a trial folder outside his data, and scores that (docs/operations.md,
// "Measuring"). Counts only: no name and no line of text is printed. Without `--run` the hidden mode asks nothing: it
// prints how many parts and voices it would ask.

import { mkdirSync, realpathSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { clock } from "@life/server/src/core/clock";
import { OWNER_DATA_DIR, real } from "@life/server/src/core/paths";
import { pathInside } from "@life/server/src/core/platform";
import { readConversationSummaryWork } from "@life/server/src/memory/conversation-summaries";
import { READ_REPLIES } from "@life/server/src/memory/memory-files";
import { READS, readReplies } from "@life/server/src/memory/read-replies";
import { begin, chunks } from "@life/server/src/memory/run";
import { spareQuota } from "@life/server/src/memory/schedule";
import { turnRefOf } from "@life/server/src/memory/units";
import {
  voiceGuessedPeopleOf,
  voiceGuessesOf,
} from "@life/server/src/memory/voice-guesses";
import {
  readVoiceNamingWork,
  voiceNaming,
} from "@life/server/src/memory/voice-naming";
import { readPeople, voicePersonOf } from "@life/server/src/memory/who";
import { transcripts } from "@life/server/src/memory/words";
import { llmFor } from "@life/server/src/models/llm";
import { isPromptVersion } from "@life/server/src/models/prompt-parts";
import type { ReadReply } from "@life/server/src/records/read-reply";
import {
  openStore,
  parseTurnRef,
  withStore,
} from "@life/server/src/sources/lifelog";
import {
  isTurnNamed,
  ownAnswerOf,
  readVoices,
  speakerTurns,
  type VoiceRow,
  voiceKey,
  voiceNamesOf,
} from "@life/server/src/sources/lifelog-voices";

/** One guess on one voice, with what is known of the voice now. `answer`: his person ref, `not_relevant`, `unknown` ("A stranger"), or null when he did not answer the whole voice. */
export interface Guessed {
  answer: string | null;
  /** Why an answered voice is left out: lifelog says its sound mixes people, or he answered it turn by turn (no answer on the voice, each turn named). */
  apart?: "mixed" | "turn";
  at: string;
  confidence: "sure" | "likely" | "weak";
  /** The unnamed turn keys it was made for (`unnamedTurnKey`): a card reads the newest guess of each (`voiceGuessedPeopleOf`). */
  keys: string[];
  /** Whether lifelog had a likeness to offer for it. */
  likeness: boolean;
  /** The stored line (one part of a conversation) it was read from. */
  part: number;
  person: string;
  /** The person lifelog named it as by sound (`basis: recognized`), for the doubted names. */
  recognized: string | null;
  voice: string;
  /** The words of its turns in the part. */
  words: number;
}

const LEVELS = ["sure", "likely"] as const;
/** Right in 100 a card's level must hold on his answers (the design of 21 Nov 2026, section 4): likely asks "Is this X?", sure starts "Yes" ticked. */
export const BARS = { likely: 85, sure: 97 } as const;
/** The answers that name no one, scored apart. */
const NO_ONE = new Set(["not_relevant", "unknown"]);
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
 * By group, as a voice card would ask (who.ts `voiceSuggestionOf`): his answered voices of one part with the same answer,
 * a person or no one, as one card; the name it shows is the one person the card's own reading of their turns names
 * (`voiceGuessedPeopleOf`, over the newest guess of each turn: none when two disagree). Lifelog's own name for a voice since
 * answered is not known.
 */
function byGroupOf(kept: Guessed[]) {
  const newest = new Map<string, Guessed>();
  for (const g of kept) {
    for (const k of g.keys) {
      if ((newest.get(k)?.at ?? "") <= g.at) {
        newest.set(k, g);
      }
    }
  }
  const guessedFor = voiceGuessedPeopleOf(newest.values());
  const sureFor = voiceGuessedPeopleOf(
    [...newest.values()].filter((g) => g.confidence === "sure")
  );
  // Each voice in the part of its newest guess.
  const groups = [
    ...Map.groupBy(
      newestPerVoice(kept.filter((g) => g.answer)),
      (g) => `${g.part} ${g.answer}`
    ).values(),
  ];
  const shown = groups.flatMap((list) => {
    const voices = list.map((g) => g.voice);
    const [person, ...more] = guessedFor(voices);
    return person && more.length === 0
      ? [
          {
            answer: list[0]?.answer,
            // As the card: a sure guess of that person on its voices starts "Yes" ticked (`isSuggestionBackedOf`).
            level: sureFor(voices).includes(person)
              ? ("sure" as const)
              : ("likely" as const),
            person,
          },
        ]
      : [];
  });
  const at = (level: (typeof LEVELS)[number]) => {
    const list = shown.filter((s) => s.level === level);
    return {
      n: list.length,
      right: list.filter((s) => s.person === s.answer).length,
    };
  };
  return {
    groups: groups.length,
    likely: at("likely"),
    right: shown.filter((s) => s.person === s.answer).length,
    shown: shown.length,
    sure: at("sure"),
  };
}

/**
 * The score, counts only. Over answered voices (a person, whole voice, not mixed, not turn by turn): wrong per 100 at
 * sure and at likely, by voice (each counted once, by its newest guess) and by guess. `me` guesses, voices with no
 * likeness, guesses on voices answered `not_relevant`, the strangers' ("A stranger": how many were guessed a person or me), the talking words named right, and the doubted names are apart.
 */
export function scoreOf(all: Guessed[]) {
  const [left, kept] = [
    all.filter((g) => g.apart),
    all.filter((g) => !g.apart),
  ];
  const persons = kept.filter((g) => g.answer && !NO_ONE.has(g.answer));
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
  const strangers = newestPerVoice(kept.filter((g) => g.answer === "unknown"));
  const guessedAs = (c: (typeof LEVELS)[number]) =>
    strangers.filter((g) => g.person !== "unknown" && g.confidence === c)
      .length;
  return {
    byGroup: byGroupOf(kept),
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
    strangers: {
      likely: guessedAs("likely"),
      sure: guessedAs("sure"),
      voices: strangers.length,
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
    `by group: ${s.byGroup.groups} answered groups, a name shown on ${s.byGroup.shown}, his answer on ${s.byGroup.right}`,
    ...LEVELS.map((c) => {
      const { n, right } = s.byGroup[c];
      const per = n === 0 ? null : Math.round((right / n) * 100);
      const holds = per === null ? "-" : per >= BARS[c] ? "holds" : "under";
      return `by group ${c}: ${right} right of ${n} (${per ?? "-"} in 100), bar ${BARS[c]}: ${holds}`;
    }),
    ...at("no likeness, by voice", s.noLikeness),
    `me guesses (sure or likely, all wrong on a person he answered): ${s.meGuesses}`,
    `talking words named right: ${s.words.right} of ${s.words.all}`,
    `voices answered not relevant: ${s.notRelevant.voices}, guessed as a person: ${s.notRelevant.guessed}`,
    `voices answered "A stranger": ${s.strangers.voices}, guessed as a person or me at sure: ${s.strangers.sure}, at likely: ${s.strangers.likely}`,
    `doubted names: ${s.doubted.asked}, named again as the same person: ${s.doubted.sameAsLifelog}`,
    `left out: ${s.leftOut.mixed} mixed, ${s.leftOut.turnByTurn} answered turn by turn`,
  ];
}

const inside = (path: string, dir: string) => pathInside(dir, path) !== null;

const SEGMENTS = /[\\/]/;

/**
 * The trial folder, made and checked: never inside his data (it holds replies, and nothing of his is written but by Life).
 * A path with a `..` is refused before anything is resolved (after a link the OS would follow it elsewhere); the folder is
 * made only when its path, as written, is outside his real data; then its real path, links followed, is checked again and,
 * when it is inside, only what this run just made is removed. Returns the real folder.
 */
export function prepareTrial(folder: string, data = OWNER_DATA_DIR) {
  if (folder.split(SEGMENTS).includes("..")) {
    throw new Error("the trial folder has a `..` in its path");
  }
  const refused = new Error(
    "the trial folder must be outside his data (the replies it keeps are not memory)"
  );
  if (inside(resolve(folder), real(data))) {
    throw refused;
  }
  const made = mkdirSync(resolve(folder), { recursive: true });
  const found = realpathSync(resolve(folder));
  if (inside(found, real(data))) {
    if (made) {
      rmSync(made, { force: true, recursive: true });
    }
    throw refused;
  }
  return found;
}

/** Said last in every score: what the numbers cannot account for. */
export const LIMITS =
  "limits: answers in other conversations still feed who could be there; an answer's date is not known, so 'answered since' means 'answered now'";

const WORD = /\S+/g;

/**
 * Each stored guess of `lines` with what lifelog says of its voice now (`GET /speakers/voices` over the line's span, one
 * read a line). He answered a voice after a guess when it is his answer now: a guess is made only for a voice no one had
 * answered, so an answer there is since (lifelog gives no date). A failed read throws.
 */
async function gather(lines: ReadReply[]) {
  const people = await readPeople();
  let parts = 0;
  const per = [] as {
    g: ReturnType<typeof voiceGuessesOf>[number];
    part: number;
    row?: VoiceRow;
  }[];
  for (const group of chunks(lines, 8)) {
    // biome-ignore lint/performance/noAwaitInLoops: a few lines' voices at a time
    const rows = await Promise.all(
      group.map((line) => {
        const ats = line.messages.map((k) =>
          Date.parse(turnRefOf(k).split("@")[1] ?? "")
        );
        return readVoices(
          new Date(Math.min(...ats)),
          new Date(Math.max(...ats) + 1)
        );
      })
    );
    for (const [i, line] of group.entries()) {
      parts += 1;
      const byVoice = new Map(
        (rows[i] ?? []).map((r) => [voiceKey(r.jobId, r.speakerLabel), r])
      );
      for (const g of voiceGuessesOf(line)) {
        per.push({ g, part: parts, row: byVoice.get(g.voice) });
      }
    }
  }
  const { names, store } = await withStore(
    (s) => ({
      names: voiceNamesOf(speakerTurns(s, new Date(0))),
      store: new Set(
        per.flatMap(({ g, row }) =>
          row?.basis !== "owner" &&
          row?.basis !== "recognized" &&
          g.keys.some((k) => isTurnNamed(s, turnRefOf(k)))
            ? [g.voice]
            : []
        )
      ),
    }),
    openStore
  );
  const person = (id: string | null) =>
    voicePersonOf(people.resolve, id, id ? names.get(id) : null);
  const recognizedOf = (row?: VoiceRow) => {
    const ref = row?.basis === "recognized" ? person(row.personId) : null;
    return ref ? people.refOf(ref) : null;
  };
  const unplaced = new Set<string>();
  const answerOf = (row?: VoiceRow) => {
    const own = ownAnswerOf(row);
    if (own?.kind === "person") {
      return person(own.personId);
    }
    return own?.kind === "not_relevant" || own?.kind === "unknown"
      ? own.kind
      : null;
  };
  const jobs = [
    ...new Set(
      per.flatMap(({ g, row }) =>
        answerOf(row)
          ? g.keys.map((k) => parseTurnRef(turnRefOf(k))?.jobId ?? "")
          : []
      )
    ),
  ];
  const words = await transcripts(jobs.map((jobId) => ({ jobId })));
  const guessed = per.map(({ g, part, row }) => {
    const answer = answerOf(row);
    if (!answer && ownAnswerOf(row)?.kind === "person") {
      unplaced.add(g.voice);
    }
    let apart: Guessed["apart"];
    if (row?.mixed) {
      apart = "mixed";
    } else if (store.has(g.voice)) {
      apart = "turn";
    }
    return {
      answer: answer && !NO_ONE.has(answer) ? people.refOf(answer) : answer,
      ...(apart ? { apart } : {}),
      at: g.at,
      confidence: g.confidence,
      keys: g.keys,
      likeness: (row?.likeness.length ?? 0) > 0,
      part,
      person:
        g.person === "me" || g.person === "unknown"
          ? g.person
          : people.refOf(g.person),
      recognized: recognizedOf(row),
      voice: g.voice,
      words: g.keys.reduce((n, k) => {
        const t = parseTurnRef(turnRefOf(k));
        return (
          n +
          ((t && words.get(t.jobId)?.[t.turnIndex]?.text.match(WORD)?.length) ||
            0)
        );
      }, 0),
    };
  });
  return { guessed, unplaced: unplaced.size };
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
    where = prepareTrial(values.trial);
    const people = await readPeople();
    const work = await readVoiceNamingWork(
      await readConversationSummaryWork(clock(), people, { from: values.from }),
      people,
      where,
      openStore,
      { hiding: true }
    );
    const voices = work.asked.reduce(
      (n, a) => n + (a.call.input as { voices: unknown[] }).voices.length,
      0
    );
    console.table([
      { calls: work.counts.calls, parts: work.counts.parts, voices },
    ]);
    if (values.run) {
      // The trial's own step name, apart from the night's in Life's run log, and the pilot's guard on the Codex reserve.
      await spareQuota(llmFor("main").engine);
      const step = await begin("voice-naming-trial", "main", {
        prompts: [READS.voice_naming.prompt],
      });
      console.table([
        await voiceNaming(work, Number.POSITIVE_INFINITY, where, step),
      ]);
    } else {
      process.exit(0);
    }
  }
  const lines = readReplies(where)
    .flat()
    .filter(
      (l) =>
        l.read === "voice_naming" &&
        isPromptVersion(l.madeBy.prompt, READS.voice_naming.prompt)
    );
  const { guessed, unplaced } = await gather(lines);
  console.log(
    [
      ...reportOf(scoreOf(guessed)),
      `answered voices whose lifelog person Life cannot place: ${unplaced}`,
      LIMITS,
    ].join("\n")
  );
}
