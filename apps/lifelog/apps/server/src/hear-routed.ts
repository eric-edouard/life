// Scribe's words for the turns the speech service routed (route-turns.ts), cut from the audio and sent
// once, without a webhook: the one paid step after the speech service, for a recording's block
// (jobs.ts) and a chat voice note (routes/voice-notes.ts) alike.
import type { Db } from "@lifelog/db";
import { cutOggOpus, oggOpusSeconds } from "./audio";
import { billableSeconds, type Config } from "./config";
import { transcribeNow } from "./elevenlabs";
import { record } from "./events";
import { scribeRanges, transcriptOf, uncut } from "./route-turns";
import type { Unsent } from "./scribe-slots";
import type { Heard } from "./speech-service";

// What hearing the routed turns came to: `heard`, the transcript (`maybeBilled` when Scribe may have
// billed turns that came back without words), or `later`: Scribe took nothing now and billed nothing,
// fine to send again.
type Routed =
  | {
      billableSeconds: number;
      error: string | null;
      kind: "heard";
      maybeBilled: boolean;
      transcript: ReturnType<typeof transcriptOf>;
    }
  | { error: string; kind: "later" };

/**
 * The audio's transcript in Scribe's shape: the speech service's words, Scribe's inside `routed`.
 * `send` is the caller's paid send around the POST (`scribe-slots.ts`: a slot, then its claim);
 * `settle` stores what it came to, inside that send, so its slot is freed only once it is stored
 * (and for a transcript with no Scribe turns, with no slot). `unsent`: nothing was claimed or sent.
 * Refused or maybe billed, the routed turns stay without words and are never sent again.
 */
export async function hearRouted(
  { config, db }: { config: Config; db: Db },
  bytes: Uint8Array,
  heard: Heard,
  routed: Heard["turns"],
  {
    keyterms,
    ref,
    send,
    settle,
  }: {
    keyterms: string[];
    ref: Record<string, string>;
    send: <T>(post: () => Promise<T>) => Promise<T | Unsent>;
    settle: (routed: Routed) => void;
  }
): Promise<Routed | { error: string; kind: "unsent" }> {
  const excerpt = cutOggOpus(bytes, scribeRanges(routed));
  if (!excerpt) {
    const local = {
      billableSeconds: 0,
      error: null,
      kind: "heard" as const,
      maybeBilled: false,
      transcript: transcriptOf(heard, routed, null),
    };
    settle(local);
    return local;
  }
  const sent = await send(async () => {
    const said = await transcribeNow(
      config,
      new Blob([excerpt.audio.slice()]),
      keyterms
    );
    record(db, `elevenlabs.${said.kind}`, { ...ref, turns: true });
    const outcome = routedOf(said, excerpt);
    settle(outcome);
    return outcome;
  });
  return "unsent" in sent ? { error: sent.unsent, kind: "unsent" } : sent;

  function routedOf(
    said: Awaited<ReturnType<typeof transcribeNow>>,
    cut: NonNullable<ReturnType<typeof cutOggOpus>>
  ): Routed {
    const billed = billableSeconds(oggOpusSeconds(cut.audio) ?? 0, {
      keyterms,
    });
    if (said.kind === "done") {
      return {
        billableSeconds: billed,
        error: null,
        kind: "heard",
        maybeBilled: false,
        transcript: transcriptOf(heard, routed, {
          languageCode: said.transcript.languageCode,
          words: uncut(said.transcript.words, cut.spans),
        }),
      };
    }
    if (said.later) {
      return { error: said.error, kind: "later" };
    }
    return {
      billableSeconds: said.billed ? billed : 0,
      error: `its Thai turns are missing: ${said.error.slice(0, 200)}`,
      kind: "heard",
      maybeBilled: said.billed,
      transcript: transcriptOf(heard, routed, null),
    };
  }
}
