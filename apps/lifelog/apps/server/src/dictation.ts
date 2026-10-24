// Turns the Mac helper's raw facts (which processes have the microphone on, sleep and wake: its
// socket, mac-socket.ts) into quiet ranges, the owner's rules of 10 October 2026: only the
// dictation apps below count; dictations less than MERGE_GAP_MS apart are one; each range is
// padded BEFORE_MS and AFTER_MS; one longer than MAX_MS (a stuck flag) or cut by sleep is dropped.
// A flag on past MAX_MS stops holding the watermark at once, and nothing counts until it goes off.
// A cancelled dictation can't be told apart, so it counts like any other. Pure: the socket keeps
// the state in `mac_watch` (quiet-ranges.ts `applyMacEvent`).
import type { Dictation } from "@lifelog/db/schema";

const BEFORE_MS = 1000;
const AFTER_MS = 1500;
const MERGE_GAP_MS = 5000;
const MAX_MS = 10 * 60_000;

// Apps whose microphone means the owner is talking to the Mac: dictation apps and the AI apps'
// voice input. Their helper processes count too ("com.electron.wispr-flow.helper"). A process
// with no bundle id (a command-line tool) goes by its name. Calls (FaceTime, WhatsApp, browsers)
// stay out: those are conversations.
//
// `com.apple.CoreSpeech` (macOS dictation and Siri) is out since 14 October: it holds the
// microphone for hours while nobody dictates, so the stuck-flag rule dropped the FluidVoice
// dictations inside, and the Pendant heard less speech in its ranges than anywhere else. Codex's
// `system-audio-spectrum` is its audio visualizer, not voice input.
const DICTATION_APPS = [
  "com.FluidApp.app",
  "com.electron.wispr-flow",
  "com.pais.handy",
  "com.superduper.superwhisper",
  // Claude, ChatGPT (whose app is now `com.openai.codex`) and Codex, and Claude Code's `/voice`.
  "com.anthropic.claudefordesktop",
  "com.openai.chat",
  "com.openai.codex",
  "claude",
];
const NOT_VOICE = ["com.openai.codex.system-audio-spectrum"];

// A Windows helper names a process by its image, `*.exe`, matched case-insensitively against this
// table only (no prefix rule: "claude.exe" is here on purpose). Over-matching holds audio, which is
// the safe side of "dictation is never processed"; under-matching processes dictation. So an app
// that may be voice input is in. Each name: verify on a real Windows PC.
const WINDOWS_DICTATION_APPS = [
  "claude.exe", // Claude desktop's voice input; Claude Code's `/voice` too.
  "chatgpt.exe", // ChatGPT desktop's voice input.
  "codex.exe", // Codex desktop and CLI.
  "wispr flow.exe", // Wispr Flow.
  "wisprflow.exe", // Wispr Flow, another spelling of its image.
  "superwhisper.exe", // Superwhisper, if its Windows build exists.
  "handy.exe", // Handy.
  "textinputhost.exe", // Windows' own voice typing.
];

export const isDictationApp = (name: string) =>
  name.toLowerCase().endsWith(".exe")
    ? WINDOWS_DICTATION_APPS.includes(name.toLowerCase())
    : !NOT_VOICE.includes(name) &&
      DICTATION_APPS.some((app) => name === app || name.startsWith(`${app}.`));

// What the Mac reports, times in epoch ms: the processes capturing (bundle ids, or names for
// tools without one) whenever that set changes, and sleep. Its hello is the wake.
export type MacReport =
  | { at: number; capturing: string[]; kind: "mic" }
  | { at: number; kind: "sleep" };
export type MacEvent = MacReport | { at: number; kind: "wake" };

export interface DictatedRange {
  endedAt: number;
  source: string;
  startedAt: number;
}

export const idle: Dictation = {
  asleep: false,
  blockedSince: null,
  finished: null,
  interrupted: false,
  lostFrom: null,
  open: null,
};

interface Step {
  ranges: DictatedRange[];
  state: Dictation;
}

// The finished dictation, padded, once MERGE_GAP_MS has passed with no other (`force`: now, for
// sleep); none while it may still grow, or when it lasted over MAX_MS.
const flush = (state: Dictation, now: number, force = false): Step => {
  const done = state.finished;
  if (!done || (!force && now - done.end < MERGE_GAP_MS)) {
    return { ranges: [], state };
  }
  const ranges =
    done.end - done.start <= MAX_MS
      ? [
          {
            endedAt: done.end + AFTER_MS,
            source: done.source,
            startedAt: done.start - BEFORE_MS,
          },
        ]
      : [];
  return { ranges, state: { ...state, finished: null } };
};

