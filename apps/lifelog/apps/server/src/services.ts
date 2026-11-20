import { type QueueCache, queueCache } from "./naming-cache";
// Everything the routes and the background loops share, built once: index.ts serves it, the
// tests override parts of it, scripts/openapi.ts only reads the routes it gives.

import { clock } from "@life/server/src/core/clock";
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
import { type PageProcessor, pageProcessor } from "./page-processing";
import { type VoiceUpkeep, voiceUpkeep } from "./people";
import { processingLimit, settlePhoneDictations } from "./phone-dictations";
import { macProvider, type Provider } from "./providers";
import { type Restic, resticFor } from "./restic";
import { type Rolling, rollingVoices } from "./rolling";
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
    // Up to when pendant audio may be labeled, cut and sent: the Mac's watermark, held back by a
    // phone dictation (phone-dictations.ts).
    limit = processingLimit(db, mac),
    // The one sender of jobs to ElevenLabs, from the bucket; it first closes the phone's speech
    // fragments into blocks (cutter.ts).
    worker = jobWorker(db, config, audio, limit),
    // Summaries run only on the Mac, on the owner's Max plan; never on a paid API.
    intelligence = macProvider(mac, () => !switches().ai),
    // Tells the phone a transcript or summary is ready (a silent push to the same app).
    nudge = phoneNudger(db, apns, config.APNS_TOPIC),
    // The voices to name.
    queue = queueCache(db),
    // A visible push another app of the owner's asks for (Life: each voice ask it heard).
    notice = phoneNotice(db, apns, config.APNS_TOPIC),
    // The voices read, window by window as conversations go on, on the Mac.
    rolling = rollingVoices(db, { mac: intelligence, nudge }),
    // At Lifelog Host's embedder, which index.ts passes; none for tests, so none calls it.
    search = null,
    voices = voiceUpkeep(db),
    // Cuts a job's clean turns from its bucket audio and embeds them (rebuild P3). Summaries
    // name speakers when read, so recognition starts nothing.
    excerpts = excerptSampler(db, config, audio, limit),
    // The archive's invariants, hourly, with an email to the owner when one breaks.
    health = healthWatch(db, config),
    // The daily restic snapshot, when RESTIC_* is set.
    restic = resticFor(db, config),
    // A thin phone's raw pages, labeled and cut into speech fragments here.
    pages = pageProcessor(db, audio, worker, {
      limit: (sourceId) => limit(sourceId).getTime(),
    }),
  }: {
    apns?: Pusher | null;
    audio?: AudioStore;
    excerpts?: ExcerptSampler;
    health?: HealthWatch;
    intelligence?: Provider | null;
    limit?: (sourceId: string | null) => Date;
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
  // conversation's voices are read, its clean turns are cut and recognized, the phone hears of it,
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
  // The processing limit may have moved: blocks and jobs held for it go now (cutter.ts, jobs.ts
  // `claim`), and a thin phone's audio held from labeling (page-labels.ts).
  const limitMoved = () => {
    worker.poke();
    pages.poke();
  };
  // The Mac's word can move its watermark.
  mac.onState(limitMoved);
  // Each phone dictation still open ends at its cap, timed here: those past it end now, and the
  // next cap is timed. Wakes nothing.
  let capTimer: ReturnType<typeof setTimeout> | undefined;
  const settleDictations = () => {
    const { next } = settlePhoneDictations(db);
    clearTimeout(capTimer);
    if (next !== null) {
      capTimer = setTimeout(dictationChanged, next - clock().getTime());
      capTimer.unref();
    }
  };
  // A dictation opened, closed or at its cap: settled, and what waited on the limit goes.
  const dictationChanged = () => {
    settleDictations();
    limitMoved();
  };
  return {
    audio,
    config,
    db,
    // A phone dictation opened or closed (routes/dictation.ts).
    dictationChanged,
    excerpts,
    health,
    intelligence,
    mac,
    notice,
    nudge,
    pages,
    queue,
    restic,
    rolling,
    search,
    // At the server's start (index.ts), before any work: dictations past their cap end, the next
    // cap is timed, and nothing wakes; the first tick reads the credits before it sends.
    settleDictations,
    states,
    voices,
    worker,
  };
}

export type Services = ReturnType<typeof services>;
