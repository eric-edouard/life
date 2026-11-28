import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DAY } from "../core/clock";
import { LIFE_STATE_DIR } from "../core/paths";
import { HOME } from "../core/platform";
import {
  ACCESS_STATUSES,
  type AccessStatuses,
  readAccessStatuses,
} from "../memory/access";
import type { InboxCheck } from "../memory/checks";
import { decisionCardOf } from "../memory/checks";
import { DECISIONS } from "../memory/decision-lines";
import { decisionsNow, requestDecision } from "../memory/decisions";
import { answerWithResult } from "./answer-result";
import { lookAtMac, lookForAccessDone } from "./done-seen";
import { DECISION_ANSWERED, decisionCursorOf, pollDecisions } from "./events";

// An access card (his decision of 28 Nov 2026): one card of steps Life ticks itself from the Mac's statuses, read by
// Life.app's helper; his "I'm at my Mac" shows the next missing step there and leaves the card open until all are done.
// The helper is a made-up script printing the statuses a test sets.

const FAKE = join(LIFE_STATE_DIR, "fake-eventkit");
const ASKED = join(LIFE_STATE_DIR, "fake-eventkit-asked");
/** The fake helper's statuses: `status` prints them, `ask` notes what it was asked. */
const helperSays = (s: Record<string, string>) =>
  writeFileSync(
    FAKE,
    `#!/bin/sh\nif [ "$2" = status ]; then echo '${JSON.stringify(s)}'; else echo "$3" >> ${ASKED}; fi\n`
  );
const ALL_DONE = {
  accessibility: "done",
  calendars: "done",
  contacts: "done",
  photos: "done",
};
const STEPS = [
  { check: "photos", text: "Allow Life to see your photos" },
  { check: "contacts", text: "Allow Life to read your contacts" },
];
const OPTIONS = [
  { id: "mac", label: "I'm at my Mac", looks: true },
  { id: "drop", label: "Drop it" },
];
const ask = (over = {}) =>
  requestDecision("planner", {
    context: "A made-up project needs your photos.",
    deadline: new Date(Date.now() + 2 * DAY).toISOString(),
    doneSeenBy: "access",
    needs: [{ kind: "access", steps: STEPS }],
    onSilence: null,
    options: OPTIONS,
    question: "Let Life see your photos and contacts?",
    title: "Give Life access on your Mac",
    ...over,
  });

let listed: ReturnType<typeof spyOn>;
beforeEach(async () => {
  rmSync(DECISIONS, { force: true });
  rmSync(ACCESS_STATUSES, { force: true });
  rmSync(ASKED, { force: true });
  mkdirSync(HOME, { recursive: true });
  helperSays({ ...ALL_DONE, photos: "missing" });
  chmodSync(FAKE, 0o755);
  process.env.LIFE_EVENTKIT = FAKE;
  listed = spyOn(
    await import("../memory/checks"),
    "checksNow"
  ).mockImplementation(async () =>
    decisionsNow()
      .filter((d) => d.state === "open")
      .map(
        (d) =>
          ({
            about: [],
            deadline: d.deadline,
            group: "decision",
            matter: null,
            pushId: "",
            ref: d.id,
          }) as unknown as InboxCheck
      )
  );
});
afterEach(() => {
  listed.mockRestore();
  delete process.env.LIFE_EVENTKIT;
});
afterAll(() => {
  rmSync(DECISIONS, { force: true });
  rmSync(ACCESS_STATUSES, { force: true });
});

test("his I'm at my Mac: the missing step's prompt is shown there, his answer voided, the card open, its steps ticked", async () => {
  const from = new Date(Date.now() - 1000);
  const { id } = await ask();
  const r = await answerWithResult(
    id,
    { options: ["mac"] },
    { answerKey: "tap-1", report: () => undefined }
  );
  expect(r).toMatchObject({
    changed: { state: "open" },
    doneSeen: { line: "Asked on your Mac", state: "not_found" },
  });
  await Bun.sleep(50);
  expect(await Bun.file(ASKED).text()).toBe("--of=photos\n");
  // The statuses the look read are what the card shows: contacts ticked, photos still to do.
  const card = decisionsNow().find((d) => d.id === id);
  expect(card?.state).toBe("open");
  const shown = card && decisionCardOf(card, readAccessStatuses());
  expect(shown?.needs[0]).toMatchObject({
    line: "1. Allow Life to see your photos\n2. Allow Life to read your contacts (done)",
    steps: [
      { check: "photos", status: "missing" },
      { check: "contacts", status: "done" },
    ],
  });
  // He allows it on the Mac: the watcher's minute sees every step done, the card ends with no answer of his.
  helperSays(ALL_DONE);
  await lookForAccessDone();
  expect(decisionsNow().find((d) => d.id === id)?.state).toBe("seen");
  await Bun.sleep(5);
  const [told] = pollDecisions(
    DECISION_ANSWERED,
    decisionCursorOf(from),
    "planner"
  ).events;
  expect(told?.data).toMatchObject({
    doneSeen: { eventId: `access:${id}`, state: "seen" },
  });
  // Seen once: a later minute reads nothing, the card being closed.
  await lookForAccessDone();
  expect(
    decisionsNow().filter((d) => d.id === id && d.doneSeen?.state === "seen")
  ).toHaveLength(1);
});

test("a refused step, or one only System Settings turns on, opens its pane; free space is the step's own amount", async () => {
  const shown: string[] = [];
  const need = (steps: object[]) => ({
    id: "dec_000000000001",
    needs: [{ kind: "access" as const, steps } as never],
  });
  const read = (s: AccessStatuses) => () => Promise.resolve(s);
  const show = (check: string, status: string) => {
    shown.push(`${check}:${status}`);
    return Promise.resolve();
  };
  await lookAtMac(
    need(STEPS),
    read({ statuses: { contacts: "done", photos: "refused" } }),
    show
  );
  await lookAtMac(
    need([{ check: "disk_free", freeGb: 20, text: "Free 20 GB" }]),
    read({ freeGb: 12, statuses: {} }),
    show
  );
  expect(shown).toEqual(["photos:refused", "disk_free:missing"]);
  expect(
    await lookAtMac(
      need([{ check: "disk_free", freeGb: 20, text: "Free 20 GB" }]),
      read({ freeGb: 25, statuses: {} }),
      show
    )
  ).toBe("access:dec_000000000001");
});

test("an access card's rules: its need, doneSeenBy and one I'm at my Mac go together, and only with the Mac's helper", async () => {
  await expect(
    ask({
      doneSeenBy: "tap",
      options: [OPTIONS[1], { id: "x", label: "Later" }],
    })
  ).rejects.toThrow('`doneSeenBy: "access"` goes with one `access` need');
  await expect(
    ask({ options: [OPTIONS[1], { id: "x", label: "Later" }] })
  ).rejects.toThrow("one `looks` option");
  await expect(
    ask({
      needs: [
        { kind: "access", steps: [{ check: "disk_free", text: "Free space" }] },
      ],
    })
  ).rejects.toThrow('Read fetch("ask/access")');
  delete process.env.LIFE_EVENTKIT;
  await expect(ask()).rejects.toThrow(
    "Life can't check or ask anything on this Mac"
  );
});
