import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { DATA, STATE } from "server/src/core/paths";
import { MACHINE } from "server/src/core/platform";
import { execOk } from "server/src/core/proc";
import { madeBy, unit } from "server/src/memory/fixtures";

// A made-up Life for the README: `bun scripts/demo.ts <new folder>` writes `data/` and `state/` there (the tests'
// apps/server/src/test-data, plus a week of invented memory about a landlord, a plumber and a friend) and builds its search index.
// It reads no source: its settings turn every source off. `demo.test.ts` checks the README's ids against it.
//
// The README's transcript is Claude Code with Life's read commands on that copy as its only tool:
//   cd "$(mktemp -d)" && claude -p --setting-sources "" --strict-mcp-config --tools Bash \
//     --allowedTools "Bash(env LIFE_DATA=<out>/data LIFE_STATE=<out>/state bun <repo>/apps/server/src/host/cli.ts memory:*)" \
//     --append-system-prompt "Read the user's memory only with: env LIFE_DATA=<out>/data LIFE_STATE=<out>/state \
//       bun <repo>/apps/server/src/host/cli.ts memory search|person|day …. Today is Thursday 22 October 2026. Cite observation ids." \
//     "What did I promise my landlord last week? Did I keep it?"
//
// The README's screenshots were made by hand, with no script kept: `snapshot()` (apps/server/src/host/status/plate.ts), run with the same
// LIFE_DATA and LIFE_STATE, printed the plate as JSON; the cards about the Mac's own services were deleted from it
// (the tunnel, cloudflared, the nightly tick, /me and the whole Mac row), and Life.app's StatusWindow was drawn from
// what was left, offscreen. The other cards still show what the Mac that drew them reported about itself, such as
// Contacts readable and the archive copying, but none of its data.

const out = resolve(process.argv[2] ?? "");
const inside = (root: string) => !relative(root, out).startsWith("..");
const live = [DATA, STATE, MACHINE, join(homedir(), "Life")];
if (!process.argv[2] || existsSync(out) || live.some(inside)) {
  console.error(
    "usage: bun scripts/demo.ts <a new folder, outside Life's data and state>"
  );
  process.exit(1);
}
const data = join(out, "data");
const state = join(out, "state");
cpSync(
  join(import.meta.dir, "../apps/server/src/test-data/truth"),
  join(data, "truth"),
  {
    recursive: true,
  }
);
mkdirSync(join(state, "memory"), { recursive: true });
const write = (path: string, rows: object[]) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, rows.map((r) => `${JSON.stringify(r)}\n`).join(""), {
    flag: "a",
  });
};
const hex = (s: string, n: number) =>
  createHash("sha256").update(s).digest("hex").slice(0, n);

writeFileSync(
  join(state, "settings.json"),
  JSON.stringify({ agent: { name: "Orbit", wake: ["orbit"] }, sources: [] })
);
write(join(data, "memory/zones.jsonl"), [
  { from: "2019-01-01T00:00:00.000Z", schemaVersion: 1, tz: "Europe/Lisbon" },
]);
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

