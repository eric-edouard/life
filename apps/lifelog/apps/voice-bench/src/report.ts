// The bench's report: every model and blend scored on the sample, the cloud's positions, and the
// turns worth the owner's ear (the review). Pure: the sample, his bench answers and the embeddings in.
import { answers } from "@lifelog/server/scripts/eval-voices";
import { RECOGNITION } from "@lifelog/server/src/config";
import { centroid } from "@lifelog/server/src/speakers";
import { pcaOf } from "@lifelog/server/src/voice-pca";
import type { Vector } from "@lifelog/server/src/voice-vectors";
import type { Sample, SampledTurn } from "./archive";
import { lengthOf } from "./sample";
import {
  blendOf,
  type Call,
  callsOf,
  curveOf,
  equalErrorOf,
  type Heard,
  isKnown,
  isNamed,
  isRight,
  pointAt,
  sharesBy,
} from "./score";
import { type BenchAnswer, type Truth, truthOf } from "./truth";

export interface Embedded {
  dim: number;
  // `<model>@<revision>`: a new pin is another model.
  key: string;
  model: string;
  secondsPerClip: number;
  vectors: Map<string, Vector>;
}

// Wrong names allowed, of the names given. The winner is the first one (his rule of 10 Nov).
export const BUDGETS = [0.01, 0.03, 0.1] as const;
const [WINNER] = BUDGETS;
// A turn enters the review when this share of the models hear the same person first, and the
// review holds this many turns of each reason at most.
const REVIEW = { agree: 0.6, most: 250 };

const mean = (xs: number[]) =>
  xs.reduce((sum, x) => sum + x, 0) / (xs.length || 1);

const combinations = <T>(all: T[], size: number): T[][] =>
  size === 0
    ? [[]]
    : all.flatMap((first, i) =>
        combinations(all.slice(i + 1), size - 1).map((rest) => [first, ...rest])
      );

// A speaker's turns in one job, as one vector, when they hold enough speech and one truth.
function voicesOf(turns: Heard[], speakerOf: (id: string) => string) {
  return [
    ...Map.groupBy(turns, (t) => `${t.jobId}/${speakerOf(t.id)}`),
  ].flatMap(([id, inVoice]): Heard[] => {
    const [first] = inVoice;
    const seconds = inVoice.reduce((sum, t) => sum + t.seconds, 0);
    const truths = new Set(inVoice.map((t) => JSON.stringify(t.truth)));
    return first?.truth &&
      truths.size === 1 &&
      seconds >= RECOGNITION.minSpeakerSeconds
      ? [
          {
            ...first,
            id,
            seconds,
            vector: centroid(inVoice.map((t) => t.vector)),
          },
        ]
      : [];
  });
}

function summaryOf(calls: Call[]) {
  const known = calls.filter(isKnown);
  return {
    equalError: equalErrorOf(calls),
    // Known voices whose first guess is right, however unsure: no threshold, so his answers'
    // mistakes weigh little on it.
    firstRight: known.filter(isRight).length / (known.length || 1),
    points: BUDGETS.map((budget) => ({ budget, ...pointAt(calls, budget) })),
  };
}

const winnerOf = (summary: ReturnType<typeof summaryOf>) =>
  summary.points.find((p) => p.budget === WINNER) ?? pointAt([], WINNER);

// Best first by his rule; the first guess settles a tie.
const byWinner = (
  a: ReturnType<typeof summaryOf>,
  b: ReturnType<typeof summaryOf>
) =>
  winnerOf(b).namedRight - winnerOf(a).namedRight ||
  b.firstRight - a.firstRight;

