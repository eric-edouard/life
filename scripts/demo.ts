import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { clock, daysBefore } from "@life/server/src/core/clock";
import { LIFE_STATE_DIR, OWNER_DATA_DIR } from "@life/server/src/core/paths";
import {
  APP_FOLDERS,
  MACHINE_DIR,
  pathInside,
} from "@life/server/src/core/platform";
import { execOk } from "@life/server/src/core/proc";
import { PUBLIC_PORT } from "@life/server/src/host/http/http";
import { EPISODES_PROMPT } from "@life/server/src/memory/episodes";
import { DIRECTIONS_PROMPT } from "@life/server/src/memory/matter-direction-due";
import { MATTERS_PROMPT } from "@life/server/src/memory/matters";
import {
  layoutOf,
  type PageLine,
  perSection,
  renderPage,
} from "@life/server/src/memory/page-format";
import { ownerHold } from "@life/server/src/memory/pages";
import { readMe } from "@life/server/src/memory/read-truth";
import { madeBy, unit } from "@life/server/src/memory/record-fixtures";

// A made-up Life for the README and docs/examples.md: `bun scripts/demo.ts <new folder>` writes `data/` and `state/` there (the tests'
// apps/server/src/test-data, plus a week of invented memory: a landlord, a plumber, a friend, runs, a side project and the owner's goals) and builds its search index.
// It reads no source: its settings turn every source off. `demo.test.ts` checks the ids both cite against it.
// It also holds a new matter dated from the day it is made (the leaking tap, with a goal and a `do` next step), so its
// inbox offers "Start an agent on this?", with the desk on and the connector on loopback. Written and run as a second Life on this Mac
// with `LIFE_OWNER_DATA_DIR=<out>/data LIFE_STATE_DIR=<out>/state LIFE_MACHINE_DIR=<out>/machine LIFE_PORT=46500`, the
// phone paired by `bun life pair --link`: `bun run e2e:demo` does all of it.
//
// Their transcripts are Claude Code with Life's read commands on that copy as its only tool:
//   cd "$(mktemp -d)" && claude -p --setting-sources "" --strict-mcp-config --tools Bash \
//     --allowedTools "Bash(env LIFE_OWNER_DATA_DIR=<out>/data LIFE_STATE_DIR=<out>/state bun <repo>/apps/server/src/desk/life-entry.ts memory:*)" \
//     --append-system-prompt "Read the user's memory only with: env LIFE_OWNER_DATA_DIR=<out>/data LIFE_STATE_DIR=<out>/state \
//       bun <repo>/apps/server/src/desk/life-entry.ts memory search|person|day …, one command per call. For a broad question about the user, \
//       read \`person me\` first. Today is Thursday 22 October 2026. Cite observation and episode ids. Answer concisely." \
//     "Has my past week been aligned with my goals? What should I change next week?"
// (The landlord transcript ran on 22 Oct with an earlier, shorter prompt.)

const out = resolve(process.argv[2] ?? "");
const inside = (root: string) => pathInside(root, out) !== null;
const live = [
  OWNER_DATA_DIR,
  LIFE_STATE_DIR,
  MACHINE_DIR,
  ...Object.values(APP_FOLDERS),
  join(homedir(), "Life"),
];
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

// The desk runtime the demo agent runs on: `LIFE_DEMO_RUNTIME=codex bun run e2e:demo` runs it on Codex.
const RUNTIME = process.env.LIFE_DEMO_RUNTIME ?? "claude";
writeFileSync(
  join(state, "settings.json"),
  JSON.stringify({
    connector: { origin: `http://127.0.0.1:${PUBLIC_PORT}` },
    desk: {
      defaultRuntime: RUNTIME,
      runtimes: { [RUNTIME]: RUNTIME === "claude" ? { model: "sonnet" } : {} },
    },
    sources: [],
  })
);
write(join(data, "memory/zones.jsonl"), [
  { from: "2019-01-01T00:00:00.000Z", schemaVersion: 1, tz: "Europe/Lisbon" },
]);
const me =
  "Sam, Life's made-up demo owner.\n\n## Goals\n1. Ship Tidepool's first beta by the end of November.\n2. Run three times a week.\n3. See friends at least once a week.\n4. Keep the flat in order.";
