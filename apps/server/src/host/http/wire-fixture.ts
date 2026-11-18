import { expect } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// The phone's fixtures: what Life's tools say on made-up data is `apps/lifelog/fixtures/wire/life/<name>.json`, and Kit's
// `LifeConnector` tests decode the same files. `WRITE_WIRE=1` rewrites them (then `bun run fix`). Ids and instants made
// when a test ran are numbered by their first appearance (`isMadeNow`), so a fixture is the same every run.
const LIFE_WIRE = join(
  import.meta.dir,
  "../../../../lifelog/fixtures/wire/life"
);

function steady(value: unknown) {
  const seen = new Map<string, string>();
  const stand =
    (
      re: RegExp,
      make: (n: number, m: string) => string,
      keyOf = (m: string) => m
    ) =>
    (s: string) =>
      s.replace(re, (m) => {
        const key = keyOf(m);
        if (!seen.has(key)) {
          seen.set(key, make(seen.size + 1, m));
        }
        return seen.get(key) as string;
      });
  const ids = stand(
    /\b(dec|agt|entry)_[0-9a-f]{12}\b/g,
    (n, m) => `${m.slice(0, m.indexOf("_"))}_${String(n).padStart(12, "0")}`
  );
  const instants = stand(
    /\d{4}-\d\d-\d\dT[\d:.]+Z/g,
    (n) => `2026-11-18T10:00:${String(n).padStart(2, "0")}.000Z`,
    // Instants a test's run made within the same 5 s are one (a second boundary must not change the fixture).
    (m) => `t${Math.floor(Date.parse(m) / 5000)}`
  );
  return JSON.parse(instants(ids(JSON.stringify(value))));
}

/** `isMadeNow`: the answer holds ids and instants made as the test ran (numbered by their first appearance). */
export function expectWire(name: string, value: unknown, isMadeNow = false) {
  const file = join(LIFE_WIRE, `${name}.json`);
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  const wire = isMadeNow ? steady(parsed) : parsed;
  if (process.env.WRITE_WIRE) {
    writeFileSync(file, `${JSON.stringify(wire, null, 2)}\n`);
    return;
  }
  expect(wire).toEqual(JSON.parse(readFileSync(file, "utf8")));
}
