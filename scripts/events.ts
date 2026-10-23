// Every step of the chains, in time order, from the three places they happen: the server and the
// phone (GET /events, through scripts/server.ts: LIFELOG_SERVER_URL and the device token) and the Mac
// helper's log (~/Library/Logs/lifelog-quiet.log, when run on the owner's Mac).
//   bun run events [--since 10m|2h|1d] [name prefix ...]
// A prefix keeps only events whose name starts with it ("apns", "mac."); the Mac's log lines count
// as "mac".
import { homedir } from "node:os";
import { clock } from "@life/server/src/core/clock";
import { serverFetch } from "./server";

const UNITS = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000 } as const;
const SPAN = /^(\d+)([smhd])$/;
const MAC_LINE = /^(\d{4}-\d\d-\d\dT\S+Z) (.*)$/;

const args = process.argv.slice(2);
const sinceAt = args.indexOf("--since");
const span = sinceAt >= 0 ? args[sinceAt + 1] : "10m";
const match = span?.match(SPAN);
if (!match) {
  throw new Error("usage: bun run events [--since 10m|2h|1d] [prefix ...]");
}
const prefixes = args.filter((_, i) => i !== sinceAt && i !== sinceAt + 1);
const since = new Date(
  clock().getTime() - Number(match[1]) * UNITS[match[2] as keyof typeof UNITS]
);

interface Line {
  at: Date;
  name: string;
  source: string;
  text: string;
}

const res = await serverFetch(
  `/events?${new URLSearchParams({ limit: "5000", since: since.toISOString() })}`
);
const events = (await res.json()) as {
  at: string;
  fields: Record<string, unknown>;
  name: string;
  source: string;
}[];
const lines: Line[] = events.map((e) => ({
  at: new Date(e.at),
  name: e.name,
  source: e.source === "app" ? "phone" : "server",
  text: `${e.name}  ${Object.entries(e.fields)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ")}`,
}));

const macLog = Bun.file(`${homedir()}/Library/Logs/lifelog-quiet.log`);
const macText = (await macLog.exists()) ? await macLog.text() : "";
for (const raw of macText.split("\n")) {
  const [, at, text] = raw.match(MAC_LINE) ?? [];
  if (at && text && new Date(at) >= since) {
    lines.push({ at: new Date(at), name: "mac", source: "mac", text });
  }
}

const shown = lines
  .filter(
    (l) => prefixes.length === 0 || prefixes.some((p) => l.name.startsWith(p))
  )
  .sort((a, b) => a.at.getTime() - b.at.getTime());
for (const l of shown) {
  // Local time, to the millisecond (the Mac's log has whole seconds).
  const time = `${l.at.toLocaleString("sv-SE")}.${String(l.at.getMilliseconds()).padStart(3, "0")}`;
  console.log(`${time}  ${l.source.padEnd(6)}  ${l.text}`);
}
if (shown.length === 0) {
  console.log(`Nothing since ${since.toLocaleString("sv-SE")}.`);
}
