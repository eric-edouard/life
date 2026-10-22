// `bun run check`: the single quality gate. Runs every step concurrently and fails fast.
import { rm } from "node:fs/promises";
import process from "node:process";

const steps: Record<string, string[]> = {
  biome: ["bun", "x", "--bun", "ultracite", "check"],
  cases: ["bun", "scripts/cases-check.ts"],
  fallow: [
    "bun",
    "x",
    "--bun",
    "fallow",
    "--fail-on-issues",
    "--baseline",
    ".fallow-baseline.json",
  ],
  scrub: ["bun", "scripts/scrub-check.ts"],
  test: ["bun", "test", "./apps/server/src/", "./scripts/", "./worker/"],
  types: ["bun", "x", "--bun", "tsc", "--noEmit"],
};

// Only the current failures stay in derived/check.
await rm("derived/check", { force: true, recursive: true });

// Output is drained while the step runs, so a chatty step never blocks on a full pipe.
// Each step leads its own process group, so killing it reaches the processes it started
// and none is left holding a lock for the next run.
const procs = Object.entries(steps).map(([name, cmd]) => {
  const proc = Bun.spawn(cmd, {
    detached: true,
    stderr: "pipe",
    stdout: "pipe",
  });
  const output = Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]).then((parts) => parts.join(""));
  return { name, output, proc };
});

function killAll() {
  for (const { proc } of procs) {
    try {
      process.kill(-proc.pid);
    } catch {
      // The whole group has already exited.
    }
  }
}

const results = procs.map(async ({ name, output, proc }) => {
  const code = await proc.exited;
  if (code === 0) {
    console.log(`✓ ${name}`);
    return;
  }
  const out = await output;
  const log = `derived/check/${name}.log`;
  await Bun.write(log, out);
  console.error(
    `✗ ${name} (full log: ${log})\n${out.trim().split("\n").slice(-20).join("\n")}`
  );
  killAll();
  process.exit(1);
});

// Detached steps no longer get the terminal's Ctrl-C, so pass it on.
process.on("SIGINT", () => {
  killAll();
  process.exit(130);
});

await Promise.all(results);
