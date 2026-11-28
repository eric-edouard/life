import { expect, spyOn, test } from "bun:test";
import { DAY, HOUR, MIN } from "../../core/clock";
import { voiceServer } from "../../sources/store-fixtures";
import { quietestAt, toneOf } from "../integration-health";
// biome-ignore lint/performance/noNamespaceImport: a test spies on its functions
import * as macAccess from "../mac-access";
import { alertKeyOf, redCards } from "../report";
import { crashCard } from "./crash-card";
import { processingStepsOf, snapshot } from "./snapshot";

// The regression case names this file: the rule now lives in `integration-health.ts`, the card that shows it here.
test("audit-6-line-account-id: a source with parts goes amber when one part is silent, even while another is receiving", () => {
  const now = Date.parse("2026-10-21T15:00:00.000Z");
  const ago = (ms: number) => new Date(now - ms).toISOString();
  const parts = [
    { at: ago(10 * MIN), label: "telegram" },
    { at: ago(4 * DAY), label: "line" },
  ];
  expect(
    toneOf(quietestAt({ at: ago(10 * MIN), parts }), 3 * DAY, now)
  ).toEqual({ tone: "warn", word: "silent" });
  expect(quietestAt({ at: ago(HOUR) })).toBe(ago(HOUR));
});

test("a processing run's steps are the steps it recorded: done, now, the one it failed at still to do, then the night's report", () => {
  const run = (processingSteps: string[], outcome: string, failedAt?: string) =>
    ({
      outcome,
      processingSteps,
      result: failedAt ? { failedAt } : {},
    }) as never;
  const all = [
    "repos",
    "gather",
    "episodes",
    "extract",
    "pages",
    "index",
    "actions",
    "commit",
  ];
  const ok = run(all, "ok");
  const state = (list: { name: string; state: string }[]) =>
    list.map((x) => `${x.name}:${x.state}`);
  expect(
    state(processingStepsOf({ lastOk: ok, latest: ok }, false, true)).slice(-3)
  ).toEqual(["actions:done", "commit:done", "email:done"]);
  const failed = run(
    [
      "repos",
      "gather",
      "episodes",
      "extract",
      "pages",
      "index",
      "actions",
      "commit",
    ],
    "failed",
    "commit"
  );
  expect(
    state(
      processingStepsOf({ lastOk: ok, latest: failed }, false, false)
    ).slice(-2)
  ).toEqual(["commit:todo", "email:todo"]);
  const running = run(["repos", "gather", "episodes"], "running");
  expect(
    state(processingStepsOf({ lastOk: ok, latest: running }, true, null)).slice(
      1,
      4
    )
  ).toEqual(["gather:done", "episodes:now", "extract:todo"]);
});

test(
  "every card on the status snapshot has its own id",
  async () => {
    const ids = (await snapshot()).cards.map((c) => c.id);
    expect(ids.length).toBe(new Set(ids).size);
  },
  MIN
);

test(
  "the engine card names the model and what each tier runs (the made-up settings: claude, no quota)",
  async () => {
    const card = (await snapshot()).cards.find((c) => c.id === "engine");
    expect(card?.name).toBe("Engine · claude");
    expect(card?.headline).toBe("opus");
    expect(card?.facts).toContainEqual({
      label: "Model (deep)",
      value: "claude/opus",
    });
    expect(card?.facts).toContainEqual({
      label: "Model (fast)",
      value: "claude/haiku",
    });
  },
  MIN
);

test(
  "a source Life can't read is red and says why, so the tick mails it; an import never run is idle, so it doesn't",
  async () => {
    // Full Disk Access is the test process's own, which differs by machine: granted here, so the source's cause shows.
    const fda = spyOn(macAccess, "readFullDiskAccess").mockReturnValue("done");
    try {
      const red = new Map(
        redCards((await snapshot()).cards).map((c) => [c.id, c])
      );
      // The made-up data has no WhatsApp archive and no repos folder; claude.ai is imported or not, by the tests before.
      expect(red.get("whatsapp")?.headline).toBe("WhatsApp not archived yet");
      expect(red.get("git")?.headline).not.toBe("unreadable");
      expect(red.has("claude")).toBe(false);
    } finally {
      fda.mockRestore();
    }
  },
  MIN
);

test(
  "an output's card says off when its switch is off, on when it is on",
  async () => {
    const cards = new Map((await snapshot()).cards.map((c) => [c.id, c]));
    // The made-up settings set a connector and no Past calendar.
    expect(cards.get("past")?.word).toBe("off");
    expect(cards.get("connector")?.word).toBe("serving");
  },
  MIN
);