// Time passing to `now`: a waiting dictation is flushed, a flag on past MAX_MS is let go.
// `force`: the socket closed, so a dictation waiting for a neighbour goes now (one that comes later is
// its own range).
export function settle(state: Dictation, now: number, force = false): Step {
  const flushed = flush(state, now, force);
  const { open } = flushed.state;
  if (open && now - open.start > MAX_MS) {
    return {
      ranges: flushed.ranges,
      state: { ...flushed.state, interrupted: true, open: null },
    };
  }
  return flushed;
}

// One fact from the Mac, at its time. The first dictation app capturing is the source.
export function step(state: Dictation, event: MacEvent): Step {
  const settled = settle(state, event.at);
  const s = settled.state;
  if (event.kind === "wake") {
    return { ...settled, state: { ...s, asleep: false } };
  }
  if (event.kind === "sleep") {
    // The dictation in progress is dropped; one already finished goes now.
    const cut = { ...s, asleep: true, interrupted: s.interrupted || !!s.open };
    const flushed = flush({ ...cut, open: null }, event.at, true);
    return {
      ranges: [...settled.ranges, ...flushed.ranges],
      state: flushed.state,
    };
  }
  const source = event.capturing.find(isDictationApp) ?? null;
  if (source === null) {
    const finished = s.open
      ? { end: event.at, source: s.open.source, start: s.open.start }
      : s.finished;
    return {
      ...settled,
      state: { ...s, finished, interrupted: false, open: null },
    };
  }
  if (s.open || s.interrupted) {
    return settled;
  }
  // A dictation still waiting is less than MERGE_GAP_MS old (`settle` kept it): this one joins it.
  const open = s.finished
    ? { source: s.finished.source, start: s.finished.start }
    : { source, start: event.at };
  return { ...settled, state: { ...s, finished: null, open } };
}

// The padded start of the dictation in progress or waiting for a neighbour, as of `now`: not yet a
// range, so the server must not vouch past it.
// Blocked from the padded instant before `heardAt`: a refused event came after it and may be a
// dictation's start. An earlier block stands. `lost`: the event was invalid, and the helper drops it.
export function blocked(
  state: Dictation,
  heardAt: number,
  lost = false
): Dictation {
  const since = state.blockedSince ?? heardAt - BEFORE_MS;
  const lostFrom = lost ? (state.lostFrom ?? since) : state.lostFrom;
  return { ...state, blockedSince: since, lostFrom };
}

// The source of a quiet range covering an event that was lost: never seen, so taken for dictation.
const UNKNOWN_SOURCE = "unknown";

// An event applied at `at` clears a block. If an invalid event was dropped in it, the span from there
// to `at` (padded) becomes a quiet range: what was dropped may have been a dictation.
export function unblocked(state: Dictation, at: number): Step {
  const { lostFrom } = state;
  const ranges =
    lostFrom === null
      ? []
      : [
          {
            endedAt: Math.max(at, lostFrom) + AFTER_MS,
            source: UNKNOWN_SOURCE,
            startedAt: lostFrom,
          },
        ];
  return { ranges, state: { ...state, blockedSince: null, lostFrom: null } };
}

// A finished one holds until it is stored, even once due; a stuck flag holds no longer. A block holds
// until it clears, whatever its age.
export function heldFrom(state: Dictation, now: number): number | null {
  const from = settle(state, now).state.open?.start ?? state.finished?.start;
  const held = from === undefined ? null : from - BEFORE_MS;
  const { blockedSince } = state;
  return held === null || (blockedSince !== null && blockedSince < held)
    ? blockedSince
    : held;
}

// When time alone next changes the state (`settle`): a finished dictation done waiting for a
// neighbour, or a flag on past MAX_MS. Null when nothing waits.
export function nextChange({ finished, open }: Dictation): number | null {
  if (finished) {
    return finished.end + MERGE_GAP_MS;
  }
  return open ? open.start + MAX_MS + 1 : null;
}

// When the dictation in progress started, unpadded, while the stuck-flag rule still counts it.
export const dictatingSince = (state: Dictation, now: number) =>
  settle(state, now).state.open?.start ?? null;
