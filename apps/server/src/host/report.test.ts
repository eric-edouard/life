import { expect, spyOn, test } from "bun:test";
import { clock, MIN } from "../core/clock";
import { writeJson } from "../core/files";
import { AGENT_WORD } from "../core/names";
import { notifyArgs, WINDOWS } from "../core/platform";
import { action, madeBy } from "../memory/record-fixtures";
import { LedgerEntry } from "../records/ledger-entry";
import { entryLine } from "../todo-list/items";
import { HEALTH } from "./health";
import {
  actFailedReport,
  failureReport,
  lockReport,
  type Night,
  sendReport,
  successReport,
} from "./report";

const MORE = /\+\d+ more/;

test("an action reads as what it did, his words, and how it ended", () => {
  expect(entryLine(action({}))).toBe(
    "“Buy checked baggage” in Travel ← “write that down in the to-dos”"
  );
  expect(
    entryLine(
      action({ after: { title: "Y" }, before: { title: "X" }, kind: "edit" })
    )
  ).toContain("“X” → “Y” ←");
  expect(
    entryLine(
      action({
        after: { due: "2026-10-16" },
        before: { title: "X" },
        kind: "edit",
      })
    )
  ).toContain("“X”: due 2026-10-16");
  expect(entryLine(action({ error: "boom", result: "failed" }))).toEndWith(
    " FAILED: boom"
  );
  expect(entryLine(action({ error: "partial: section: x" }))).toEndWith(
    " (partial: section: x)"
  );
  expect(entryLine(action({ result: "duplicate" }))).toEndWith(
    " duplicate of #12"
  );
});

test("an old ledger line still parses and reads: an email to Instinct (until 19 Oct)", () => {
  const old = LedgerEntry.parse({
    ...action({}),
    after: { subject: "Book a table" },
    kind: "instinct",
    target: "mailto:x@y.z",
  });
  expect(entryLine(old)).toStartWith("to Instinct: “Book a table” ←");
});

test("an old ledger line still parses and reads: a request heard in his speech, with its timing (until 19 Oct)", () => {
  const old = LedgerEntry.parse({
    ...action({}),
    timing: {
      actMs: 1200,
      arrived: "2026-10-15T10:06:24.000Z",
      heard: "2026-10-15T10:07:54.000Z",
      modelMs: 12_400,
    },
    via: { ...madeBy, prompt: "intent.v6" },
  });
  expect(entryLine(old)).toBe(
    "“Buy checked baggage” in Travel ← “write that down in the to-dos”"
  );
});

test("an ask reads as his words to Orbit, a low-confidence one says so", () => {
  const ask = (confidence: string) =>
    LedgerEntry.parse({
      ...action({}),
      after: { confidence, conversation: "c1", turns: [4, 5] },
      kind: "ask",
      target: AGENT_WORD,
      via: "watch",
    });
  expect(entryLine(ask("high"))).toBe(
    "to Orbit ← “write that down in the to-dos”"
  );
  expect(entryLine(ask("low"))).toStartWith("to Orbit (low confidence) ←");
});

const night = (facts: number) =>
  ({
    acted: { actions: [], problems: [], tasks: [] },
    archive: "Archive: no failure",
    backup: "Last backup: 2026-10-15 05:00, 5.5 GB",
    code: [],
    extracted: { added: 2, model: "codex/m/high", read: 3, retired: 1 },
    facts: Array.from({ length: facts }, (_, i) => ({
      id: `obs_${i}`,
      page: "Shop",
      text: `fact ${i}`,
    })),
    files: {
      copied: 1,
      described: 4,
      failed: 1,
      missing: ["pdftotext"],
      read: 2,
    },
    from: "2026-10-12",
    marked: [],
    moments: {
      agreement: { agreement: 0.75, labeled: 40 },
      model: "codex/m/high",
      moments: 6,
      people: [{ name: "Pim", relation: "the plumber" }],
      read: 2,
      units: 9,
    },
    paged: {
      changes: [{ added: 2, moved: 1, page: "Shop", removed: 0 }],
      corrections: 0,
      dropped: ["inf_glazier"],
      model: "codex/m/medium",
      retired: 1,
    },
    quota: "Codex quota: 40% used, resets 2026-10-27 08:16",
    repos: { suggestions: [] },
    retired: 1,
    spent: [
      "Model use, midday of 2026-10-16 13:00: under 1% of the quota, 812k tokens (600k cached)",
      "Model use, this night: +3% of the quota, 2.1M tokens (1.4M cached)",
    ],
  }) as unknown as Night;

