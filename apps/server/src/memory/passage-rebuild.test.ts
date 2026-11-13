import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { filesIn } from "../core/files";
import type { SourceEvent } from "../records/source";
import { UNITS, ZONES } from "./memory-files";
import { rebuildPassages } from "./passage-rebuild";
import { readPassages } from "./passages";
import { tables } from "./sources";
import { recordToldLife } from "./told-life";
import { dayStart, localDate } from "./zones";

const TOLD_LIFE_NAME = "told-life";

const all: SourceEvent[] = [
  {
    at: dayStart("2004-05-01").toISOString(),
    chat: "rebuild",
    fromMe: true,
    id: "rebuild:a",
    sender: "owner",
    source: "line",
    text: "Rebuild cobalt history",
  },
];
const snapshot = async () => [
  readFileSync(ZONES, "utf8"),
  ...(await Promise.all(
    (await filesIn(UNITS)).map((f) => Bun.file(join(UNITS, f)).text())
  )),
];

test("explicit rebuild is bounded, resumes its failed month, and never changes units or zones", async () => {
  const before = await snapshot();
  const outages = new Set(["2004-05-01"]);
  const source = (from: Date, to?: Date) => {
    if (outages.has("2004-05-01") && from >= dayStart("2004-05-01")) {
      throw new Error("temporary source outage");
    }
    return all.filter(
      (e) => e.at >= from.toISOString() && (!to || e.at < to.toISOString())
    );
  };
  const read = {
    sources: () => ({ line: source }),
    zones: () => ({ deferred: [] as string[] }),
  };
  const result = await rebuildPassages(
    { from: "2004-04-01", to: "2004-05-31" },
    read
  );
  expect(result.failed).toBe(1);
  expect(result.months).toBe(1);
  expect(result.retry).toBe("2004-05-01");
  outages.clear();
  expect(
    (await rebuildPassages({ from: result.retry, to: "2004-05-31" }, read))
      .failed
  ).toBe(0);
  expect(readPassages().filter((p) => p.id === "line|rebuild:a")).toHaveLength(
    1
  );
  expect(await snapshot()).toEqual(before);
});

test("rebuild checks uncertainty over expanded edge days and defers their whole natural run", async () => {
  const boundary = dayStart("2004-06-01").getTime();
  const events = [-1, 1].map(
    (m, i): SourceEvent => ({
      ...(all[0] as SourceEvent),
      at: new Date(boundary + m * 60_000).toISOString(),
      id: `deferred:${i}`,
    })
  );
  let reportFrom = "";
  await rebuildPassages(
    { from: "2004-06-01", to: "2004-06-01" },
    {
      sources: () => ({
        line: (from, to) =>
          events.filter(
            (e) =>
              e.at >= from.toISOString() && (!to || e.at < to.toISOString())
          ),
      }),
      zones: (window) => {
        reportFrom = window.from;
        return { deferred: [localDate(events[0]?.at ?? "")] };
      },
    }
  );
  expect(reportFrom).toBe("2004-05-31");
  expect(
    readPassages().filter((p) => p.id.startsWith("line|deferred:"))
  ).toEqual([]);
});

test("what he told Life is written again as passages under the told-life source", async () => {
  const day = localDate(recordToldLife("Rebuild told-life amber note").at);
  await Bun.sleep(5); // a window reads only what is older than now
  const read = tables().SEARCHED[TOLD_LIFE_NAME];
  expect(read).toBeDefined();
  const out = await rebuildPassages(
    { from: day, to: day },
    { sources: () => ({ [TOLD_LIFE_NAME]: read as never }) }
  );
  expect(out.failed).toBe(0);
  expect(readPassages().some((p) => p.id.startsWith("told-life|"))).toBe(true);
  expect(readPassages().some((p) => p.id.startsWith("told|"))).toBe(false);
});
