// Life sends identities through lifelog's authenticated contract, never through its store.
import { clock } from "../core/clock";
import { digest } from "../core/hash";
import { settings } from "../core/settings";
import { type People, readPeople } from "../memory/who";
import { INFERRED_USE_AT } from "../records/observation";
import { callLifelog, lifelogMissing } from "../sources/lifelog";

type IdentityReading = Pick<People, "canon" | "corrections" | "inferred"> & {
  truth: Pick<People["truth"], "people">;
};

/** Only canonical confident identities, plus folded explicit links needed for first-push reconciliation. */
export function lifelogPeopleOf(read: IdentityReading) {
  const { canon } = read;
  const latest = new Map(read.inferred.map((p) => [p.id, p]));
  const truth = read.truth.people.map((p) => ({
    aliases: p.aliases,
    name: p.name,
    personId: p.handles.lifelog ?? null,
    ref: `person:${p.id}`,
  }));
  const inferred = [...latest.values()]
    .filter((p) => p.confidence >= INFERRED_USE_AT)
    .map((p) => ({
      aliases: [],
      name: p.name,
      personId: null,
      ref: `person:${p.id}`,
    }));
  const canonical = [...truth, ...inferred].filter(
    (p) => canon(p.ref) === p.ref
  );
  const eligible = new Set(canonical.map((p) => p.ref));
  const refs = new Set([
    ...truth.map((p) => p.ref),
    ...read.inferred.map((p) => `person:${p.id}`),
    ...read.corrections.flatMap((c) =>
      c.kind === "same-person" ? [c.from, c.to] : []
    ),
  ]);
  const folds = Object.fromEntries(
    [...refs].sort().flatMap((ref) => {
      const to = canon(ref);
      return to !== ref && eligible.has(to) ? [[ref, to]] : [];
    })
  );
  const linkedFolds = truth.filter((p) => p.personId && folds[p.ref]);
  return {
    complete: true as const,
    folds,
    people: [...canonical, ...linkedFolds].sort((a, b) =>
      a.ref.localeCompare(b.ref)
    ),
    version: 1 as const,
  };
}

// One request per host tick; lifelog owns attempts, eligibility, caching and rollout state.
export function lifelogPeopleSync({
  read = readPeople,
  send = callLifelog,
  engine = () => settings().backfillEngine,
  enabled = () => !lifelogMissing(),
  now = () => clock().getTime(),
}: {
  read?: () => Promise<IdentityReading>;
  send?: typeof callLifelog;
  engine?: () => string | undefined;
  enabled?: () => boolean;
  now?: () => number;
} = {}) {
  let active = false;
  let lastHash = "";
  let revision = 0;
  return async () => {
    if (active || !enabled()) {
      return;
    }
    active = true;
    try {
      const snapshot = lifelogPeopleOf(await read());
      const hash = digest("sha256", JSON.stringify(snapshot), 64);
      if (hash !== lastHash) {
        revision = Math.max(now(), revision + 1);
        lastHash = hash;
      }
      // Replays are deliberate: failure cannot remove eligibility and a restart restates the complete snapshot.
      await send("/life/people", 60, { ...snapshot, revision }, "PUT");
      if (engine() === "codex") {
        await send("/naming-pass", 60, { engine: "codex", mode: "arrivals" });
      }
    } finally {
      active = false;
    }
  };
}

export const syncLifelogPeople = lifelogPeopleSync();
