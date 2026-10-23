import type { AuthSettings } from "@life/voice-auth";
import { z } from "zod";

// Prices from docs/voice/research/elevenlabs.md (live pricing page, 2026-10-07).
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
// An IANA name Intl knows, never an offset ("+07:00"): the owner's days follow the zone's rules.
const ZONE_NAME = /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$/;
export function isTimeZone(zone: string) {
  try {
    // Throws a RangeError for a zone it doesn't know.
    return (
      ZONE_NAME.test(zone) &&
      Boolean(new Intl.DateTimeFormat("en", { timeZone: zone }))
    );
  } catch {
    return false;
  }
}
let ownerZone = DEFAULT_TIME_ZONE;
export const ownerTimeZone = () => ownerZone;
export const setOwnerTimeZone = (zone: string | null | undefined) => {
  ownerZone = zone && isTimeZone(zone) ? zone : DEFAULT_TIME_ZONE;
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
  // Average cosine to the voices of an unnamed group (or to one unnamed voice) to join it.
  // 0.6 kept one person's 15 voices together and nobody else on Oct 10–11.
  candidateThreshold: 0.6,
  closedSetTurn: 0.4, // several people, none but the owner's picks
  // Unnamed voice data (embeddings that are nobody's evidence) is deleted after this.
  keepDays: 30,
  // Lead over the runner-up person; anything closer is ambiguous, so unknown.
  margin: 0.1,
  // Cosine to a person's profile centroid needed for a match.
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
  // A voice that matches no profile takes the person of a voice at least `nearbyVoice` alike in
  // another recording within `nearbyMinutes`: same room, same microphone. Of 414 pairs of
  // different named people that close on Oct 13, none reached 0.70; 330 of 605 same-person
  // pairs did. A reference is a voice the owner named or a profile match of at least
  // `nearbyReference`: a guest at the Oct 11 dinner matched a friend's thin profile at 0.60 and
  // would have passed her name on.
  nearbyMinutes: 45,
  nearbyReference: 0.65,
  nearbyVoice: 0.7,
  // A sample scoring at most this against a voice is someone else's: the owner's own samples
  // never scored under 0.27 against his profile. A queue card plays such a clip last.
  notThem: 0.2,
  // An evidence clip whose cosine to the rest of its profile is below `outlierFit`, and at
  // least `outlierLead` closer to another person, is left out of the centroid (kept as evidence).
  outlierFit: 0.35,
  outlierLead: 0.15,
  ownerProfileCap: 60,
  // A turn under `shortTurnSeconds` is his at `ownerShortTurn` when also `margin` ahead of the next
  // person: short clips score lower against his profile. Oct 15 replay on his corrections, turns
  // under 6 s: his named went from 9 to 16 of 22, others' given him stayed 1 of 203; his lone short
  // requests that day scored 0.38 to 0.48 with leads of 0.17 or more.
  ownerShortTurn: 0.4,
  // A turn whose own voice is nearest the owner's, at this or more, is his (speakers.ts). Oct 14
  // dry run: 2 of 319 turns of other named people reached 0.5, and the owner confirmed by ear all
  // 26 turns it moved; on his corrections it named 86% of his sampled turns and gave him 1 of
  // 342 others' turns.
  ownerTurn: 0.5,
  perConversation: 8,
  // Evidence that counts per profile: the clips closest to it, at most `perConversation` from
  // one conversation.
  profileCap: 40,
  shortTurnSeconds: 6,
} as const;

// Voice excerpts the server cuts from a job's bucket audio (excerpts.ts, docs/voice/processing.md).
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
  // The voices to name are those of the last queueDays: voice data that isn't evidence is
  // deleted after 30 days, so older voices have nothing left to play or learn from.
  queueDays: 30,
  quoteChars: 200,
  quotes: 3,
} as const;

// USD per million input tokens of embedding models (OpenAI pricing page, 2026-10-08).
export const EMBEDDING_USD_PER_MTOK: Record<string, number> = {
  "text-embedding-3-large": 0.13,
};

