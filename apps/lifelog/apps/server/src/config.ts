import { isTimeZone } from "@life/server/src/core/time-zone";
import { z } from "zod";

// Prices from docs/research/elevenlabs.md (live pricing page, 2026-10-07).
// The API reference prices keyterms at +20% ($0.044/h); the higher figure is used.
export const SCRIBE_V2_USD_PER_HOUR = 0.22;
const KEYTERMS_USD_PER_HOUR = 0.05;

// Seconds at the base Scribe rate that this audio will cost, add-ons included.
export const billableSeconds = (seconds: number, s: { keyterms: string[] }) =>
  (seconds *
    (SCRIBE_V2_USD_PER_HOUR +
      (s.keyterms.length > 0 ? KEYTERMS_USD_PER_HOUR : 0))) /
  SCRIBE_V2_USD_PER_HOUR;

// Days, months (spending) and clock times are the owner's: the zone the
// iPhone named in its latest heartbeat (`refreshOwnerTimeZone`), UTC until it has named one.
export const DEFAULT_TIME_ZONE = "UTC";
let ownerZone = DEFAULT_TIME_ZONE;
export const ownerTimeZone = () => ownerZone;
export const setOwnerTimeZone = (zone: string | null | undefined) => {
  ownerZone = zone && isTimeZone(zone) ? zone : DEFAULT_TIME_ZONE;
};

// The build server errors name (`storeServerError`): BUILD_SHA's commit, set at start (index.ts).
let build = "dev";
export const serverBuild = () => build;
export const setServerBuild = (sha: string | undefined) => {
  build = sha?.slice(0, 7) ?? "dev";
};

// The owner's local date ("2026-10-11") and hour at `at`.
export function ownerClock(at: Date) {
  const zone = ownerTimeZone();
  return {
    date: at.toLocaleDateString("en-CA", { timeZone: zone }),
    hour: Number(
      at.toLocaleString("en-GB", {
        hour: "2-digit",
        hourCycle: "h23",
        timeZone: zone,
      })
    ),
  };
}

// Speaker recognition.
// ponytail: placeholder values; calibrate on real Pendant conversations (mixed languages,
// overlap, distance to the mic) before trusting a match.
export const RECOGNITION = {
  // A voice is scored against a person's closest conversations, this many (speakers.ts `likeness`).
  bestExemplars: 2,
  // Average cosine to the voices of an unnamed group (or to one unnamed voice) to join it.
  // 0.6 kept one person's 15 voices together and nobody else on Oct 10–11.
  candidateThreshold: 0.6,
  closedSetTurn: 0.4, // several people, none but the owner's picks
  // Lead over the runner-up person; anything closer is ambiguous, so unknown.
  margin: 0.1,
  // Likeness to a person (speakers.ts `likeness`) needed for a match. Nov 3 replay on his answers:
  // other people's voices 269 named right and 15 wrong (217 and 9 by centroid), 6 voices he didn't
  // know named (10); 0.65 named 247 right and 12 wrong.
  matchThreshold: 0.6,
  // A turn holding a word longer than this isn't a clean excerpt: the provider stretched the
  // word over speech it didn't transcribe (someone else, a TV). Under 0.1% of words, but those
  // turns made up 12% of voice-sample audio (Oct 13, 14 days): longest turns are sampled first.
  maxWordSeconds: 3,
  // Evidence clips shorter than this don't count toward a profile: they fit their own
  // profile poorly.
  minEvidenceSeconds: 3,
  // Clean speech a speaker needs in a conversation before matching is attempted.
  minSpeakerSeconds: 8,
  // Shortest turn accepted as a clean excerpt.
  minTurnSeconds: 1.5,
  // A voice refused for its margin takes its nearest person when that person is named nearby
  // and leads everyone else named nearby by this much (speakers.ts `nearbyMatch`). Nov 3 replay
  // of his answers: 36 more voices named right, 1 he didn't know and 2 wrong; at 0.1, 46 right
  // and 6 not; at 0.12, 43 and 4.
  nearbyMargin: 0.15,
  // A voice that matches no profile takes the person of a voice at least `nearbyVoice` alike in
  // the same conversation: same room, same microphone. Of 414 pairs of
  // different named people that close on Oct 13, none reached 0.70; 330 of 605 same-person
  // pairs did. A reference is a voice the owner named or a profile match of at least
  // `nearbyReference`: a guest at the Oct 11 dinner matched a friend's thin profile at 0.60 and
  // would have passed her name on. By likeness (Nov 3 replay) 331 voices are references and 19 of them
  // wrong (by centroid 257 and 21).
  nearbyReference: 0.65,
  nearbyVoice: 0.7,
  // A sample scoring at most this against a voice is someone else's: the owner's own samples
  // never scored under 0.27 against his profile (by centroid; likeness runs higher, so this is
  // looser). A queue card plays such a clip last.
  notThem: 0.2,
  // A turn under `shortTurnSeconds` is his at `ownerShortTurn` when also `margin` ahead of the next
  // person: short clips score lower against his profile. A turn whose own voice is nearest the
  // owner's, at `ownerTurn` or more, is his (speakers.ts). Nov 3 replay on his answers, scored by
  // likeness to his closest conversations: 330 of his 358 sampled turns named, and 155 turns of
  // voices he named as someone else given him, as many as the single centroid gave at 0.5 and 0.4.
  ownerShortTurn: 0.5,
  ownerTurn: 0.6,
  shortTurnSeconds: 6,
  // A voice this much more like the strangers (his "Not anyone I know" answers) than like the person,
  // and at least `candidateThreshold` like them, is a stranger too (speakers.ts `decide`; a turn
  // needs only the lead). Nov 3 replay of his answers: 16 fewer turns credited to
  // him and 2 fewer to someone else they weren't, no right name lost; 0.03 and under lose some, 0.07
  // catches fewer.
  strangerLead: 0.05,
} as const;

