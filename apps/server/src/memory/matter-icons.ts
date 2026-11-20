import { type Embedder, embedBatches, similarityOf } from "../core/embedder";
import { log } from "../core/log";
import { MATTER_ICONS, type MatterIconKey } from "../records/matter-icon";
import { type MatterView, matterTextOf } from "./matter-read";
import { embedderNow } from "./vectors";

// Life's pick of a matter's icon (docs/glossary.md: matter icon): the key whose line (`MATTER_ICONS`) is nearest the
// matter's text (`matterTextOf`), by the Mac's embedder; no model call, nothing stored. Worked out when the connector
// reads matters, kept per process by text: a text is embedded once, as a query, against the lines embedded once, as
// passages. His pick (`ownerIcon`) wins and skips all of it.

/**
 * At or above this similarity the nearest line is Life's pick; below it, none (the phone shows the area's icon: a wrong
 * icon is worse). Measured 20 Nov 2026 on 64 made-up matters by the Mac's embedder (40 English, 20 French, 4 too vague
 * for any icon), name and goal: at 0.40, 33 of the 34 picks above it right and no vague one given an icon; at 0.35 (the
 * lowest still right 9 times in 10), 40 of 44, two vague ones among the wrong. French scores lower: 8 of 20 above.
 */
export const ICON_AT = 0.4;

/** The nearest key to `vector` among `lines` (the fallback `folder` never picked), when at `ICON_AT` or above; else null. Pure. */
export function lifeIconOf(
  vector: ArrayLike<number>,
  lines: readonly (readonly [MatterIconKey, ArrayLike<number>])[]
) {
  let best: { key: MatterIconKey; similarity: number } | undefined;
  for (const [key, line] of lines) {
    const similarity = similarityOf(vector, line);
    if (key !== "folder" && !(best && best.similarity >= similarity)) {
      best = { key, similarity };
    }
  }
  return best && best.similarity >= ICON_AT ? best.key : null;
}

/** One embedder's work, kept for the process: its lines' vectors so far, and each text's pick, settled or under way. */
interface IconWork {
  lines: number[][];
  linesReady?: Promise<(readonly [MatterIconKey, number[]])[]>;
  pending: Map<string, Promise<void>>;
  settled: Map<string, MatterIconKey | null>;
}
// ponytail: a settled text is never pruned (a key or null each, a few hundred a year); prune if a process outlives that.
const works = new WeakMap<Embedder, IconWork>();
let hasLogged = false;
let picksSettled = 0;

/** How many batches of picks have settled in this process: a reader keyed by it reads again once a pick lands. */
export const iconPicksSettled = () => picksSettled;

const workOf = (embedder: Embedder) => {
  const work = works.get(embedder) ?? {
    lines: [],
    pending: new Map(),
    settled: new Map(),
  };
  works.set(embedder, work);
  return work;
};

/** Every line's vector, shared by every caller: a batch done is kept, so after a failure the next caller goes on from the first missing line. */
function readLineVectors(embedder: Embedder, work: IconWork) {
  if (!work.linesReady) {
    const ready = (async () => {
      const missing = MATTER_ICONS.slice(work.lines.length).map(([, l]) => l);
      for await (const [, vectors] of embedBatches(
        embedder,
        missing,
        "passage"
      )) {
        work.lines.push(...vectors);
      }
      return MATTER_ICONS.map(
        ([key], i) => [key, work.lines[i] ?? []] as const
      );
    })();
    work.linesReady = ready;
    ready.catch(() => {
      work.linesReady = undefined;
    });
  }
  return work.linesReady;
}

/** Picks `texts` (reserved by the caller), each batch published as it lands; on a failure the rest is released for the next read. */
async function pickAll(
  embedder: Embedder,
  work: IconWork,
  texts: readonly string[],
  release: (text: string) => void
) {
  try {
    const lines = await readLineVectors(embedder, work);
    for await (const [batch, vectors] of embedBatches(
      embedder,
      texts,
      "query"
    )) {
      for (const [i, text] of batch.entries()) {
        work.settled.set(text, lifeIconOf(vectors[i] ?? [], lines));
        release(text);
      }
      picksSettled++;
    }
  } catch (error) {
    for (const text of texts) {
      release(text);
    }
    if (!hasLogged) {
      hasLogged = true;
      log("matter.icons", { error: String(error), ok: false });
    }
  }
}

/**
 * Life's pick for each of `views` his own pick does not cover, by matter id (`lifeIconOf`; a matter with none is left
 * out). A text picked before is reused; one under way for another read is joined; the rest is reserved at once, so
 * overlapping reads share it. Waits `waitMs` at most, by default not at all (a read never waits on the embedder): what
 * lands later is kept for the next read (`iconPicksSettled`).
 */
export async function readLifeIcons(
  views: readonly Pick<MatterView, "goal" | "id" | "name" | "ownerIcon">[],
  given?: Embedder | null,
  waitMs = 0
): Promise<ReadonlyMap<string, MatterIconKey>> {
  const textOf = new Map(
    views.flatMap((v) => (v.ownerIcon ? [] : [[v.id, matterTextOf(v)]]))
  );
  if (textOf.size === 0) {
    return new Map();
  }
  // Only now: finding the embedder probes the sources (`listening`), which an owner-only read never needs.
  const embedder = given === undefined ? embedderNow() : given;
  if (!embedder) {
    return new Map();
  }
  const work = workOf(embedder);
  const texts = [...new Set(textOf.values())];
  const misses = texts.filter(
    (t) => !(work.settled.has(t) || work.pending.has(t))
  );
  if (misses.length > 0) {
    const done = new Map<string, () => void>();
    for (const text of misses) {
      const { promise, resolve } = Promise.withResolvers<void>();
      work.pending.set(text, promise);
      done.set(text, resolve);
    }
    pickAll(embedder, work, misses, (text) => {
      if (done.has(text)) {
        work.pending.delete(text);
        done.get(text)?.();
        done.delete(text);
      }
    });
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.all(texts.flatMap((t) => work.pending.get(t) ?? [])),
    new Promise((resolve) => {
      timer = setTimeout(resolve, waitMs);
    }),
  ]);
  clearTimeout(timer);
  return new Map(
    [...textOf].flatMap(([id, text]) => {
      const key = work.settled.get(text);
      return key ? [[id, key] as const] : [];
    })
  );
}

/** A matter's icon as the readers give it: his pick, else Life's (`readLifeIcons`); none with neither (the phone shows the area's). Pure. */
export const iconNow = (
  v: Pick<MatterView, "id" | "ownerIcon">,
  lifeIcons: ReadonlyMap<string, MatterIconKey>
) => {
  if (v.ownerIcon) {
    return { by: "owner" as const, key: v.ownerIcon };
  }
  const key = lifeIcons.get(v.id);
  return key && { by: "life" as const, key };
};
