import { z } from "zod";

// What Voice spent (its `GET /spending`, at most 31 days a call): its transcription jobs, the chat voice notes it
// heard and its model runs on the Mac. Read into spends by `spendsOfVoice` (memory/spends.ts).

export const VoiceSpending = z.object({
  jobs: z.array(
    z.object({
      at: z.string(),
      billableSeconds: z.number(),
      outcome: z.enum(["billed", "maybe_billed"]),
      seconds: z.number(),
      transcriber: z.enum(["scribe", "speech"]),
    })
  ),
  modelRuns: z.array(
    z.object({
      at: z.string(),
      inputTokens: z.number(),
      latencyMs: z.number().nullable(),
      model: z.string(),
      outputTokens: z.number(),
      provider: z.enum(["claude-code", "codex"]),
    })
  ),
  unsettled: z.number(),
  voiceNotes: z.array(
    z.object({
      at: z.string(),
      billableSeconds: z.number().nullable(),
      route: z.string().nullable(),
      seconds: z.number().nullable(),
    })
  ),
});
export type VoiceSpending = z.infer<typeof VoiceSpending>;
