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
  const ids = (s: string) =>
    s.replace(/\b(dec|agt|entry)_[0-9a-f]{12}\b/g, (m) => {
      if (!seen.has(m)) {
        seen.set(
          m,
          `${m.slice(0, m.indexOf("_"))}_${String(seen.size + 1).padStart(12, "0")}`
        );
      }
      return seen.get(m) as string;
    });
  // Every instant is one: the fixture checks the shape, not when the test ran.
  const instants = (s: string) =>
    s.replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, "2026-11-18T10:00:00.000Z");
  return JSON.parse(instants(ids(JSON.stringify(value))));
}

/** `isMadeNow`: the answer holds ids and instants made as the test ran. */
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