function modelOf(
  embedded: Embedded,
  turns: (SampledTurn & { truth: Truth | undefined })[],
  conversationsOf: (personId: string) => number
) {
  const byId = new Map(turns.map((t) => [t.id, t]));
  const heard: Heard[] = turns.flatMap((t) => {
    const vector = embedded.vectors.get(t.id);
    return vector ? [{ ...t, seconds: t.durationSeconds, vector }] : [];
  });
  const calls = callsOf(heard, heard);
  const summary = summaryOf(calls);
  const at = winnerOf(summary);
  const turnOf = (c: Call) => byId.get(c.id);
  const personOf = (c: Call) =>
    c.truth?.kind === "person" ? c.truth.personId : undefined;
  const byPerson = sharesBy(calls, at, personOf);
  const centroids = [
    ...Map.groupBy(
      heard.filter((t) => t.truth?.kind === "person"),
      (t) => JSON.stringify(t.truth)
    ).values(),
  ].map((own) => centroid(own.map((t) => t.vector)));
  const vectors = heard.map((t) => t.vector);
  const positions = pcaOf(centroids.length >= 4 ? centroids : vectors, vectors);
  const callOf = new Map(calls.map((c) => [c.id, c]));
  // A call with no profile to compare has no score.
  const scores = calls.map((c) => c.score).filter(Number.isFinite);
  const middle = mean(scores);
  const deviation = Math.sqrt(mean(scores.map((x) => (x - middle) ** 2))) || 1;
  return {
    byEvidence: sharesBy(calls, at, (c) => {
      const person = personOf(c);
      if (!person) {
        return;
      }
      const n = conversationsOf(person);
      if (n >= 10) {
        return "10 or more conversations";
      }
      return n >= 3 ? "3 to 9 conversations" : "1 or 2 conversations";
    }),
    byLanguage: sharesBy(calls, at, (c) => turnOf(c)?.language),
    byLength: sharesBy(calls, at, (c) =>
      lengthOf(turnOf(c)?.durationSeconds ?? 0)
    ),
    byPerson,
    calls,
    curve: curveOf(calls),
    dim: embedded.dim,
    key: embedded.key,
    // Each person counts once, whatever they talk: he never dominates.
    macro: mean(byPerson.filter((p) => p.known >= 5).map((p) => p.namedRight)),
    model: embedded.model,
    secondsPerClip: embedded.secondsPerClip,
    ...summary,
    // Per turn of the sample, in its order: where it sits in the cloud and whom the model hears.
    turns: Object.fromEntries(
      heard.map((t, i) => {
        const call = callOf.get(t.id);
        return [
          t.id,
          {
            best: call?.best ?? null,
            isNamed: !!call && isNamed(call, at),
            margin: round(call?.margin ?? 0),
            position: (positions[i] ?? [0, 0, 0]).map(round),
            score: round(call?.best ? call.score : 0),
            // The score among this model's scores: how sure it is, on a scale models share.
            sureness: round(
              ((call?.best ? call.score : middle) - middle) / deviation
            ),
          },
        ];
      })
    ),
    voices: summaryOf(
      callsOf(
        voicesOf(heard, (id) => byId.get(id)?.speakerLabel ?? ""),
        heard
      )
    ),
  };
}

const round = (x: number) => Math.round(x * 1000) / 1000;

const REASONS = [
  "unknown-sounds-known",
  "named-sounds-other",
  "confirm",
] as const;

// Why a turn is worth his ear, when most models hear the same person first: a "nobody I know"
// they give to a known person, a named turn they give to someone else, or an unanswered turn
// (one tap to confirm).
function reasonOf(
  truth: Truth | undefined,
  personId: string
): (typeof REASONS)[number] | undefined {
  if (truth?.kind === "unknown") {
    return "unknown-sounds-known";
  }
  if (truth?.kind === "person") {
    return personId === truth.personId ? undefined : "named-sounds-other";
  }
  return "confirm";
}

// The review, the likely mistakes first (the order of REASONS), the surest of each first. What he
// answered in the bench is out.
function reviewOf(
  turns: { id: string; truth: Truth | undefined }[],
  models: ReturnType<typeof modelOf>[],
  answered: Map<string, BenchAnswer>
) {
  const needed = Math.ceil(models.length * REVIEW.agree);
  const items = turns
    .filter((t) => !answered.has(t.id) && t.truth?.kind !== "excluded")
    .flatMap((t) => {
      const firsts = models.flatMap((model) => {
        const heard = model.turns[t.id];
        return heard?.best ? [{ ...heard, best: heard.best }] : [];
      });
      const heard = [...Map.groupBy(firsts, (h) => h.best)]
        .map(([personId, votes]) => ({
          count: votes.length,
          personId,
          sureness: round(mean(votes.map((v) => v.sureness))),
        }))
        .sort((a, b) => b.count - a.count);
      const [top] = heard;
      const reason =
        top && top.count >= needed
          ? reasonOf(t.truth, top.personId)
          : undefined;
      return top && reason ? [{ heard, id: t.id, reason, top }] : [];
    })
    .sort(
      (a, b) => b.top.count - a.top.count || b.top.sureness - a.top.sureness
    );
  return REASONS.flatMap((reason) =>
    items
      .filter((item) => item.reason === reason)
      .slice(0, REVIEW.most)
      .map(({ top: _, ...item }) => item)
  );
}

