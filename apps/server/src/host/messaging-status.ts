import { clock } from "../core/clock";
import { networkIntegrationsOf, readIntegrationReads } from "./integrations";

// `bun life bridge` without a verb (docs/use/bridges.md): every messaging integration that is on, one line each: ✓ when
// it works or is connecting, ✗ with its state and why when it doesn't, and the command that fixes its bridge when one
// does. The judgement is `integrationHealthOf`'s (`host/integrations.ts` holds the read); this only prints it.

/** Prints one line per messaging integration; exits 1 when one is ✗. */
export async function messagingStatus() {
  const reads = await readIntegrationReads(clock());
  const on = networkIntegrationsOf(reads).filter((i) => i.state !== "off");
  const color = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
  const mark = (ok: boolean) => {
    const sign = ok ? "✓" : "✗";
    return color ? `\x1b[${ok ? 32 : 31}m${sign}\x1b[0m` : sign;
  };
  if (on.length === 0) {
    console.log("no messaging network on");
    return 0;
  }
  const lines = on.map((i) => {
    const ok = i.state === "working" || i.state === "connecting";
    const command = reads.bridges.get(i.id.slice("network:".length))?.command;
    return {
      ok,
      text: `${mark(ok)} ${i.name.padEnd(10)} ${i.state}${i.why ? `: ${i.why}` : ""}${command ? ` (run: ${command})` : ""}`,
    };
  });
  for (const line of lines) {
    console.log(line.text);
  }
  return lines.every((l) => l.ok) ? 0 : 1;
}