// Voice excerpts the server cuts from a job's bucket audio (excerpts.ts, docs/processing.md).
export const EXCERPTS = {
  // Longest clean turns first, at most this many per job (a block holds 5 minutes of speech), each
  // cut to its first `maxSeconds`.
  maxPerJob: 200,
  maxSeconds: 30,
} as const;

// The voices to name and their morning push (naming-queue.ts). Values from Oct 10–11.
export const NAMING = {
  // A card plays up to `clips` clean turns of its voice, 5 to 20 s preferred, cut at 20 s.
  clipMinSeconds: 5,
  clipSeconds: 20,
  clips: 3,
  // The morning push goes out from this hour in the owner's zone.
  hour: 8,
  // A card needs this many turns traded with the owner and this much talk; anything less is a
  // stranger.
  minExchanges: 10,
  minSeconds: 60,
  // This many words unlocks a card even without exchanges with the owner.
  minWords: 300,
  quoteChars: 200,
  quotes: 3,
} as const;

// Search by meaning (search.ts). Measured on the owner's French, English and Thai queries (5 Nov 2026).
export const SEARCH = {
  // A passage closes once its turns span this long or hold this much text, and never
  // grows past maxSeconds (a single longer turn stays whole).
  passageChars: 1500,
  passageMaxSeconds: 60,
  passageMinSeconds: 30,
} as const;

// sha256 hex of a bearer token (`bun run mint-token`): only the hash is in the env.
const TokenHash = z.string().regex(/^[0-9a-f]{64}$/);

