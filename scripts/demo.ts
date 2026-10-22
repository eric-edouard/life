import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { execOk } from "../src/proc";

// A made-up Life for the README: `bun scripts/demo.ts <new folder>` writes `data/` and `state/` there (the tests'
// src/test-data, plus a week of invented memory about a landlord, a plumber and a friend) and builds its search index.
// It touches no source and no live data: its settings turn every source off.
//
// The README's transcript is Claude Code with Life's read commands on that copy as its only tool:
//   cd "$(mktemp -d)" && claude -p --setting-sources "" --strict-mcp-config --tools Bash \
//     --allowedTools "Bash(env LIFE_DATA=<out>/data LIFE_STATE=<out>/state bun <repo>/src/cli.ts memory:*)" \
//     --append-system-prompt "Read the user's memory only with: env LIFE_DATA=<out>/data LIFE_STATE=<out>/state \
//       bun <repo>/src/cli.ts memory search|person|day …. Today is Thursday 22 October 2026. Cite observation ids." \
//     "What did I promise my landlord last week? Did I keep it?"
// The README's screenshot is Life.app's StatusWindow drawn offscreen (NSHostingView, cacheDisplay) from `snapshot()`
// (src/plate.ts) run with the same LIFE_DATA and LIFE_STATE, without the cards that read this Mac's own services.

const out = resolve(process.argv[2] ?? "");
if (!process.argv[2] || existsSync(out)) {
  console.error(
    "usage: bun scripts/demo.ts <a folder that does not exist yet>"
  );
  process.exit(1);
}
const data = join(out, "data");
const state = join(out, "state");
cpSync(join(import.meta.dir, "../src/test-data/truth"), join(data, "truth"), {
  recursive: true,
});
mkdirSync(join(state, "memory"), { recursive: true });
const write = (path: string, text: string) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text, { flag: "a" });
};
const lines = (rows: object[]) =>
  rows.map((r) => `${JSON.stringify(r)}\n`).join("");
const hex = (s: string, n: number) =>
  createHash("sha256").update(s).digest("hex").slice(0, n);

writeFileSync(
  join(state, "settings.json"),
  JSON.stringify({ agent: { name: "Orbit", wake: ["orbit"] }, sources: [] })
);
write(
  join(data, "memory/zones.jsonl"),
  lines([
    { from: "2019-01-01T00:00:00.000Z", schemaVersion: 1, tz: "Europe/Lisbon" },
  ])
);
writeFileSync(
  join(data, "truth/me.md"),
  "# Me\n\nSam, Life's made-up demo owner.\n\n## Goals\n1. Keep the flat in order.\n"
);
writeFileSync(
  join(data, "truth/people.yaml"),
  `schemaVersion: 1
people:
  - { id: me, name: Sam Doe }
  - { id: jean-dupont, name: Jean Dupont, relation: landlord of the flat on Rua das Flores }
  - { id: claire-dupont, name: Claire Dupont, relation: "Jean's daughter, handles the flat's paperwork" }
  - { id: ana, name: Ana, relation: close friend }
  - { id: hans, name: Hans, relation: plumber }
`
);

