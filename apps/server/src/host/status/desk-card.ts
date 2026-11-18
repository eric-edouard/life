import { holder } from "../../core/lock";
import { agentsNow, readDesk } from "../desk-read";
import { agentLine } from "../registered-agents";
import { ASK, type Card, firstOf } from "./card";

// The status card "Agents": the desk's helper and its registered agents, read from its store read-only (no matter
// book). Red when the desk is on and its store unreadable or its helper not running; amber when an agent shows amber.

export function deskCard(now: number): Card {
  const read = readDesk((db) => agentsNow(db, now), []);
  const agents = read.state === "ok" ? read.value : [];
  const amber = agents.filter((a) => a.amber.length > 0);
  const count = (s: string) => agents.filter((a) => a.status === s).length;
  const active = count("running") + count("waiting");
  return {
    ...firstOf(
      [read.state === "off", { tone: "idle", word: "off" }],
      [
        read.state === "unreadable",
        {
          ask: ASK("that the desk's store can't be read"),
          tone: "bad",
          word: "unreadable",
        },
      ],
      [
        !holder("desk"),
        {
          ask: ASK("that the desk's helper is not running"),
          tone: "bad",
          word: "not running",
        },
      ],
      [amber.length > 0, { tone: "warn", word: `${amber.length} amber` }],
      [true, { tone: active > 0 ? "ok" : "idle", word: `${active} active` }]
    ),
    content: [
      ...(read.state === "unreadable" ? [`Error: ${read.why}`] : []),
      ...[...amber, ...agents.filter((a) => a.amber.length === 0)]
        .slice(0, 5)
        .map(agentLine),
    ],
    facts: [
      { label: "Running", value: String(count("running")) },
      { label: "Waiting", value: String(count("waiting")) },
      { label: "Stopped", value: String(count("stopped")) },
      { label: "Amber", value: String(amber.length) },
    ],
    group: "outputs",
    headline: `${active} agent${active === 1 ? "" : "s"} active`,
    id: "agents",
    name: "Agents",
  };
}