/** A fact: type, claim, quote, who said it, who else it is about, and its date when it has one. */
type Fact = [string, string, string, string, string[], string?];
interface Demo {
  at: string;
  facts: Fact[];
  key: string;
  moment?: { place: string | null; title: string; with: string };
  ref: string;
  source: "lifelog" | "mail" | "whatsapp";
  title: string;
}
const DEMO: Demo[] = [
  {
    at: "2026-10-13 09:12",
    facts: [
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
    key: "351910000001@s.whatsapp.net",
    ref: "whatsapp:351910000001@s.whatsapp.net/A1",
    source: "whatsapp",
    title: "Jean Dupont",
  },
  {
    at: "2026-10-15 18:40",
    facts: [
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
    key: "351910000001@s.whatsapp.net",
    moment: {
      place: null,
      title: "Paid the October rent to Jean Dupont",
      with: "jean-dupont",
    },
    ref: "whatsapp:351910000001@s.whatsapp.net/B7",
    source: "whatsapp",
    title: "Jean Dupont",
  },
  {
    at: "2026-10-17 10:05",
    facts: [
      [
        "news",
        "Hans fixed the kitchen sink on 17 October by replacing the cracked drain pipe.",
        "the drain pipe was cracked, I put in a new one",
        "hans",
        [],
      ],
    ],
    key: "conv-demo-1",
    moment: {
      place: "the flat, Rua das Flores",
      title: "Hans fixed the kitchen sink at the flat",
      with: "hans",
    },
    ref: "job-demo-1:4@2026-10-17T09:05:00.000Z",
    source: "lifelog",
    title: "Kitchen sink repair with the plumber",
  },
  {
    at: "2026-10-20 21:30",
    facts: [
      [
        "promise",
        "Sam told Ana he would bring the cake to her birthday dinner on Saturday 24 October.",
        "Leave the cake to me",
        "me",
        ["ana"],
        "2026-10-24",
      ],
    ],
    key: "351910000002@s.whatsapp.net",
    moment: { place: "Luna", title: "Ana's birthday dinner", with: "ana" },
    ref: "whatsapp:351910000002@s.whatsapp.net/C3",
    source: "whatsapp",
    title: "Ana",
  },
  {
    at: "2026-10-21 11:02",
    facts: [
      [
        "waiting",
        "Claire Dupont will send the 2027 lease for Sam to sign by the end of October.",
        "I'll send the new lease for you to sign before the end of the month",
        "claire-dupont",
        ["jean-dupont"],
        "2026-10-31",
      ],
    ],
    key: "thread-lease",
    ref: "mail:<lease-2027@example.test>",
    source: "mail",
    title: "Lease renewal 2027",
  },
];

const extract = { ...madeBy, prompt: "memory-extract.v5" };
for (const d of DEMO) {
  const day = d.at.slice(0, 10);
  const at = new Date(`${d.at.replace(" ", "T")}:00+01:00`).toISOString();
  const u = unit({
    date: day,
    end: at,
    hash: hex(`${d.ref}#`, 16),
    id: `u_${hex(d.ref, 12)}`,
    key: d.key,
    people: [`unknown:${d.title}`, "person:me"],
    refs: [d.ref],
    source: d.source,
    start: at,
    title: d.title,
  });
  write(join(data, `memory/units/${day}.jsonl`), [u]);
  write(
    join(data, "memory/observations/2026-10.jsonl"),
    d.facts.map(([type, text, quote, speaker, people, when]) => ({
      about: `person:${speaker}`,
      area: null,
      at,
      confidence: 0.9,
      date: day,
      entities: [
        ...new Set([speaker, "me", ...people].map((p) => `person:${p}`)),
      ],
      id: `obs_${hex(u.id + type + quote + text, 12)}`,
      madeBy: { ...extract, unitHash: u.hash },
      modality: when ? "plan" : "fact",
      quote,
      salience: when ? 3 : 2,
      schemaVersion: 1,
      source: { channel: d.source, ref: d.ref },
      speaker: `person:${speaker}`,
      text,
      type,
      tz: "Europe/Lisbon",
      unit: u.id,
      validFrom: null,
      validTo: null,
      when: when ?? null,
    }))
  );
  write(join(data, "memory/extracted.jsonl"), [
    {
      at: "2026-10-22T02:30:00.000Z",
      observations: d.facts.length,
      prompt: extract.prompt,
      run: extract.run,
      schemaVersion: 1,
      unit: u.id,
      unitHash: u.hash,
    },
  ]);
  if (d.moment) {
    const { place, title } = d.moment;
    const planned = d.facts.some((f) => f[5]);
    write(join(data, `memory/moments/${day}.jsonl`), [
      {
        copies: [],
        day,
        end: null,
        id: `mom_${hex(day + title, 12)}`,
        importance: 1,
        madeBy: { ...madeBy, prompt: "memory-moments.v4" },
        people: [{ ref: `person:${d.moment.with}`, role: "with" }],
        place,
        schemaVersion: 1,
        start: planned ? `${d.facts[0]?.[5]} 20:00` : d.at,
        status: planned ? "planned" : "happened",
        title,
        units: [u.id],
        why: "demo",
      },
    ]);
  }
}
// NODE_ENV=test (a `bun test` run) would point the CLI at the tests' own copy instead.
await execOk(
  [
    "bun",
    join(import.meta.dir, "../apps/server/src/host/cli.ts"),
    "memory",
    "index",
  ],
  {
    env: { ...process.env, LIFE_DATA: data, LIFE_STATE: state, NODE_ENV: "" },
  }
);
console.log(`LIFE_DATA=${data} LIFE_STATE=${state}`);