// Each unit: its day and local time, source, chat or thread, title, the cited message, and its facts:
// [type, claim, quote, speaker, people, when?].
type Fact = [string, string, string, string, string[], string?];
const UNITS: [string, string, string, string, string, string, Fact[]][] = [
  [
    "2026-10-13",
    "09:12",
    "whatsapp",
    "351910000001@s.whatsapp.net",
    "Jean Dupont",
    "whatsapp:351910000001@s.whatsapp.net/A1",
    [
      [
        "promise",
        "Sam promised Jean Dupont to pay the October rent by Friday 16 October.",
        "I'll send the rent by Friday, sorry for the delay",
        "me",
        ["jean-dupont"],
        "2026-10-16",
      ],
      [
        "promise",
        "Sam promised Jean Dupont to be home on Saturday 17 October to let the plumber in for the kitchen sink.",
        "I'll be home Saturday morning to let the plumber in",
        "me",
        ["jean-dupont", "hans"],
        "2026-10-17",
      ],
    ],
  ],
  [
    "2026-10-15",
    "18:40",
    "whatsapp",
    "351910000001@s.whatsapp.net",
    "Jean Dupont",
    "whatsapp:351910000001@s.whatsapp.net/B7",
    [
      [
        "news",
        "Sam sent the October rent to Jean Dupont on 15 October.",
        "Done, the October rent is sent",
        "me",
        ["jean-dupont"],
      ],
      [
        "person",
        "Jean Dupont thanked Sam for the rent and said the plumber Hans would come on Saturday at 10.",
        "Thanks Sam! Hans will be there Saturday at 10",
        "jean-dupont",
        ["hans"],
      ],
    ],
  ],
  [
    "2026-10-17",
    "10:05",
    "lifelog",
    "conv-demo-1",
    "Kitchen sink repair with the plumber",
    "job-demo-1:4@2026-10-17T09:05:00.000Z",
    [
      [
        "news",
        "Hans fixed the kitchen sink on 17 October by replacing the cracked drain pipe.",
        "the drain pipe was cracked, I put in a new one",
        "hans",
        [],
      ],
    ],
  ],
  [
    "2026-10-20",
    "21:30",
    "whatsapp",
    "351910000002@s.whatsapp.net",
    "Ana",
    "whatsapp:351910000002@s.whatsapp.net/C3",
    [
      [
        "promise",
        "Sam told Ana he would bring the cake to her birthday dinner on Saturday 24 October.",
        "Leave the cake to me",
        "me",
        ["ana"],
        "2026-10-24",
      ],
    ],
  ],
  [
    "2026-10-21",
    "11:02",
    "mail",
    "thread-lease",
    "Lease renewal 2027",
    "mail:<lease-2027@example.test>",
    [
      [
        "waiting",
        "Claire Dupont will send the 2027 lease for Sam to sign by the end of October.",
        "I'll send the new lease for you to sign before the end of the month",
        "claire-dupont",
        ["jean-dupont"],
        "2026-10-31",
      ],
    ],
  ],
];
const MOMENTS: [number, string, string, string, string, string | null][] = [
  [
    1,
    "Paid the October rent to Jean Dupont",
    "happened",
    "2026-10-15 18:40",
    "jean-dupont",
    null,
  ],
  [
    2,
    "Hans fixed the kitchen sink at the flat",
    "happened",
    "2026-10-17 10:00",
    "hans",
    "the flat, Rua das Flores",
  ],
  [3, "Ana's birthday dinner", "planned", "2026-10-24 20:00", "ana", "Luna"],
];

const madeBy = { engine: "claude", model: "demo", run: "demo-1" };
const units = UNITS.map(([day, time, source, key, title, ref, facts]) => {
  const at = new Date(`${day}T${time}:00+01:00`).toISOString();
  const unit = {
    at,
    day,
    hash: hex(`${ref}#`, 16),
    id: `u_${hex(ref, 12)}`,
    ref,
    source,
  };
  write(
    join(data, `memory/units/${day}.jsonl`),
    lines([
      {
        date: day,
        end: at,
        hash: unit.hash,
        id: unit.id,
        key,
        people: [`unknown:${title}`, "person:me"],
        refs: [ref],
        schemaVersion: 1,
        source,
        start: at,
        stats: { chars: 400, fromMe: 2, items: 6 },
        title,
      },
    ])
  );
  write(
    join(data, "memory/observations/2026-10.jsonl"),
    lines(
      facts.map(([type, text, quote, speaker, people, when]) => ({
        about: `person:${speaker}`,
        area: null,
        at,
        confidence: 0.9,
        date: day,
        entities: [
          ...new Set([
            `person:${speaker}`,
            "person:me",
            ...people.map((p) => `person:${p}`),
          ]),
        ],
        id: `obs_${hex(unit.id + type + quote + text, 12)}`,
        madeBy: { ...madeBy, prompt: "memory-extract.v5", unitHash: unit.hash },
        modality: when ? "plan" : "fact",
        quote,
        salience: when ? 3 : 2,
        schemaVersion: 1,
        source: { channel: source, ref },
        speaker: `person:${speaker}`,
        text,
        type,
        tz: "Europe/Lisbon",
        unit: unit.id,
        validFrom: null,
        validTo: null,
        when: when ?? null,
      }))
    )
  );
  write(
    join(data, "memory/extracted.jsonl"),
    lines([
      {
        at: "2026-10-22T02:30:00.000Z",
        observations: facts.length,
        prompt: "memory-extract.v5",
        run: madeBy.run,
        schemaVersion: 1,
        unit: unit.id,
        unitHash: unit.hash,
      },
    ])
  );
  return unit;
});
for (const [i, title, status, start, person, place] of MOMENTS) {
  const { day, id } = units[i] as (typeof units)[number];
  write(
    join(data, `memory/moments/${day}.jsonl`),
    lines([
      {
        copies: [],
        day,
        end: null,
        id: `mom_${hex(day + title, 12)}`,
        importance: 1,
        madeBy: { ...madeBy, prompt: "memory-moments.v4" },
        people: [{ ref: `person:${person}`, role: "with" }],
        place,
        schemaVersion: 1,
        start,
        status,
        title,
        units: [id],
        why: "demo",
      },
    ])
  );
}
await execOk(
  ["bun", join(import.meta.dir, "../src/cli.ts"), "memory", "index"],
  {
    env: { ...process.env, LIFE_DATA: data, LIFE_STATE: state },
  }
);
console.log(`LIFE_DATA=${data} LIFE_STATE=${state}`);