const meFile = `# Me\n\n${me}\n`;
writeFileSync(join(data, "truth/me.md"), meFile);
// His page as the first night writes it (pages.ts), holding truth/me.md: `person me` shows his goals from it.
mkdirSync(join(data, "memory/pages/people"), { recursive: true });
writeFileSync(
  join(data, "memory/pages/people/me.md"),
  renderPage({
    hold: ownerHold(readMe(meFile)),
    layout: layoutOf("person:me"),
    meta: {
      built: "2026-10-22T02:40:00.000Z",
      madeBy,
      name: "Sam Doe",
      page: "person:me",
      schemaVersion: 1,
      seen: madeBy.run,
    },
    owner: [],
    sections: perSection<PageLine>(),
    title: "Sam Doe",
  })
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

/** An observation: type, text, quote, who said it, who else it is about, and its date when it has one. */
type DemoObservation = [string, string, string, string, string[], string?];
interface Demo {
  at: string;
  episode?: {
    end?: string;
    place: string | null;
    title: string;
    with?: string;
  };
  key: string;
  observations: DemoObservation[];
  ref: string;
  source: "git" | "mail" | "voice" | "whatsapp";
  title: string;
}
/** The new matter's day: two days before the demo is made, so it is offered for five more. */
const tapDay = daysBefore(clock().toISOString().slice(0, 10), 2);
const TAP: Demo = {
  at: `${tapDay} 09:30`,
  key: "351910000001@s.whatsapp.net",
  observations: [
    [
      "news",
      "Jean Dupont told Sam the kitchen tap at the flat on Rua das Flores is leaking again.",
      "The kitchen tap is dripping again, can you have a look?",
      "jean-dupont",
      [],
    ],
    [
      "to_do",
      "Sam needs to book Hans to fix the leaking kitchen tap at the flat.",
      "I'll get Hans to come and fix the tap",
      "me",
      ["jean-dupont", "hans"],
    ],
  ],
  ref: `whatsapp:351910000001@s.whatsapp.net/T${tapDay}`,
  source: "whatsapp",
  title: "Jean Dupont",
};
const DEMO: Demo[] = [
  {
    at: "2026-10-13 09:12",
    key: "351910000001@s.whatsapp.net",
    observations: [
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
    ref: "whatsapp:351910000001@s.whatsapp.net/A1",
    source: "whatsapp",
    title: "Jean Dupont",
  },
  {
    at: "2026-10-15 18:40",
    episode: {
      place: null,
      title: "Paid the October rent to Jean Dupont",
      with: "jean-dupont",
    },
    key: "351910000001@s.whatsapp.net",
    observations: [
      [
        "news",
        "Sam sent the October rent to Jean Dupont on 15 October.",
        "Done, the October rent is sent",
        "me",
        ["jean-dupont"],
      ],
      [
        "about_a_person",
        "Jean Dupont thanked Sam for the rent and said the plumber Hans would come on Saturday at 10.",
        "Thanks Sam! Hans will be there Saturday at 10",
        "jean-dupont",
        ["hans"],
      ],
    ],
    ref: "whatsapp:351910000001@s.whatsapp.net/B7",
    source: "whatsapp",
    title: "Jean Dupont",
  },
  {
    at: "2026-10-17 10:05",
    episode: {
      place: "the flat, Rua das Flores",
      title: "Hans fixed the kitchen sink at the flat",
      with: "hans",
    },
    key: "conv-demo-1",
    observations: [
      [
        "news",
        "Hans fixed the kitchen sink on 17 October by replacing the cracked drain pipe.",
        "the drain pipe was cracked, I put in a new one",
        "hans",
        [],
      ],
    ],
    ref: "job-demo-1:4@2026-10-17T09:05:00.000Z",
    source: "voice",
    title: "Kitchen sink repair with the plumber",
  },
  {
    at: "2026-10-15 07:30",
    episode: {
      end: "2026-10-15 08:15",
      place: "Ribeira das Naus",
      title: "Morning run along the river",
    },
    key: "conv-demo-run-1",
    observations: [],
    ref: "job-demo-2:0@2026-10-15T06:30:00.000Z",
    source: "voice",
    title: "Morning run",
  },
  {
    at: "2026-10-16 20:10",
    episode: {
      end: "2026-10-16 23:40",
      place: "home",
      title: "Worked on Tidepool: the tide chart",
    },
    key: "tidepool",
    observations: [],
    ref: "git:tidepool/2026-10-16",
    source: "git",
    title: "tidepool",
  },
  {
    at: "2026-10-18 09:20",
    key: "351910000002@s.whatsapp.net",
    observations: [
      [
        "news",
        "Sam told Ana he skipped his Sunday run because he went to bed at 2.",
        "Skipped the run again, I was up coding until 2",
        "me",
        ["ana"],
      ],
    ],
    ref: "whatsapp:351910000002@s.whatsapp.net/C1",
    source: "whatsapp",
    title: "Ana",
  },
  {
    at: "2026-10-19 22:05",
    episode: {
      end: "2026-10-20 01:30",
      place: "home",
      title: "Fixed Tidepool's crash and sent the beta to three friends",
    },
    key: "351910000002@s.whatsapp.net",
    observations: [
      [
        "news",
        "Sam sent the first Tidepool beta to three friends on 19 October, after fixing the tide chart crash.",
        "Beta's out to Ana, Leo and Mia, the chart doesn't crash anymore",
        "me",
        ["ana"],
      ],
    ],
    ref: "whatsapp:351910000002@s.whatsapp.net/C2",
    source: "whatsapp",
    title: "Ana",
  },
  {
    at: "2026-10-20 21:30",
    episode: { place: "Luna", title: "Ana's birthday dinner", with: "ana" },
    key: "351910000002@s.whatsapp.net",
    observations: [
      [
        "promise",
        "Sam told Ana he would bring the cake to her birthday dinner on Saturday 24 October.",
        "Leave the cake to me",
        "me",
        ["ana"],
        "2026-10-24",
      ],
    ],
    ref: "whatsapp:351910000002@s.whatsapp.net/C3",
    source: "whatsapp",
    title: "Ana",
  },
  {
    at: "2026-10-21 07:40",
    episode: {
      end: "2026-10-21 08:20",
      place: "Ribeira das Naus",
      title: "Morning run along the river",
    },
    key: "conv-demo-run-2",
    observations: [],
    ref: "job-demo-3:0@2026-10-21T06:40:00.000Z",
    source: "voice",
    title: "Morning run",
  },
  {
    at: "2026-10-21 11:02",
    key: "thread-lease",
    observations: [
      [
        "waiting_on_someone",
        "Claire Dupont will send the 2027 lease for Sam to sign by the end of October.",
        "I'll send the new lease for you to sign before the end of the month",
        "claire-dupont",
        ["jean-dupont"],
        "2026-10-31",
      ],
    ],
    ref: "mail:<lease-2027@example.test>",
    source: "mail",
    title: "Lease renewal 2027",
  },
];

const extract = { ...madeBy, prompt: "memory-extract.v8" };
const unitIdOf = (d: Demo) => `unit_${hex(d.ref, 12)}`;
const observationIdOf = (d: Demo, [type, text, quote]: DemoObservation) =>
  `obs_${hex(unitIdOf(d) + type + quote + text, 12)}`;
for (const d of [...DEMO, TAP]) {
  const day = d.at.slice(0, 10);
  const at = new Date(`${d.at.replace(" ", "T")}:00+01:00`).toISOString();
  const u = unit({
    date: day,
    end: at,
    hash: hex(`${d.ref}#`, 16),
    id: unitIdOf(d),
    key: d.key,
    people: [`unknown:${d.title}`, "person:me"],
    refs: [d.ref],
    source: d.source,
    start: at,
    title: d.title,
  });
  write(join(data, `memory/units/${day}.jsonl`), [u]);
  write(
    join(data, `memory/observations/${day.slice(0, 7)}.jsonl`),
    d.observations.map(([type, text, quote, speaker, people, when]) => ({
      about: `person:${speaker}`,
      area: null,
      at,
      confidence: 0.9,
      date: day,
      id: observationIdOf(d, [type, text, quote, speaker, people]),
      importance: when ? 3 : 2,
      madeBy: { ...extract, unitHash: u.hash },
      modality: when ? "plan" : "fact",
      quote,
      schemaVersion: 1,
      source: { channel: d.source, ref: d.ref },
      speaker: `person:${speaker}`,
      subjects: [
        ...new Set([speaker, "me", ...people].map((p) => `person:${p}`)),
      ],
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
      observations: d.observations.length,
      prompt: extract.prompt,
      run: extract.run,
      schemaVersion: 1,
      unit: u.id,
      unitHash: u.hash,
    },
  ]);
  // A plan is a fact with its date, never an episode.
  if (d.episode && !d.observations.some((f) => f[5])) {
    const { end, place, title } = d.episode;
    write(join(data, `memory/episodes/${day}.jsonl`), [
      {
        copies: [],
        day,
        end: end ?? null,
        id: `ep_${hex(day + title, 12)}`,
        importance: 1,
        madeBy: { ...madeBy, prompt: EPISODES_PROMPT },
        people: d.episode.with
          ? [{ ref: `person:${d.episode.with}`, role: "with" }]
          : [],
        place,
        schemaVersion: 1,
        start: d.at,
        title,
        units: [u.id],
        what: title,
        within: null,
      },
    ]);
  }
}
// The tap as the night leaves it: one matter (the matters step) and its goal and next step (the directions step).
const tapSteps = TAP.observations.map((o) => ({
  day: tapDay,
  quote: o[2],
  ref: observationIdOf(TAP, o),
}));
const tapAt = `${tapDay}T23:00:00.000Z`;
write(join(data, "memory/matters.jsonl"), [
  {
    at: tapAt,
    madeBy: { ...madeBy, prompt: MATTERS_PROMPT },
    matters: [
      {
        areas: [],
        id: `matter_${hex(TAP.ref, 12)}`,
        name: "The leaking kitchen tap at the flat",
        projects: [],
        steps: tapSteps,
      },
    ],
    offered: [unitIdOf(TAP)],
    schemaVersion: 1,
  },
]);
write(join(data, "memory/matter-directions.jsonl"), [
  {
    at: tapAt,
    directions: [
      {
        goal: "Get the kitchen tap at the flat fixed",
        laterShown: [],
        nextStep: {
          kind: "do",
          text: "Find a time with Hans for him to come and fix the tap",
        },
        steps: tapSteps.map((s) => s.ref),
      },
    ],
    madeBy: { ...madeBy, prompt: DIRECTIONS_PROMPT },
    schemaVersion: 1,
  },
]);
// NODE_ENV=test (a `bun test` run) would point the CLI at the tests' own copy instead.
await execOk(
  [
    "bun",
    join(import.meta.dir, "../apps/server/src/desk/life-entry.ts"),
    "memory",
    "index",
  ],
  {
    env: {
      ...process.env,
      LIFE_OWNER_DATA_DIR: data,
      LIFE_STATE_DIR: state,
      NODE_ENV: "",
    },
  }
);
console.log(`LIFE_OWNER_DATA_DIR=${data} LIFE_STATE_DIR=${state}`);
