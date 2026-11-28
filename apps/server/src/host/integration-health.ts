// An integration's health, worked out when read from what a read already holds (`IntegrationFacts`, gathered by
// `host/integrations.ts`): its state, the one word for its card and, when it waits on the user or is broken, why in plain
// words. Pure: no reads, no clock; the tone rule is the status card's (`toneOf`).

import { daysBefore, HOUR } from "../core/clock";
import { dayStart, wall } from "../memory/zones";
import type { AccessCheck, Requirement } from "../records/integration";
import type { Newest } from "../sources/contract";
import type { Tone } from "./status/card";

/** Received within this, a source reads as live. */
const LIVE_MS = HOUR;

/** A source's tone: live, quiet, or silent past its limit. */
export function toneOf(
  at: string | null | undefined,
  limit: number,
  now: number
): { tone: Tone; word: string } {
  if (!at) {
    return { tone: "idle", word: "nothing yet" };
  }
  const quiet = now - Date.parse(at);
  if (quiet < LIVE_MS) {
    return { tone: "ok", word: "receiving" };
  }
  return quiet < limit
    ? { tone: "idle", word: "quiet" }
    : { tone: "warn", word: "silent" };
}

/** When a source last heard anything, or for one with parts (the bridged networks) its quietest part: one quiet network shows. */
export const quietestAt = (n: Newest) =>
  n.parts?.length
    ? n.parts.map((p) => p.at).reduce((a, b) => (a < b ? a : b))
    : n.at;

/**
 * Waking hours, when the Pendant is expected to hear him: 08:00 to 01:00 on the Mac's clock (.claude/rules/one-way.md), in `tz` (the
 * Mac's zone read now, `systemZone`: a long-running process's own zone can be the one it started in).
 */
export const waking = (d: Date, tz: string | undefined) => {
  const hour = wall(d.toISOString(), tz).hms.slice(0, 2);
  return hour >= "08" || hour < "01";
};

/** When the waking hours `d` falls in began (08:00, the day before after midnight); null outside them. */
export function wokeAt(d: Date, tz: string | undefined) {
  if (!waking(d, tz)) {
    return null;
  }
  const { day, hms } = wall(d.toISOString(), tz);
  return dayStart(hms < "01" ? daysBefore(day, 1) : day, tz, "08:00");
}

/** The phone reports at least every 6 h while its app runs: silent twice as long, the app or its way to the voice server is down. */
export const PHONE_SILENT_MS = 12 * HOUR;

export type IntegrationState =
  | "off"
  | "waiting_on_user"
  | "connecting"
  | "working"
  | "broken";

/** An integration's state, decided once (`integrationHealthOf`): `why` in plain words for waiting_on_user and broken; `tone` and `word` are the status card's reading of it. */
export interface IntegrationHealth {
  state: IntegrationState;
  tone: Tone;
  why?: string;
  word: string;
}

/** A requirement with whether it is met now. */
export type MetRequirement = Requirement & { done: boolean };

/** What an integration's health reads (the reads are the caller's, `host/integrations.ts`). */
export type IntegrationFacts = {
  on: boolean;
  requirements: readonly MetRequirement[];
  /** What keeps it from being read now (`Descriptor.missing`), none when it can be. */
  missing?: string;
} & (
  | {
      kind: "source";
      imported?: boolean;
      read: { ok: true; at: string | null } | { ok: false; error: string };
      storeFailing?: string;
      bridgeDown?: string;
      silentAfter: number;
      now: number;
    }
  | {
      kind: "pendant";
      readable: boolean;
      heardAt: string | null;
      silentAfter: number;
      now: number;
      phoneSilent: boolean;
      recording: boolean;
    }
  | { kind: "ai"; online: boolean; host: string }
  | { kind: "voice"; answering: boolean; line: string }
  | { kind: "google" }
);

/** An integration's state, in the order the user meets it: off, a requirement missing, not readable, then by kind. */
export function integrationHealthOf(f: IntegrationFacts): IntegrationHealth {
  if (!f.on) {
    return { state: "off", tone: "idle", word: "off" };
  }
  const unmet = f.requirements.find((r) => !r.done);
  if (unmet) {
    return {
      state: "waiting_on_user",
      tone: "bad",
      why: requirementWhyOf(unmet),
      word: "can't read",
    };
  }
  if (f.missing) {
    const why = f.missing;
    return f.kind === "source" && f.imported
      ? { state: "waiting_on_user", tone: "idle", why, word: "not imported" }
      : { state: "waiting_on_user", tone: "bad", why, word: "can't read" };
  }
  switch (f.kind) {
    case "source":
      return sourceHealthOf(f);
    case "pendant":
      return pendantHealthOf(f);
    case "ai":
      return aiHealthOf(f);
    case "google":
      // Signed out, its sign-in requirement has already stopped it: here it reads his Google accounts.
      return { state: "working", tone: "ok", word: "connected" };
    default:
      return voiceHealthOf(f);
  }
}

