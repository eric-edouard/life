// Scribe's words for the turns the speech service routed (route-turns.ts), cut from the audio and sent
// once, without a webhook: the one paid step after the speech service, for a recording's block
// (jobs.ts) and a chat voice note (routes/voice-notes.ts) alike.
import type { Db } from "@lifelog/db";
import { cutOggOpus, oggOpusSeconds } from "./audio";
import { billableSeconds, type Config } from "./config";
import { transcribeNow } from "./elevenlabs";
import { record } from "./events";
import { scribeRanges, transcriptOf, uncut } from "./route-turns";
import type { Release } from "./scribe-slots";
import type { Heard } from "./speech-service";

/**
 * The audio's transcript in Scribe's shape: the speech service's words, Scribe's inside `routed`.
 * `slot` gives a Scribe slot (scribe-slots.ts) or why none, `unsent`: nothing claimed or sent. Holding
 * it, `claim` runs just before a send that may be billed; false: nothing is sent (null). `later`:
 * Scribe took nothing now and billed nothing, fine to send again. Refused or maybe billed, the routed
 * turns stay without words and are never sent again.
 */
export async function hearRouted(
  { config, db }: { config: Config; db: Db },
  bytes: Uint8Array,
  heard: Heard,
  routed: Heard["turns"],
  {
    claim,
    keyterms,
    ref,
    slot: take,
  }: {
    claim: () => boolean;
    keyterms: string[];
    ref: Record<string, string>;
    slot: () => Promise<Release | string>;
  }
) {
  const excerpt = cutOggOpus(bytes, scribeRanges(routed));
  if (!excerpt) {
    return {
      billableSeconds: 0,
      error: null,
      kind: "heard" as const,
      maybeBilled: false,
      transcript: transcriptOf(heard, routed, null),
    };
  }
  const slot = await take();
  if (typeof slot === "string") {
    return { error: slot, kind: "unsent" as const };
  }
  if (!claim()) {
    slot();
    return null;
  }
  const said = await transcribeNow(
    config,
    new Blob([excerpt.audio.slice()]),
    keyterms
  ).finally(slot);
  record(db, `elevenlabs.${said.kind}`, { ...ref, turns: true });
  const billed = billableSeconds(oggOpusSeconds(excerpt.audio) ?? 0, {
    keyterms,
  });
  if (said.kind === "done") {
    const words = uncut(said.transcript.words, excerpt.spans);
    return {
      billableSeconds: billed,
      error: null,
      kind: "heard" as const,
      maybeBilled: false,
      transcript: transcriptOf(heard, routed, {
        languageCode: said.transcript.languageCode,
        words,
      }),
    };
  }
  if (said.later) {
    return { error: said.error, kind: "later" as const };
  }
  return {
    billableSeconds: said.billed ? billed : 0,
    error: `its Thai turns are missing: ${said.error.slice(0, 200)}`,
    kind: "heard" as const,
    maybeBilled: said.billed,
    transcript: transcriptOf(heard, routed, null),
  };
}
