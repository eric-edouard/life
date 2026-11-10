// Which turns the bench hears: every turn the owner answered, and a seeded draw of the others for
// the review. The same for the same archive and seed.
import { createHash } from "node:crypto";

export interface Row {
  conversationId: string;
  durationSeconds: number;
  id: string;
  jobId: string;
  speakerLabel: string;
  turnIndex: number;
}

// A turn's length, as the report groups it. Most of his turns are under 3 s.
export const LENGTHS = ["under 3 s", "3 to 6 s", "6 to 15 s", "over 15 s"];
export const lengthOf = (seconds: number) =>
  LENGTHS[[3, 6, 15].filter((edge) => seconds >= edge).length] ?? "";

// At most this many unanswered turns of one voice, so the draw reaches many voices.
const PER_VOICE = 3;

// A stable pseudo-random order: the hash of seed and id.
const rank = (seed: string, id: string) =>
  createHash("sha256").update(`${seed}:${id}`).digest("hex");

// A uniform draw keeps each length and each day at its real share; only the cap per voice bends it.
export function draw(unanswered: Row[], count: number, seed: string): Row[] {
  const perVoice = new Map<string, number>();
  return unanswered
    .map((row) => ({ rank: rank(seed, row.id), row }))
    .sort((a, b) => a.rank.localeCompare(b.rank))
    .flatMap(({ row }) => {
      const voice = `${row.jobId}/${row.speakerLabel}`;
      const taken = perVoice.get(voice) ?? 0;
      perVoice.set(voice, taken + 1);
      return taken < PER_VOICE ? [row] : [];
    })
    .slice(0, count);
}
