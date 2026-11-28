// Scribe's words for the turns the speech service routed (route-turns.ts), cut from the audio and sent
// once, without a webhook: the one paid step after the speech service, for a recording's block
// (jobs.ts), a chat voice note (routes/voice-notes.ts) and a field's dictation (routes/dictation.ts)
// alike.
import type { Db } from "@lifelog/db";
import { cutOggOpus, oggOpusSeconds } from "./audio";
import { billableSeconds, type Config } from "./config";
import { ownerZoneAt } from "./diagnostics";
import { parseTranscript, textOf, transcribeNow } from "./elevenlabs";
import { record } from "./events";
import {
  routeIn,
  scribeRanges,
  transcriptOf,
  uncut,
  unheardOf,
} from "./route-turns";
import type { Priority, Unsent } from "./scribe-slots";
import { type Heard, transcribeBlock, type Unanswered } from "./speech-service";
import { switches } from "./switches";

/** Words as text, from a transcript in Scribe's shape. */
export const textFrom = (raw: unknown) =>
  textOf(parseTranscript(raw).transcript.words).trim();

/**
 * A short recording the owner waits for (a chat voice note, a field's dictation), heard by the
 * speech service and routed by where the owner was `at`: the Mac's words, and the turns Scribe must
 * hear (none: the words are final). The caller sends those through `hearRouted` and keeps what it
 * must; nothing is kept here.
 */
export async function hearOnTheMac(
  { config, db }: { config: Config; db: Db },
  bytes: Uint8Array,
  {
    at,
    priority,
    signal,
  }: { at: Date; priority: Priority; signal: AbortSignal }
): Promise<
  | Unanswered
  | { heard: Heard; route: string; routed: Heard["turns"]; text: string }
> {
  const said = await transcribeBlock(config, bytes, signal, priority);
  if ("error" in said) {
    return said;
  }
  const route = routeIn(
    switches().transcriber,
    said.heard,
    ownerZoneAt(db, at)
  );
  const routed = route.kind === "whole" ? said.heard.turns : route.routed;
  return {
    heard: said.heard,
    route: route.kind,
    routed,
    text: textFrom(transcriptOf(said.heard, routed, null)),
  };
}

// What hearing the routed turns came to: `heard`, the transcript (`maybeBilled` when Scribe may have
// billed turns that came back without words; `unheard`, how many routed turns Scribe had to hear have
// none of its words, whatever it answered: `unheardOf`), or `later`: Scribe took nothing now and billed nothing,
// fine to send again.
type Routed =
  | {
      billableSeconds: number;
      error: string | null;
      kind: "heard";
      maybeBilled: boolean;
      transcript: ReturnType<typeof transcriptOf>;
      unheard: number;
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
      unheard: unheardOf(routed, heard.words, []),
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
      const words = uncut(said.transcript.words, cut.spans);
      return {
        billableSeconds: billed,
        error: null,
        kind: "heard",
        maybeBilled: false,
        transcript: transcriptOf(heard, routed, {
          languageCode: said.transcript.languageCode,
          words,
        }),
        unheard: unheardOf(routed, heard.words, words),
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
      unheard: unheardOf(routed, heard.words, []),
    };
  }
}