test("the success email includes every fact, counts pages and lists models once", () => {
  const { subject, text, html, attachments } = successReport(
    "2026-10-15",
    221_000,
    night(564)
  );
  expect(subject).toBe("Life · 15 Oct · 564 new facts, 1 page");
  expect(text).toContain("What it found (564)");
  for (let i = 0; i < 564; i += 1) {
    expect(text).toContain(`- fact ${i} [Shop]`);
    expect(html).toContain(`>fact ${i}</div>`);
  }
  expect(text).not.toMatch(MORE);
  expect(text).toContain("codex/m/high, codex/m/medium");
  expect(text).toContain("6 moments on 2 days");
  expect(text).toContain("observations retired: 1");
  expect(text).toContain("Pages no longer kept (git has them): inf_glazier");
  expect(text).toContain("3m 41s");
  expect(text).toContain("Shop: +2 added, 1 moved to History, 0 removed");
  expect(text).toContain("75%");
  expect(text).toContain("Codex quota: 40% used");
  expect(text).toContain(
    "Model use, this night: +3% of the quota, 2.1M tokens (1.4M cached)"
  );
  expect(text).toContain("Last backup: 2026-10-15 05:00, 5.5 GB");
  expect(text).toContain("Archive: no failure");
  expect(html).not.toMatch(MORE);
  expect(html).toContain("the plumber");
  expect(html).toContain("OK · memory committed");
  expect(attachments).toEqual([
    {
      content: Buffer.from(html).toString("base64"),
      filename: "life-2026-10-15.html",
    },
  ]);
});

test("every report section includes all rows beyond the former 15-row cap", () => {
  const n = night(0);
  n.acted.actions = [];
  n.paged.changes = [];
  n.moments.people = [];
  for (let i = 0; i < 20; i += 1) {
    n.acted.problems.push(`problem ${i}`);
    n.acted.actions.push(action({ after: { title: `action ${i}` } }));
    n.code.push({ name: `repo ${i}`, relation: `commit ${i}` });
    n.acted.tasks.push({ name: "open · 1 h", relation: `task ${i}` });
    n.repos.suggestions.push({
      area: null,
      newProject: `project ${i}`,
      repo: `new repo ${i}`,
    });
    n.moments.people.push({ name: `person ${i}`, relation: `relation ${i}` });
    n.paged.changes.push({ added: i, moved: 1, page: `page ${i}`, removed: 0 });
  }
  const { text, html } = successReport("2026-10-15", 1000, n);
  for (const body of [text, html]) {
    for (let i = 0; i < 20; i += 1) {
      for (const label of [
        "problem",
        "action",
        "commit",
        "project",
        "relation",
        "task",
        "page",
      ]) {
        expect(body).toContain(`${label} ${i}`);
      }
    }
    expect(body).not.toMatch(MORE);
  }
  expect(text).toContain("Actions (40)");
  expect(text).toContain("Code yesterday (40)");
  expect(text).toContain("Orbit tasks (20)");
  expect(text).toContain("New people (20)");
  expect(text).toContain("What changed (20)");
});

test("the Actions section lists problems first, then each action with his words; no section when there is nothing", () => {
  const n = night(1);
  expect(successReport("2026-10-15", 1000, n).html).not.toContain("Actions");
  n.acted = {
    actions: [action({}), action({ error: "boom", result: "failed" })],
    problems: ["Reminders: remctl is not on the PATH"],
    tasks: [],
  };
  const { subject, text, html } = successReport("2026-10-15", 1000, n);
  expect(subject).toEndWith(", 2 actions");
  expect(text).toContain(
    "Actions (3)\n- Problem: Reminders: remctl is not on the PATH\n"
  );
  expect(text).toContain(" · add: “Buy checked baggage” in Travel ←");
  expect(html).toContain("write that down in the to-dos");
  expect(html).toContain("FAILED: boom");
});

test("the Code section lists yesterday's rows and this night's new repos", () => {
  const n = night(1);
  expect(successReport("2026-10-15", 1000, n).html).not.toContain(
    "Code yesterday"
  );
  n.code = [
    { name: "Bakery (Lille)", relation: "bakery-hq 33 · +60 −5 · seo" },
  ];
  n.repos.suggestions = [
    { area: "work", newProject: "Cove: macOS call recorder", repo: "cove" },
  ];
  const { text, html } = successReport("2026-10-15", 1000, n);
  expect(text).toContain(
    "Code yesterday (2)\n- Bakery (Lille): bakery-hq 33 · +60 −5 · seo"
  );
  expect(text).toContain(
    "- New repo: cove → work · new project? Cove: macOS call recorder"
  );
  expect(html).toContain("Code yesterday");
});