export function reportOf(
  sample: Sample,
  answered: Map<string, BenchAnswer>,
  embeddings: Embedded[]
) {
  const answerOf = answers(sample);
  const turns = sample.turns.map((t) => ({
    ...t,
    truth: truthOf(answered.get(t.id), answerOf(t)),
  }));
  const conversations = new Map(
    [
      ...Map.groupBy(
        turns.flatMap((t) =>
          t.truth?.kind === "person"
            ? [{ conversationId: t.conversationId, id: t.truth.personId }]
            : []
        ),
        (t) => t.id
      ),
    ].map(([id, own]) => [id, new Set(own.map((t) => t.conversationId)).size])
  );
  const models = embeddings
    .map((e) => modelOf(e, turns, (id) => conversations.get(id) ?? 0))
    .sort(byWinner);
  // Every pair and every three of the models, as one.
  const blends = [2, 3]
    .flatMap((size) => combinations(models, size))
    .map((mixed) => {
      const [first, second] = mixed;
      const agreeing =
        mixed.length === 2 && first && second
          ? first.calls.filter(
              (c) => c.truth && second.turns[c.id]?.best === c.best
            ).length / (first.calls.filter((c) => c.truth).length || 1)
          : undefined;
      return {
        // Of the turns he answered, those two models give to the same person.
        agreeing,
        models: mixed.map((m) => m.key),
        ...summaryOf(blendOf(mixed.map((m) => m.calls))),
      };
    })
    .sort(byWinner);
  const known = turns.filter((t) => t.truth?.kind === "person").length;
  return {
    blends,
    counts: {
      answered: turns.filter((t) => t.truth).length,
      excluded: turns.filter((t) => t.truth?.kind === "excluded").length,
      known,
      turns: turns.length,
      unknown: turns.filter((t) => t.truth?.kind === "unknown").length,
    },
    models: models.map(({ calls: _, ...model }) => model),
    people: sample.people,
    review: reviewOf(turns, models, answered),
    turns: turns.map(({ audio: _, conversationId: __, ...t }) => t),
  };
}
export type Report = ReturnType<typeof reportOf>;

const percent = (x: number) => `${(x * 100).toFixed(1)}%`;

// The numbers alone, no name: what a research note may quote.
export function markdownOf(report: Report) {
  const row = (name: string, s: ReturnType<typeof summaryOf>, rest: string[]) =>
    `| ${[name, ...s.points.map((p) => percent(p.namedRight)), percent(s.firstRight), percent(s.equalError), ...rest].join(" | ")} |`;
  const head = `| Model | ${BUDGETS.map((b) => `Named right at ${percent(b)} wrong`).join(" | ")} | First guess right | Equal error | Whole voices at 1% | Each person once | s per clip | Turns heard |\n|---|---|---|---|---|---|---|---|---|---|`;
  return [
    "# Voice bench",
    "",
    `${report.counts.turns} turns: ${report.counts.known} of a known voice, ${report.counts.unknown} of nobody he knows, ${report.counts.excluded} left out (media, several voices), the rest unanswered.`,
    "",
    head,
    ...report.models.map((m) =>
      row(m.key, m, [
        percent(winnerOf(m.voices).namedRight),
        percent(m.macro),
        m.secondsPerClip.toFixed(3),
        // Fewer than the sample: a quick look, not to be ranked against a full run.
        Object.keys(m.turns).length < report.counts.turns
          ? `${Object.keys(m.turns).length} (quick look)`
          : "all",
      ])
    ),
    "",
    "## Blends",
    "",
    `| Models | ${BUDGETS.map((b) => `Named right at ${percent(b)} wrong`).join(" | ")} | First guess right | Equal error |\n|---|---|---|---|---|---|`,
    ...report.blends.slice(0, 12).map((b) => row(b.models.join(" + "), b, [])),
    "",
  ].join("\n");
}
