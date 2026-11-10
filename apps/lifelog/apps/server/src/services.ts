import { type QueueCache, queueCache } from "./naming-cache";
// Everything the routes and the background loops share, built once: index.ts serves it, the
// tests override parts of it, scripts/openapi.ts only reads the routes it gives.

import type { Db } from "@lifelog/db";
import {
  apnsFor,
  type Notice,
  type Nudge,
  type Pusher,
  phoneNotice,
  phoneNudger,
} from "./apns";
import { type HealthWatch, healthWatch } from "./archive-health";
import { type AudioStore, memoryAudioStore } from "./audio-store";
import type { Config } from "./config";
import {
  type ConversationStates,
  conversationStates,
} from "./conversation-state";
import { reportError } from "./diagnostics";
import { type ExcerptSampler, excerptSampler } from "./excerpts";
import { type JobWorker, jobWorker } from "./jobs";
import { type MacSocket, macSocket } from "./mac-socket";
import { type MorningPush, morningPush } from "./naming-queue";
import { type PageProcessor, pageProcessor } from "./page-processing";
import { type VoiceUpkeep, voiceUpkeep } from "./people";
import { macProvider, type Provider } from "./providers";
import { type Restic, resticFor } from "./restic";
import { type Rolling, rollingChapters } from "./rolling";
import type { Search } from "./search";
import { switches } from "./switches";

export function services(
  config: Config,
  db: Db,
  {
    // Null when the key is not configured.
    apns = apnsFor(config),
    // Every job's audio: the bucket, which index.ts passes; in memory for tests.
    audio = memoryAudioStore(),
    mac = macSocket(db),
    // The one sender of jobs to ElevenLabs, from the bucket; it first closes the phone's speech
    // fragments into blocks (cutter.ts).
    worker = jobWorker(db, config, audio, mac),
    // Summaries run only on the Mac, on the owner's Max plan; never on a paid API.
    intelligence = macProvider(mac, () => !switches().ai),
    // Tells the phone a transcript or summary is ready (a silent push to the same app).
    nudge = phoneNudger(db, apns, config.APNS_TOPIC),
    // The voices to name: the list, and its length in each morning's push.
    queue = queueCache(db),
    morning = morningPush(db, apns, config.APNS_TOPIC, queue),
    // A visible push another app of the owner's asks for (Life: each voice ask it heard).
    notice = phoneNotice(db, apns, config.APNS_TOPIC),
    // Summaries, chapter by chapter as conversations go on, on the Mac.
    rolling = rollingChapters(db, { mac: intelligence, nudge }),
    // At Lifelog Host's embedder, which index.ts passes; none for tests, so none calls it.
    search = null,
    voices = voiceUpkeep(db),
    // Cuts a job's clean turns from its bucket audio and embeds them (rebuild P3). Summaries
    // name speakers when read, so recognition starts nothing.
    excerpts = excerptSampler(db, config, audio),
    // The archive's invariants, hourly, with an email to the owner when one breaks.
    health = healthWatch(db, config),
    // The daily restic snapshot, when RESTIC_* is set.
    restic = resticFor(db, config),
    // A thin phone's raw pages, labeled and cut into speech fragments here.
    pages = pageProcessor(db, audio, worker, {
      vouched: () => mac.vouchedThrough().getTime(),
    }),
  }: {
    apns?: Pusher | null;
    audio?: AudioStore;
    morning?: MorningPush;
    excerpts?: ExcerptSampler;
    health?: HealthWatch;
    intelligence?: Provider | null;
    mac?: MacSocket;
    notice?: Notice;
    nudge?: Nudge;
    pages?: PageProcessor;
    queue?: QueueCache;
    restic?: Restic | null;
    rolling?: Rolling;
    search?: Search | null;
    voices?: VoiceUpkeep;
    worker?: JobWorker;
  } = {}
) {
  // Where each conversation stands and why it waits, from its jobs, words and summary, the
  // switches, the credits and the Mac.
  const states: ConversationStates = conversationStates(db, {
    creditsOut: worker.creditsOut,
    macAble: () => mac.able(),
    macStuckSince: () => mac.stuckSince(),
  });
  // A transcript stored, by whichever path (jobs.ts `complete`, after its turns and grouping): its
  // conversation's chapters roll, its clean turns are cut and recognized, the phone hears of it,
  // and its state moves. The 5-minute sweeps catch what a crash cut off.
  worker.onCompleted(async (job) => {
    const log = (what: string) => (error: unknown) =>
      reportError(db, what, error);
    rolling.drain().catch(log("rolling"));
    excerpts.job(job.id).catch(log("excerpts"));
    await nudge("transcript", { job: job.id });
    states.refresh();
  });
  // The Mac woke up or came back: what waits for it runs now.
  mac.onAble(() => {
    rolling.drain();
  });
  // A raw-page source regrouped: as after the iPhone's timeline.
  pages.onRegrouped(() => {
    rolling.drain();
    states.refresh();
  });
  // The Mac's word can move its watermark: blocks and jobs held for it go now (cutter.ts, jobs.ts
  // `claim`).
  mac.onState(() => {
    worker.poke();
    // A thin phone's audio waits to be labeled until the Mac vouches for it (page-labels.ts).
    pages.poke();
  });
  return {
    audio,
    config,
    db,
    excerpts,
    health,
    intelligence,
    mac,
    morning,
    notice,
    nudge,
    pages,
    queue,
    restic,
    rolling,
    search,
    states,
    voices,
    worker,
  };
}

export type Services = ReturnType<typeof services>;
