import { daysBefore } from "../core/clock";
import { log } from "../core/log";
import type { SourceName } from "../core/names";
import { readOwnerName } from "../models/prompt-parts";
import { type MatterView, matterTextOf } from "./matter-read";
import { readIndex } from "./memory-files";
import { type Placed, paymentText, placedOn } from "./payments";
import { rankedUnitIds } from "./search";
import { clip, normalize } from "./units";
import { embedQuery } from "./vectors";

// A matter's evidence (docs/glossary.md): what its direction is shown beyond observations, so a draft can see that its
// open things happened (a receipt mail, a "password changed" mail, the payment itself). For a matter holding an open
// step, in a window from its oldest open step's day: the units and his payments nearest its words. Read each night for
// the matters drafted, never stored.

/** How far back a window reaches at most: a stale matter's evidence is read over its last months, never all its years. */
export const EVIDENCE_DAYS = 120;
/** How many units and payments a matter is shown at most. */
const SHOWN = 5;
const TITLE_CHARS = 160;
/** A word shorter than this never ties a payment to a matter ("of", "to"); a short brand name does. */
const MIN_WORD = 3;

export interface Evidence {
  payments: { day: string; id: string; text: string }[];
  units: { day: string; id: string; source: SourceName; title: string }[];
}

/** A matter's window: from its oldest open step's day, at most `EVIDENCE_DAYS` back; none without an open step. Pure. */
export const windowOf = (v: Pick<MatterView, "openSteps">, today: string) => {
  const [oldest] = v.openSteps.map((s) => s.day).toSorted();
  return oldest
    ? {
        from:
          [oldest, daysBefore(today, EVIDENCE_DAYS)].toSorted().at(-1) ??
          oldest,
        to: today,
      }
    : null;
};

const SPACES = /\s+/;

const wordsOf = (text: string) =>
  new Set(
    normalize(text)
      .split(" ")
      .filter((w) => w.length >= MIN_WORD)
  );

/** `text` without the owner's name: he is in every matter, so his name never tells one apart ("Sam's" goes too, for an owner called Sam). Pure. */
export const withoutOwnerOf = (text: string, owner: string) => {
  const names = new Set(normalize(owner).split(" "));
  return text
    .split(SPACES)
    .filter((t) => !names.has(normalize(t).split(" ")[0] ?? ""))
    .join(" ");
};

const paymentWords = (p: Placed) =>
  wordsOf([p.payment.merchant, p.payment.category, p.payment.note].join(" "));

/**
 * The payments of `window` sharing the most of `name`'s words (a matter's name: the thing it is about, never its goal's
 * "paid" or "done"), at most `SHOWN`, each shown by what was paid (`paymentText`), with an id local to its call. A word
 * in more than 1% of the payments read (a category, a shop he pays daily) ties nothing. ponytail: words only, no
 * meaning: embedding every payment line each night would cost more than the few a matter needs.
 */
export function paymentsFor(
  name: string,
  window: { from: string; to: string },
  placed: readonly Placed[],
  idOf: (n: number) => string
) {
  const seen = new Map<string, number>();
  for (const p of placed) {
    for (const w of paymentWords(p)) {
      seen.set(w, (seen.get(w) ?? 0) + 1);
    }
  }
  const common = Math.max(2, placed.length / 100);
  const words = new Set(
    [...wordsOf(name)].filter((w) => (seen.get(w) ?? 0) <= common)
  );
  return placed
    .filter((p) => p.day >= window.from && p.day <= window.to)
    .map((p) => ({
      p,
      shared: [...paymentWords(p)].filter((w) => words.has(w)).length,
    }))
    .filter((s) => s.shared > 0)
    .toSorted((a, b) => b.shared - a.shared || b.p.day.localeCompare(a.p.day))
    .slice(0, SHOWN)
    .map(({ p }, n) => ({
      day: p.day,
      id: idOf(n),
      // Only what was paid: no time, place or episode.
      text: paymentText(p.payment),
    }));
}

/**
 * Each matter's evidence, by its id: the units best for its words in its window (`rankedUnitIds`, by meaning and any
 * word, its own steps' units and the units its observations were read from left out) and its payments (`paymentsFor`,
 * one read of the payments for all, `placedOn`, none while they are off). A matter with no open step has none.
 */
export async function readEvidence(
  matters: readonly {
    later: readonly { id: string }[];
    v: Pick<MatterView, "goal" | "id" | "name" | "openSteps" | "steps">;
  }[],
  today: string
) {
  const withWindow = matters.flatMap((m) => {
    const window = windowOf(m.v, today);
    return window ? [{ ...m, window }] : [];
  });
  const [from] = withWindow.map((m) => m.window.from).toSorted();
  const paid = from ? await placedOn(from, today, [], []) : { list: [] };
  if ("error" in paid) {
    log("run.error", {
      message: paid.error,
      step: "matter-directions.evidence",
    });
  }
  const owner = readOwnerName();
  const texts = withWindow.map((m) => withoutOwnerOf(matterTextOf(m.v), owner));
  const vectors = await Promise.all(texts.map((t) => embedQuery(t)));
  const out = new Map<string, Evidence>();
  for (const [i, m] of withWindow.entries()) {
    const text = texts[i] ?? "";
    const vector = vectors[i]?.vector;
    const own = [...m.v.steps.map((s) => s.ref), ...m.later.map((o) => o.id)];
    const units =
      readIndex((db) => {
        const left = new Set([
          ...own,
          ...db
            .query<{ unit: string }, [string]>(
              "select unit from observations where id in (select value from json_each(?))"
            )
            .all(JSON.stringify(own))
            .map((r) => r.unit),
        ]);
        const ids = rankedUnitIds(db, text, m.window, vector, "OR")
          .filter((id) => !left.has(id))
          .slice(0, SHOWN);
        const rows = db
          .query<
            { date: string; id: string; source: SourceName; title: string },
            [string]
          >(
            "select id, date, source, title from units where id in (select value from json_each(?))"
          )
          .all(JSON.stringify(ids));
        return ids.flatMap((id) => {
          const r = rows.find((x) => x.id === id);
          return r
            ? [
                {
                  day: r.date,
                  id,
                  source: r.source,
                  title: clip(r.title, TITLE_CHARS),
                },
              ]
            : [];
        });
      }) ?? [];
    out.set(m.v.id, {
      payments: paymentsFor(
        withoutOwnerOf(m.v.name, owner),
        m.window,
        paid.list,
        (n) => `pay-${n + 1}`
      ),
      units,
    });
  }
  return out;
}