// Search by meaning.
// ponytail: first guesses; tune on real EN/FR/TH queries.
export const SEARCH = {
  // An identical query reuses its embedding this long (an in-memory cache of this many).
  cacheEntries: 200,
  cacheMinutes: 10,
  // Characters of a passage that are embedded; keyword matching reads all of it.
  embedChars: 6000,
  // Score weights: cosine similarity, plus keyword similarity, plus the boost for a
  // passage containing the query as typed, so exact names win.
  exactBoost: 1,
  lexicalWeight: 0.5,
  // Below this a hit is noise.
  minScore: 0.3,
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
  // The app's bundle id (LIFE_BUNDLE_ID in apps/ios/project.yml).
  APNS_TOPIC: z.string().min(1).default("com.ericedouard.lifelog"),
  // Where audio is kept without a bucket (audio-store.ts); the S3_* settings win when set.
  AUDIO_DIR: z.string().min(1).optional(),
  // Signs Life's OAuth tokens (@life/voice-auth). Life's sign-in is off without it and LIFE_URL.
  AUTH_SECRET: z.string().min(32).optional(),
  // The build's git commit, which Voice Host passes from its Info.plist; names the build in
  // server error reports.
  BUILD_SHA: z.string().optional(),
  // A reader's tokens (docs/voice/voice-source.md), minted by `bun run mint-token read|corrections`:
  // `read` opens the contract's reads, `corrections` those and the owner's corrections.
  CORRECTIONS_TOKEN_HASH: TokenHash.optional(),
  // The archive's SQLite file (@life/voice-db), created and migrated at boot.
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
  // Search by meaning uses OPENAI_API_KEY; without it only the app's keyword search works.
  EMBEDDING_MODEL: z.string().min(1).default("text-embedding-3-large"),
  // The speaker embedding service (apps/speech), with the same IDENTITY_SECRET as that service.
  // Recognition is unavailable without it.
  IDENTITY_SECRET: z.string().min(16).optional(),
  IDENTITY_URL: z.url().optional(),
  // Life's address (@life/voice-auth): LIFE_URL/mcp is its tokens' audience, LIFE_URL/check/callback a
  // trusted OAuth callback. Life's sign-in is off without it.
  LIFE_URL: z.url().optional(),
  // The address the server listens on; every interface without it. The Mac host sets 127.0.0.1,
  // so only Tailscale Serve reaches it.
  LISTEN_HOST: z.string().min(1).optional(),
  // The Mac helper's token (apps/dictation), minted by `bun run mint-token mac`. It opens only
  // the Mac's socket (mac-socket.ts); without it the socket refuses everyone.
  MAC_TOKEN_HASH: TokenHash.optional(),
  OPENAI_API_KEY: z.string().min(1).optional(),
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

// Life's OAuth issuer's settings (@life/voice-auth).
export const authSettings = (config: Config): AuthSettings => ({
  baseUrl: config.PUBLIC_BASE_URL,
  lifeUrl: config.LIFE_URL,
  secret: config.AUTH_SECRET,
});

export const loadConfig = (env: Record<string, string | undefined>): Config =>
  Env.parse(env);

/** The config, or the names of the variables it lacks or can't read (never their values). */
export function configOf(
  env: Record<string, string | undefined>
): { config: Config } | { issues: string } {
  const read = Env.safeParse(env);
  return read.success
    ? { config: read.data }
    : { issues: read.error.issues.map((i) => i.path.join(".")).join(", ") };
}

// Token hashes (DEVICE_TOKEN_HASH and the others) and audio hashes; `Sha256` is one, as sent.
export const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);
export const sha256Hex = (data: string | ArrayBuffer | Uint8Array) =>
  new Bun.CryptoHasher("sha256").update(data).digest("hex");

// A uuid that is the same for the same text (version 8, from its sha256): ids derived from a key.
export const uuidOf = (text: string) => {
  const h = sha256Hex(text);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

// Runs `work` and logs, never throws, what it throws: a background step whose failure is only
// reported. (Async work does the same with `.catch`.)
export function logged(what: string, work: () => void) {
  try {
    work();
  } catch (error: unknown) {
    console.error(`${what}: ${String(error)}`);
  }
}

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
