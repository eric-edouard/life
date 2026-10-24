// Symbolicates one diagnostic from the phone or the Watch:
//   bun run symbolicate <diagnostic id>
// It reads the diagnostic from the server's GET /diagnostics (scripts/server.ts: LIFELOG_SERVER_URL and the
// device token). Each binary's dSYM is found by UUID in the store (scripts/dsyms.ts). Frames with a dSYM go through `atos`; the rest (system libraries) stay
// binary+offset. Crashes, hangs and exceptions carry MetricKit stacks, app errors the stack where
// they were caught, server errors their own symbolic stack. Ids come from diagnostics:recent.
import { $ } from "bun";
import {
  appBinaryUUIDs,
  Diagnostic,
  frameLabel,
  problemLines,
} from "../apps/server/src/diagnostics";
import { findDwarfs } from "./dsyms";
import { serverFetch } from "./server";

const [, , id] = process.argv;
if (!id) {
  throw new Error("usage: bun run symbolicate <diagnostic id>");
}
const res = await serverFetch(
  `/diagnostics?${new URLSearchParams({ id, limit: "500" })}`
);
// A server without the id filter ignores it and answers the newest 500.
const d = Diagnostic.array()
  .parse(await res.json())
  .find((x) => x.id.toLowerCase() === id.toLowerCase());
if (!d) {
  throw new Error(`no diagnostic ${id}`);
}

console.log(
  `${d.kind} ${d.id}, ${d.build.appVersion} (${d.build.appBuild}), ${d.build.os}, received ${d.receivedAt}`
);
console.log(d.signature);
for (const line of problemLines(d)) {
  console.log(line);
}

const uuids = new Set(
  d.callStacks.flatMap((s) => s.frames.map((f) => f.binaryUUID ?? ""))
);
uuids.delete("");
const dwarfs = await findDwarfs(uuids);
for (const [uuid, dwarf] of dwarfs) {
  console.log(`dSYM ${uuid} ${dwarf.bundle}`);
}
const missing = appBinaryUUIDs(d).filter((uuid) => !dwarfs.has(uuid));
if (missing.length > 0) {
  console.log(
    `No dSYM for the app binary ${missing.join(", ")}: its build's dSYMs were not kept, so its frames stay unsymbolicated.`
  );
}

const stacks = [...d.callStacks].sort(
  (a, b) => Number(b.threadAttributed) - Number(a.threadAttributed)
);
const hex = (n: number) => `0x${n.toString(16)}`;
// One atos run per binary and load address, with every frame from it; symbols keyed "stack:frame".
// Every frame of a known binary has both its address and its offset; their difference is the load address.
const ours = stacks.flatMap((stack, s) =>
  stack.frames.flatMap(({ address, binaryUUID = "", ...frame }, f) => {
    const dwarf = dwarfs.get(binaryUUID);
    return dwarf && address !== undefined
      ? [
          {
            address,
            dwarf,
            key: `${s}:${f}`,
            load: address - (frame.offsetIntoBinaryTextSegment ?? 0),
          },
        ]
      : [];
  })
);
const symbols = new Map<string, string>();
await Promise.all(
  [...Map.groupBy(ours, (f) => `${f.dwarf.file} ${f.load}`).values()].map(
    async (frames) => {
      const [{ dwarf, load }] = frames as [(typeof frames)[number]];
      const out =
        await $`atos -o ${dwarf.file} -arch ${dwarf.arch} -l ${hex(load)} ${frames.map((f) => hex(f.address))}`.text();
      for (const [i, line] of out.trim().split("\n").entries()) {
        symbols.set(frames[i]?.key ?? "", line);
      }
    }
  )
);

for (const [s, stack] of stacks.entries()) {
  console.log(`\n${stack.threadAttributed ? "Attributed thread" : "Thread"}:`);
  for (const [f, frame] of stack.frames.entries()) {
    const symbol = symbols.get(`${s}:${f}`) ?? frameLabel(frame);
    const samples = frame.sampleCount ? `  (${frame.sampleCount} samples)` : "";
    console.log(`${String(frame.depth).padStart(4)}  ${symbol}${samples}`);
  }
}