/** The facts of one kind of integration, narrowed. */
type SourceFacts = Extract<IntegrationFacts, { kind: "source" }>;
type PendantFacts = Extract<IntegrationFacts, { kind: "pendant" }>;
type AiFacts = Extract<IntegrationFacts, { kind: "ai" }>;
type VoiceFacts = Extract<IntegrationFacts, { kind: "voice" }>;

/** A source's health: unreadable or bridge down is broken, nothing yet is connecting, else its tone. */
function sourceHealthOf(f: SourceFacts): IntegrationHealth {
  if (f.storeFailing) {
    return {
      state: "broken",
      tone: "bad",
      why: f.storeFailing,
      word: "unreadable",
    };
  }
  if (!f.read.ok) {
    return {
      state: "broken",
      tone: "bad",
      why: f.read.error,
      word: "unreadable",
    };
  }
  if (f.bridgeDown) {
    return {
      state: "broken",
      tone: "bad",
      why: f.bridgeDown,
      word: "bridge down",
    };
  }
  if (f.read.at === null) {
    return { state: "connecting", tone: "idle", word: "nothing yet" };
  }
  const t = toneOf(f.read.at, f.silentAfter, f.now);
  return { state: "working", tone: t.tone, word: t.word };
}

/** The pendant's health: the phone silent or the store unreadable is broken; silent while recording is amber. */
function pendantHealthOf(f: PendantFacts): IntegrationHealth {
  if (f.phoneSilent) {
    return {
      state: "broken",
      tone: "bad",
      why: "Your phone hasn't reported to this computer for 12 hours.",
      word: "phone not reporting",
    };
  }
  if (!f.readable) {
    return {
      state: "broken",
      tone: "bad",
      why: "Can't read what the pendant heard.",
      word: "unreadable",
    };
  }
  const quiet = toneOf(f.heardAt, f.silentAfter, f.now);
  if (f.recording && quiet.tone === "warn") {
    return { state: "working", tone: "warn", word: "silent" };
  }
  if (f.recording) {
    return { state: "working", tone: "ok", word: "recording" };
  }
  if (quiet.word === "nothing yet") {
    return { state: "connecting", tone: quiet.tone, word: quiet.word };
  }
  return { state: "working", tone: quiet.tone, word: quiet.word };
}

/** The AI's health: offline when its host can't be reached, else ready. */
function aiHealthOf(f: AiFacts): IntegrationHealth {
  return f.online
    ? { state: "working", tone: "ok", word: "ready" }
    : {
        state: "broken",
        tone: "bad",
        why: `Can't reach ${f.host}: no internet, or it is down.`,
        word: "offline",
      };
}

/** The voice engine's health: running while it answers, else broken with its own line. */
function voiceHealthOf(f: VoiceFacts): IntegrationHealth {
  return f.answering
    ? { state: "working", tone: "ok", word: "running" }
    : { state: "broken", tone: "bad", why: f.line, word: "not answering" };
}

/** What each permission's requirement asks him to do, in plain words. */
const PERMISSION_WHY: Record<AccessCheck, string> = {
  accessibility: "Turn on Accessibility for Life in System Settings.",
  calendars: "Allow Life to use Calendars.",
  contacts: "Allow Life to use Contacts.",
  disk_free: "Free some disk space on this computer.",
  full_disk_access: "Turn on Full Disk Access for Life in System Settings.",
  photos: "Allow Life to use Photos.",
};

/** What each sign-in's requirement asks him to do, in plain words. */
const SIGN_IN_WHY: Record<"google" | "network" | "claude", string> = {
  claude: "Sign in to Claude.",
  google: "Sign in with Google.",
  network: "Sign in from your phone.",
};

/** A requirement not met, in plain words: what he does to meet it. */
function requirementWhyOf(r: Requirement): string {
  if (r.kind === "permission") {
    return PERMISSION_WHY[r.check];
  }
  if (r.kind === "sign_in") {
    return SIGN_IN_WHY[r.with];
  }
  if (r.kind === "key") {
    return `Add your key from ${new URL(r.opens).host}.`;
  }
  if (r.kind === "credits") {
    return "Add credits on OpenRouter.";
  }
  if (r.kind === "install") {
    return "Install Claude Code.";
  }
  return r.what === "phone"
    ? "Pair your phone with this computer."
    : "Pair your pendant in the phone app.";
}