test("the HTML email escapes everything that comes from data", () => {
  const n = night(1);
  n.facts[0] = {
    id: "obs_0",
    page: "<b>Pg</b>",
    text: `<script>alert("x")</script> & co`,
  };
  n.moments.people[0] = { name: "A&B", relation: "<i>x</i>" };
  const { html } = successReport("2026-10-15", 1000, n);
  expect(html).not.toContain("<script>");
  expect(html).not.toContain("<b>Pg</b>");
  expect(html).toContain(
    "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; co"
  );
  expect(html).toContain("A&amp;B");
});

test("the failure email names the step, plainly, and shows the error", () => {
  const { subject, text, html } = failureReport(
    "2026-10-15T10:00:00.000Z",
    1000,
    "extract",
    "2 <failed>"
  );
  expect(subject).toBe("Life · 15 Oct · failed at extract");
  expect(text).toContain("2 <failed>");
  expect(html).toContain("Stopped at extract");
  expect(html).toContain("2 &lt;failed&gt;");
  expect(html).not.toContain("What it found");
});

test("a failed action's alert carries his words and the error", () => {
  const mail = actFailedReport(
    action({
      error: "remctl is not installed (~/bin/remctl)",
      result: "failed",
    })
  );
  expect(mail.subject).toBe("Life · could not add: Buy checked baggage");
  expect(mail.text).toContain("remctl is not installed");
  expect(mail.text).toContain("write that down in the to-dos");
});

test("the success email says the window it read and counts the new observations", () => {
  // lifelog set up: the night says how its watcher stands.
  const token = process.env.LIFELOG_TOKEN;
  process.env.LIFELOG_TOKEN = "test-token";
  try {
    const n = night(1);
    (n as { observed: number }).observed = 7;
    const { text } = successReport("2026-10-18", 1000, n);
    expect(text).toContain("Read 12 Oct–18 Oct: 9 units");
    expect(text).toContain("7 new observations since the last night");
    // A failed files call or a missing tool is told here, never a failed night.
    expect(text).toContain(
      "Files: 4 described, 2 read by code, 1 copied; 1 call failed (a file still not described stays a tag until the next night); not on PATH: pdftotext"
    );
    // The night reads lifelog from the watcher's store as it stands: a stopped watcher is said here, judged as the
    // report is written, however long the night took (29 Oct: a 20-minute night said a polling watcher was not).
    const health = (lastOkAt: string | null) =>
      writeJson(HEALTH, {
        ...{ consecutiveErrors: 0, cursor: "1", lagSec: 0, lastError: null },
        lastOkAt,
        lastPollAt: clock().toISOString(),
      });
    health(clock().toISOString());
    expect(successReport("2026-10-18", 1000, n).text).toContain(
      "Lifelog: the watcher is polling"
    );
    health(new Date(clock().getTime() - 20 * MIN).toISOString());
    expect(successReport("2026-10-18", 1000, n).text).toContain(
      "the watcher is NOT POLLING (last good poll "
    );
    health(null);
    expect(successReport("2026-10-18", 1000, n).text).toContain(
      "the watcher is NOT POLLING (last good poll never)"
    );
  } finally {
    if (token === undefined) {
      delete process.env.LIFELOG_TOKEN;
    } else {
      process.env.LIFELOG_TOKEN = token;
    }
  }
});

test("a send goes out once per id: a second one with the same id never reaches Resend", async () => {
  const env = { ...process.env };
  process.env.RESEND_PERSONAL_API_KEY = "test";
  const post = spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({ id: "email_1" })
  );
  try {
    const mail = lockReport("2026-10-19T10:00:00.000Z");
    expect(await sendReport("test/once", mail)).toBe("email_1");
    expect(await sendReport("test/once", mail)).toBeNull();
    expect(post).toHaveBeenCalledTimes(1);
  } finally {
    post.mockRestore();
    process.env = env;
  }
});

test("each ask is listed with what the memory holds of it", () => {
  const n = {
    ...night(0),
    marked: [
      {
        name: "2026-10-15 20:36",
        relation: "“hey Life, I committed” → nothing held",
      },
    ],
  } as Night;
  const { text } = successReport("2026-10-15", 1000, n);
  expect(text).toContain("Asks remembered (1)");
  expect(text).toContain("nothing held");
});

test.skipIf(WINDOWS)(
  "a notification's words are the script's arguments, never its text",
  () => {
    const title = 'Life · "night" \u0007 done';
    const body = 'end run\ndisplay dialog "x"';
    const args = notifyArgs(title, body) ?? [];
    expect(args.slice(-2)).toEqual([title, body]);
    expect(args.slice(0, -2).join(" ")).not.toContain("night");
  }
);
