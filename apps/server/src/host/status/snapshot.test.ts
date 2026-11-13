import { expect, spyOn, test } from "bun:test";
import { DAY, HOUR, MIN } from "../../core/clock";
import { lifelogServer } from "../../sources/store-fixtures";
import {
  processingStepsOf,
  quietestAt,
  redCards,
  snapshot,
  toneOf,
  waking,
  wokeAt,
} from "./snapshot";

const now = Date.parse("2026-10-21T15:00:00.000Z");
const ago = (ms: number) => new Date(now - ms).toISOString();

test("a source is red only when Life can't read it; silence is quiet, then amber past its limit", () => {
  expect(toneOf(ago(10 * MIN), DAY, now)).toEqual({
    tone: "ok",
    word: "receiving",
  });
  expect(toneOf(ago(5 * HOUR), DAY, now)).toEqual({
    tone: "idle",
    word: "quiet",
  });
  expect(toneOf(ago(25 * HOUR), DAY, now)).toEqual({
    tone: "warn",
    word: "silent",
  });
  expect(toneOf(ago(MIN), DAY, now, false)).toEqual({
    tone: "bad",
    word: "unreadable",
  });
  expect(toneOf(null, DAY, now)).toEqual({ tone: "idle", word: "nothing yet" });
});

test("audit-6-line-account-id: a source with parts goes amber when one part is silent, even while another is receiving", () => {
  const parts = [
    { at: ago(10 * MIN), label: "telegram" },
    { at: ago(4 * DAY), label: "line" },
  ];
  expect(
    toneOf(quietestAt({ at: ago(10 * MIN), parts }), 3 * DAY, now)
  ).toEqual({ tone: "warn", word: "silent" });
  expect(quietestAt({ at: ago(HOUR) })).toBe(ago(HOUR));
});

test("the Pendant is expected to hear him between 08:00 and 01:00 only, on the clock of the zone given", () => {
  // Lagos is UTC+1 all year: 06:30Z is 07:30 there.
  const at = (h: number) => new Date(Date.UTC(2026, 9, 21, h - 1, 30));
  expect(
    [7, 8, 13, 23, 24, 25, 28].map((h) => waking(at(h), "Africa/Lagos"))
  ).toEqual([false, true, true, true, true, false, false]);
  // The same instant in another zone: 07:30 in Lagos is 13:30 in Jakarta.
  expect(waking(at(7), "Asia/Jakarta")).toBe(true);
});

test("his waking hours began at 08:00, the day before after midnight: a night is not silence", () => {
  const lagos = (day: number, h: number) =>
    new Date(Date.UTC(2026, 9, day, h - 1, 30));
  const eight = new Date("2026-10-21T07:00:00.000Z");
  expect(wokeAt(lagos(21, 9), "Africa/Lagos")).toEqual(eight);
  expect(wokeAt(lagos(22, 0), "Africa/Lagos")).toEqual(eight);
  expect(wokeAt(lagos(22, 4), "Africa/Lagos")).toBeNull();
});

test("a processing run's steps are the phases it recorded: done, now, the one it failed at still to do, then the night's report", () => {
  const run = (phases: string[], outcome: string, failedAt?: string) =>
    ({ outcome, phases, result: failedAt ? { failedAt } : {} }) as never;
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
    const red = new Map(
      redCards((await snapshot()).cards).map((c) => [c.id, c])
    );
    // The made-up data has no WhatsApp archive and no repos folder; claude.ai is imported or not, by the tests before.
    expect(red.get("whatsapp")?.headline).toBe("WhatsApp not archived yet");
    expect(red.get("git")?.headline).not.toBe("unreadable");
    expect(red.has("claude")).toBe(false);
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
    const server = lifelogServer({
      "/status": () => ({ pendant: { knownAt, recording: "recording" } }),
    });
    // Past the snapshot's cache of lifelog's status, which earlier tests filled.
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