test(
  "a calendar whose sync failed within the hour says failing, whatever it wrote before",
  async () => {
    const { setSettings, settings } = await import("../../core/settings");
    const { log } = await import("../../core/log");
    const { pastCalendar: past } = settings();
    // Past the snapshot's cache of the log, which earlier tests filled.
    const later = performance.now() + HOUR;
    const timer = spyOn(performance, "now").mockReturnValue(later);
    try {
      setSettings({
        pastCalendar: {
          account: "owner@example.com",
          calendar: "past@example.com",
        },
      });
      log("run.error", {
        error: "Error: gog calendar: no token",
        step: "past",
      });
      const card = (await snapshot()).cards.find((c) => c.id === "past");
      expect(card).toMatchObject({
        content: ["Error: gog calendar: no token"],
        tone: "warn",
        word: "failing",
      });
    } finally {
      timer.mockRestore();
      setSettings({ pastCalendar: past });
    }
  },
  MIN
);

test(
  "143-email-card: the Email card follows the mail setting: sending with an address, kept on the Mac without",
  async () => {
    const { setSettings, settings } = await import("../../core/settings");
    const { mail } = settings();
    const email = async () =>
      (await snapshot()).cards.find((c) => c.id === "email");
    try {
      setSettings({
        mail: { from: "life@example.com", to: "owner@example.com" },
      });
      expect(await email()).toMatchObject({ tone: "ok", word: "sending" });
      setSettings({ mail: undefined });
      expect(await email()).toMatchObject({
        tone: "idle",
        word: "kept on the Mac",
      });
    } finally {
      setSettings({ mail });
    }
  },
  MIN
);

test(
  "a phone silent 12 h is red, so the tick mails it: its app or its way to lifelog is down, not him quiet",
  async () => {
    const knownAt = new Date(Date.now() - 13 * HOUR).toISOString();
    const server = voiceServer({
      "/status": () => ({ pendant: { knownAt, recording: "recording" } }),
    });
    // Past the snapshot's cache of the voice server's status, which earlier tests filled.
    const later = performance.now() + DAY;
    const timer = spyOn(performance, "now").mockReturnValue(later);
    try {
      const red = redCards((await snapshot()).cards);
      expect(red.find((c) => c.id === "pendant")?.word).toBe(
        "phone not reporting"
      );
    } finally {
      timer.mockRestore();
      server.close();
    }
  },
  MIN
);

// 20 Nov 2026: the desk crashed once every 7 s for 67 minutes, and only "Agents not running" was mailed.
test(
  "a crash loop is red, so the tick mails it, naming the helper; a crash alone is amber",
  async () => {
    const { log } = await import("../../core/log");
    // Past the snapshot's cache of the log, which earlier tests filled.
    let later = performance.now() + 2 * DAY;
    const timer = spyOn(performance, "now").mockImplementation(() => later);
    const crash = () =>
      log("run.error", {
        command: "desk",
        error: "TypeError: x is not a function",
        step: "crash",
      });
    const card = async () =>
      (await snapshot()).cards.find((c) => c.id === "crashes");
    try {
      crash();
      expect(await card()).toMatchObject({ tone: "warn" });
      for (const _ of [1, 2, 3, 4]) {
        crash();
      }
      later += HOUR;
      const red = redCards((await snapshot()).cards).find(
        (c) => c.id === "crashes"
      );
      expect(red).toMatchObject({
        headline: "desk crashed 5 times in 30 min",
        word: "looping",
      });
    } finally {
      timer.mockRestore();
    }
  },
  MIN
);

// A loop between two ticks: amber by the 11:00 tick, still mailed once that day.
test("a crash loop that fell between two ticks is still in the alert", () => {
  const crashes = ["10:27", "10:28", "10:29", "10:31", "10:32"].map((t) => ({
    at: `2026-11-20T${t}:00.000Z`,
    command: "desk",
    kind: "run.error",
    step: "crash",
  }));
  const at = (t: string) => Date.parse(`2026-11-20T${t}:00.000Z`);
  expect(crashCard(crashes.slice(0, 3), at("10:30")).tone).toBe("warn");
  expect(redCards([crashCard(crashes.slice(0, 3), at("10:30"))])).toEqual([]);
  expect(crashCard(crashes, at("10:32")).tone).toBe("bad");
  const later = crashCard(crashes, at("11:00"));
  expect(later).toMatchObject({
    at: crashes[4]?.at,
    headline: "desk crashed 5 times in 30 min",
    tone: "warn",
    word: "looped",
  });
  expect(redCards([later])).toEqual([later]);
  // Mailed under its own day, the same key red or over, never the next day's.
  const key = alertKeyOf(later, new Date("2026-11-21T09:00:00.000Z"));
  expect(key).toBe(alertKeyOf(crashCard(crashes, at("10:32")), new Date()));
  expect(key).toBe("alert/crashes/loop/2026-11-20");
});
