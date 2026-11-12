// `bun scripts/pilot-voice-set.ts <name> [--calls <n>]`: a test set of recorded conversations, to try the reads on
// speech: conversations where only he and one person lifelog named speak, of 20 to 480 turns with words, at most eight a
// person, in an order that never changes. Each turn stands as a message (its words as lifelog transcribed them), each
// thirty turns in a row as one exchange (four a call at most), saved whole in his data like `pilot-set.ts`. Prints counts, never a word or a name.

import { parseArgs } from "node:util";
import { writeJson } from "@life/server/src/core/files";
import { digest } from "@life/server/src/core/hash";
import { OWNER } from "@life/server/src/memory/read-truth";
import { lifelogNames } from "@life/server/src/memory/units";
import { readPeople } from "@life/server/src/memory/who";
import { transcripts, voiceLines } from "@life/server/src/memory/words";
import type { SourceEvent } from "@life/server/src/records/source";
import { turnsBetween, withStore } from "@life/server/src/sources/lifelog";
import { setFile, type TestSet } from "./memory-pilot";

const [LEAST, MOST, PER_PERSON] = [20, 480, 8];
/** Turns in a row that stand as one exchange (a chat's exchange is about ten messages), and exchanges a call. */
const [PIECE, PIECES] = [30, 4];

if (import.meta.main) {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { calls: { type: "string" } },
  });
  const [name] = positionals;
  if (!name) {
    throw new Error(
      "usage: bun scripts/pilot-voice-set.ts <name> [--calls <n>]"
    );
  }
  const people = await readPeople();
  const conversations = await withStore((store) =>
    store.db
      .query<{ id: string }, []>(
        `select conversation_id id from turns group by 1
         having sum(is_owner) >= 5
           and count(distinct case when is_owner = 0 then coalesce(person_id, person_name) end) = 1
           and sum(case when is_owner = 0 and person_id is null and person_name is null then 1 else 0 end) * 7 <= count(*)
           and count(*) between ${LEAST} and ${MOST * 2}`
      )
      .all()
      .map((c) => ({
        id: c.id,
        turns: turnsBetween(
          store,
          c.id,
          "",
          "9999",
          lifelogNames(people.truth)
        ),
      }))
      .toSorted((a, b) =>
        digest("sha1", a.id, 12).localeCompare(digest("sha1", b.id, 12))
      )
  );
  const set: TestSet = [];
  const taken = new Map<string, number>();
  let seen = 0;
  for (const c of conversations) {
    if (set.length >= Number(values.calls ?? 36)) {
      break;
    }
    // biome-ignore lint/performance/noAwaitInLoops: one conversation's words at a time, until the set is full
    const jobs = await transcripts(c.turns);
    // A voice no one named (a seventh of the turns at most) is left out.
    const lines = voiceLines(c.turns, jobs, people.resolve).filter(
      (l) => l.speaker === OWNER || l.speaker.startsWith("person:")
    );
    const other = lines.find((l) => l.speaker !== OWNER)?.speaker ?? "";
    const known = other.startsWith("person:")
      ? other.slice("person:".length)
      : "";
    seen += 1;
    if (
      !known ||
      lines.length < LEAST ||
      lines.length > MOST ||
      lines.filter((l) => l.speaker === OWNER).length < 5 ||
      (taken.get(known) ?? 0) >= PER_PERSON
    ) {
      continue;
    }
    taken.set(known, (taken.get(known) ?? 0) + 1);
    const turns = lines.map(
      (l) =>
        ({
          at: l.at,
          chat: c.id,
          fromMe: l.speaker === OWNER,
          id: l.ref,
          sender: l.speaker,
          source: "lifelog",
          text: l.text,
        }) as unknown as SourceEvent
    );
    const batch = Array.from(
      { length: Math.ceil(turns.length / PIECE) },
      (_, i) => turns.slice(i * PIECE, (i + 1) * PIECE)
    ).slice(0, PIECES);
    set.push({
      batch,
      with: {
        name: people.nameOf(other),
        relation:
          people.truth.people.find((p) => p.id === known)?.relation ?? null,
      },
    });
  }
  writeJson(setFile(name), set);
  console.table([
    {
      calls: set.length,
      candidates: conversations.length,
      exchanges: set.reduce((n, s) => n + s.batch.length, 0),
      looked: seen,
      people: taken.size,
      turns: set.reduce((n, s) => n + s.batch.flat().length, 0),
    },
  ]);
}
