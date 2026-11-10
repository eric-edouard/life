// His answers in the bench's review, as writes for lifelog's server (the archive's one writer):
// what differs from his answer in the archive now. Nothing is marked as sent: a second run compares
// again and finds nothing.
import type { Export } from "@lifelog/server/scripts/eval-voices";
import type { BenchAnswer } from "./truth";

type Row = Export["assignments"][number];
interface Name {
  kind: "person" | "unknown" | "media" | "several";
  personId?: string;
}
interface Turn {
  id: string;
  jobId: string;
  speakerLabel: string;
  turnIndex: number;
}
// A write for a whole speaker (no turn) or one turn.
export interface Write extends Name {
  jobId: string;
  speakerLabel: string;
  turnIndex?: number;
}

const nameOf = (row: Row | undefined): Name | undefined => {
  if (!row) {
    return;
  }
  if (row.candidates) {
    return { kind: "several" };
  }
  return row.personId
    ? { kind: "person", personId: row.personId }
    : { kind: row.status === "media" ? "media" : "unknown" };
};
const same = (a: Name | undefined, b: Name | undefined) =>
  a?.kind === b?.kind && a?.personId === b?.personId;
const turnKey = (t: Omit<Turn, "id">) =>
  `${t.jobId}/${t.speakerLabel}/${t.turnIndex}`;

// The answer to write for each turn. `left` counts answers naming a person the archive no longer
// has, or one of `except`.
function wantedOf(
  turns: Turn[],
  answers: Map<string, BenchAnswer>,
  people: Set<string>,
  except: string[]
) {
  const wanted = new Map<string, Name>();
  let left = 0;
  for (const turn of turns) {
    const answer = answers.get(turn.id);
    if (!answer || answer.kind === "skipped") {
      continue;
    }
    const { kind, personId } = answer;
    if (kind !== "person") {
      wanted.set(turnKey(turn), { kind });
    } else if (personId && people.has(personId) && !except.includes(personId)) {
      wanted.set(turnKey(turn), { kind, personId });
    } else {
      left += 1;
    }
  }
  return { left, wanted };
}

// The whole speaker when every sample it has in the archive now got the same answer, then each turn
// that still differs.
export function writesOf(
  turns: Turn[],
  answers: Map<string, BenchAnswer>,
  archive: { assignments: Row[]; samples: Omit<Turn, "id">[] },
  people: Set<string>,
  except: string[] = []
) {
  const { left, wanted } = wantedOf(turns, answers, people, except);
  const samples = Map.groupBy(
    archive.samples,
    (s) => `${s.jobId}/${s.speakerLabel}`
  );
  const rows = Map.groupBy(
    archive.assignments,
    (a) => `${a.jobId}/${a.speakerLabel}`
  );
  const writes: Write[] = [];
  const voices = Map.groupBy(
    turns.filter((t) => wanted.has(turnKey(t))),
    (t) => `${t.jobId}/${t.speakerLabel}`
  );
  for (const [voice, mine] of voices) {
    const [{ jobId, speakerLabel }] = mine as [Turn, ...Turn[]];
    const first = wanted.get(turnKey(mine[0] as Turn));
    const own = rows.get(voice) ?? [];
    let whole = nameOf(own.find((r) => r.turnIndex === null));
    if (
      first &&
      !same(whole, first) &&
      (samples.get(voice) ?? []).every((s) =>
        same(wanted.get(turnKey(s)), first)
      )
    ) {
      writes.push({ ...first, jobId, speakerLabel });
      whole = first;
    }
    for (const turn of mine) {
      const name = wanted.get(turnKey(turn));
      const row = own.find((r) => r.turnIndex === turn.turnIndex);
      if (name && !same(row ? nameOf(row) : whole, name)) {
        writes.push({
          ...name,
          jobId,
          speakerLabel,
          turnIndex: turn.turnIndex,
        });
      }
    }
  }
  return { left, writes };
}

// One write, through the route the phone's own corrections take.
export async function send(url: string, token: string, write: Write) {
  const { jobId, kind, personId, speakerLabel, turnIndex } = write;
  const target =
    kind === "several"
      ? // Who is in it is not the bench's to say: nobody's evidence, no fallback.
        { kind, people: [], unknown: true }
      : { kind, personId };
  const res = await fetch(
    `${url}/transcripts/${jobId}/speakers/${encodeURIComponent(speakerLabel)}`,
    {
      body: JSON.stringify({ target, turnIndex }),
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      method: "PUT",
    }
  );
  if (!res.ok) {
    throw new Error(
      `lifelog answered ${res.status} for ${kind} on ${jobId}/${speakerLabel}/${turnIndex ?? "whole"}`
    );
  }
}