const Env = z.object({
  // Archive alerts (alert.ts), through Resend: from ALERT_EMAIL_FROM (`Name <alerts@your.domain>`, a
  // domain verified there) to ALERT_EMAIL_TO. No alert email without both and RESEND_API_KEY.
  ALERT_EMAIL_FROM: z.string().min(1).optional(),
  ALERT_EMAIL_TO: z.email().optional(),
  // Pushes to the phone (apns.ts), with a token-based .p8 key. Without the key nothing is
  // pushed. The owner's builds are development-signed, so their tokens are sandbox tokens.
  APNS_ENVIRONMENT: z.enum(["sandbox", "production"]).default("sandbox"),
  APNS_KEY_ID: z.string().min(1).optional(),
  // The .p8 file's contents.
  APNS_PRIVATE_KEY: z.string().min(1).optional(),
  APNS_TEAM_ID: z.string().min(1).optional(),
  // The app's bundle id (LIFELOG_BUNDLE_ID in apps/ios/project.yml).
  APNS_TOPIC: z.string().min(1).default("com.ericedouard.lifelog"),
  // Where audio is kept without a bucket (audio-store.ts); the S3_* settings win when set.
  AUDIO_DIR: z.string().min(1).optional(),
  // The build's git commit, which Lifelog Host passes from its Info.plist; names the build in
  // server error reports.
  BUILD_SHA: z.string().optional(),
  // A reader's tokens (docs/voice-source.md), minted by `bun run mint-token read|corrections`:
  // `read` opens the contract's reads, `corrections` those and the owner's corrections.
  CORRECTIONS_TOKEN_HASH: TokenHash.optional(),
  // The archive's SQLite file (@lifelog/db), created and migrated at boot.
  DATABASE_PATH: z.string().min(1),
  // sha256 hex of the owner's device token (`bun run mint-token`); the token itself is only in
  // the iPhone's Keychain.
  DEVICE_TOKEN_HASH: TokenHash,
  ELEVENLABS_API_KEY: z.string().min(1),
  ELEVENLABS_BASE_URL: z.url().default("https://api.elevenlabs.io"),
  // How many jobs this server has at ElevenLabs at once (the plan runs 20; a 5-minute block takes
  // one). The rest is headroom.
  ELEVENLABS_SLOTS: z.coerce.number().int().min(1).default(10),
  ELEVENLABS_WEBHOOK_ID: z.string().min(1).optional(),
  // From the ElevenLabs webhook ("Transcription completed") at ${PUBLIC_BASE_URL}/webhooks/elevenlabs;
  // ELEVENLABS_WEBHOOK_ID sends results to that webhook only. Without this secret, no webhook:
  // each send waits for its transcript in the answer, for a host the internet can't reach. A
  // restart during that wait leaves the send maybe billed and its block untranscribed.
  ELEVENLABS_WEBHOOK_SECRET: z.string().min(1).optional(),
  // The speaker embedding service (apps/identity), with the same IDENTITY_SECRET as that service.
  // Recognition is unavailable without it.
  IDENTITY_SECRET: z.string().min(16).optional(),
  IDENTITY_URL: z.url().optional(),
  // The address the server listens on; every interface without it. The Mac host sets 127.0.0.1,
  // so only Tailscale Serve reaches it.
  LISTEN_HOST: z.string().min(1).optional(),
  // The Mac helper's token (apps/mac-quiet), minted by `bun run mint-token mac`. It opens only
  // the Mac's socket (mac-socket.ts); without it the socket refuses everyone.
  MAC_TOKEN_HASH: TokenHash.optional(),
  // The voice map, its clips and naming answers only.
  MAP_TOKEN_HASH: TokenHash.optional(),
  PORT: z.coerce.number().int().default(3000),
  PUBLIC_BASE_URL: z.url(),
  READ_TOKEN_HASH: TokenHash.optional(),
  RESEND_API_KEY: z.string().min(1).optional(),
  // The daily restic backup (restic.ts), all three or none: the restic executable, the repository
  // (a path or URL) and its password. The Mac host sets them.
  RESTIC_BINARY: z.string().min(1).optional(),
  RESTIC_PASSWORD: z.string().min(1).optional(),
  RESTIC_REPOSITORY: z.string().min(1).optional(),
  // The bucket that keeps every job's audio (audio-store.ts): all five, or none and AUDIO_DIR.
  // Tests keep the audio in memory.
  S3_ACCESS_KEY_ID: z.string().min(1).optional(),
  S3_BUCKET: z.string().min(1).optional(),
  S3_ENDPOINT: z.url().optional(),
  S3_REGION: z.string().min(1).optional(),
  S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
});

export type Config = z.infer<typeof Env>;

export const loadConfig = (env: Record<string, string | undefined>): Config =>
  Env.parse(env);

// Token hashes (DEVICE_TOKEN_HASH and the others) and audio hashes; `Sha256` is one, as sent.
export const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);
export const sha256Hex = (data: string | ArrayBuffer | Uint8Array) =>
  new Bun.CryptoHasher("sha256").update(data).digest("hex");

// A uuid that is the same for the same text (version 8, from its sha256): ids derived from a key.
export const uuidOf = (text: string) => {
  const h = sha256Hex(text);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

// One run per key at a time: a call while one runs makes it go round once more after it, and waits
// for that. `idle` resolves once none runs. ponytail: in memory, one replica, like every loop here.
export function singleFlight<K = void>(round: (key: K) => Promise<void>) {
  const runs = new Map<K, Promise<void>>();
  const again = new Set<K>();
  const start = (key: K): Promise<void> => {
    const running = runs.get(key);
    if (running) {
      again.add(key);
      return running;
    }
    // The run leaves `runs` in the same step as its last check of `again`: a call in between
    // would join a run that is over.
    const run = (async () => {
      try {
        do {
          // biome-ignore lint/performance/noAwaitInLoops: one round after the other
          await round(key);
        } while (again.delete(key));
      } finally {
        runs.delete(key);
        again.delete(key);
      }
    })();
    runs.set(key, run);
    return run;
  };
  const idle = () =>
    Promise.all([...runs.values()].map((r) => r.catch(() => undefined)));
  return Object.assign(start, { idle });
}
