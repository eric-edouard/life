// `bun run check:web`: the decisions page's layout in a real browser (Playwright's Chromium: `bun x playwright install
// chromium` once),
// on a phone, a small phone and a desktop, with made-up decisions long enough to overflow. Not in `bun run check`: it
// needs a browser. Builds apps/web, serves it with a stub API, and fails on the first broken promise of the layout.
import { join } from "node:path";
import { execOk } from "@life/server/src/core/proc";

const WEB = join(import.meta.dir, "..", "apps", "web");
await execOk(["bun", "x", "vite", "build"], { cwd: WEB, timeout: 120_000 });

const long =
  "The Lynx recap has been cut for two days because Railway dropped the session, and the shop's sales stopped reaching the report the same evening.";
const decision = (id: string, question: string) => ({
  context: `${"Life is unsure: it was heard once, from an episode far from any chat about it.\n\n".repeat(6)}From a voice note, 30 Oct.`,
  createdAt: "2026-10-30T08:00:00.000Z",
  deadline: "2026-11-06T08:00:00.000Z",
  id,
  loop: "fact-checks",
  options: [
    { id: "true", label: "Right" },
    { id: "false", label: "Wrong" },
  ],
  question,
  status: "open",
});
const DECISIONS = [
  decision("fact-checks-20261030080000-1", long),
  decision("fact-checks-20261030080000-2", "Short?"),
];

// Each size answers its own copy (its cookie names it), so they run side by side.
const states = new Map<string, typeof DECISIONS>();
const server = Bun.serve({
  async fetch(req) {
    const { pathname } = new URL(req.url);
    if (pathname.startsWith("/api/")) {
      const who = req.headers.get("cookie") ?? "";
      const mine = states.get(who) ?? structuredClone(DECISIONS);
      states.set(who, mine);
      if (req.method === "POST") {
        const step = await req.json();
        const d = mine.find((x) => x.id === step.decision);
        if (d && step.step === "answered") {
          Object.assign(d, {
            answer: step.data.answer,
            note: step.data.note,
            status: step.data.answer ? "answered" : "open",
          });
        }
        return new Response("ok");
      }
      return Response.json(mine);
    }
    const file = Bun.file(
      join(WEB, "dist", pathname.startsWith("/app/") ? pathname : "index.html")
    );
    return new Response(file);
  },
  port: 0,
});

// The link to the sheet: the preview's, or at the densest, Details.
const MORE = /^(More context|Details)$/;

const { chromium } = await import("playwright");
const browser = await chromium.launch();
const failures: string[] = [];
const expect = (ok: boolean, what: string) => {
  if (!ok) {
    failures.push(what);
  }
};

const SIZES = [
  ["small phone", { height: 667, width: 375 }, true, "light"],
  // In dark, so the screenshots show both themes.
  ["phone", { height: 852, width: 393 }, true, "dark"],
  ["desktop", { height: 800, width: 1280 }, false, "light"],
] as const;

/** One size, in its own page. */
async function check([
  name,
  viewport,
  isPhone,
  colorScheme,
]: (typeof SIZES)[number]) {
  const page = await browser.newPage({
    colorScheme,
    hasTouch: isPhone,
    isMobile: isPhone,
    viewport,
  });
  await page
    .context()
    .addCookies([
      { name: "size", url: server.url.origin, value: name.replace(" ", "-") },
    ]);
  const shot = (what: string) =>
    page.screenshot({
      path: join(WEB, "dist", `layout-${name.replace(" ", "-")}-${what}.png`),
    });
  await page.goto(`${server.url.origin}/decisions`);
  const first = page.locator("section").first();
  const article = first.locator("article");
  const field = first.locator("textarea");
  await field.waitFor();
  await page.waitForTimeout(300);
  await shot("first");
  const h = await page.evaluate(() => innerHeight);
  expect(
    !(await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth
    )),
    `${name}: the page is wider than the screen`
  );
  const onScreen = async (
    what: string,
    box: { y: number; height: number } | null
  ) =>
    expect(
      Boolean(box && box.y >= 0 && box.y + box.height <= h),
      `${name}: ${what} isn't on screen`
    );
  await onScreen("the question", await first.locator("h2").boundingBox());
  // Seen, not only placed: nothing covers the question's first and last lines.
  expect(
    await first.locator("h2").evaluate((q) => {
      const r = q.getBoundingClientRect();
      const x = r.left + 8;
      return [r.top + 6, r.bottom - 6].every((y) =>
        q.contains(document.elementFromPoint(x, y))
      );
    }),
    `${name}: something covers the question`
  );
  await onScreen(
    "the first answer",
    await first.locator("button.opt").first().boundingBox()
  );
  await onScreen('"say it your way"', await field.boundingBox());
  expect(
    (await article.evaluate((el) => {
      const scrollers = (e: Element) =>
        [e, ...e.querySelectorAll("*")].filter((x) => {
          const y = getComputedStyle(x).overflowY;
          return (
            (y === "auto" || y === "scroll") &&
            x.scrollHeight > x.clientHeight + 1
          );
        }).length;
      return scrollers(el);
    })) <= 1,
    `${name}: something scrolls inside the decision`
  );
  // The long context is a preview; the whole of it is in the sheet.
  await first.getByText(MORE).click();
  const sheet = page.getByRole("dialog");
  await sheet.waitFor();
  expect(
    (await sheet.innerText()).includes("From a voice note, 30 Oct."),
    `${name}: the sheet doesn't hold the whole context`
  );
  await shot("sheet");
  await page.keyboard.press("Escape");
  await sheet.waitFor({ state: "hidden" });
  // Typing lands (30 Oct: every key was cancelled), and the options fold away while he types.
  await field.click();
  await page.keyboard.type("hello");
  expect(
    (await field.inputValue()) === "hello",
    `${name}: typing doesn't land`
  );
  await page.waitForTimeout(300);
  expect(
    (await first.locator("button.opt[aria-pressed]").count()) === 0,
    `${name}: the options stay while he types`
  );
  await shot("typing");
  await page.evaluate(() =>
    (document.activeElement as HTMLElement | null)?.blur()
  );
  await page.waitForTimeout(300);
  // An answer lands, then the next one comes; after the last, the end.
  await first.locator("button.opt").first().click();
  await page.waitForTimeout(900);
  expect(
    page.url().endsWith("#fact-checks-20261030080000-2"),
    `${name}: answering didn't move to the next one (${page.url()})`
  );
  if (!isPhone) {
    // A wide screen centers the decision (31 Oct: it sat at the bottom), a short one too, its question large.
    const [above, below, gap, size, weight] = await page
      .locator("section")
      .nth(1)
      .locator("article")
      .evaluate((a) => {
        const r = a.getBoundingClientRect();
        const kids = [...a.children].map((k) => k.getBoundingClientRect());
        const [head = r] = kids;
        const [h2 = a] = a.getElementsByTagName("h2");
        const style = getComputedStyle(h2);
        return [
          head.top - r.top,
          r.bottom - Math.max(...kids.map((k) => k.bottom)),
          // Nothing pushed apart in between: the question sits under its deadline.
          h2.getBoundingClientRect().top - head.bottom,
          Number.parseFloat(style.fontSize),
          Number(style.fontWeight),
        ];
      });
    expect(
      Math.abs(above - below) < 48 && gap < 48,
      `${name}: the decision isn't centered (${above}px above, ${gap}px gap, ${below}px below)`
    );
    expect(
      size >= 32 && weight >= 700,
      `${name}: the question is small (${size}px, ${weight})`
    );
  }
  await page.locator("section").nth(1).locator("button.opt").first().click();
  await page.waitForTimeout(900);
  expect(
    await page.getByText("That's all for today.").isVisible(),
    `${name}: no end after the last one`
  );
  await shot("done");
  if (isPhone) {
    // A sideways swipe back lands on a decision, whole, and makes it the current one.
    await page
      .locator("main > div")
      .last()
      .evaluate((t) => t.scrollTo({ left: 0 }));
    await page.waitForTimeout(600);
    expect(
      page.url().endsWith("#fact-checks-20261030080000-1"),
      `${name}: a swipe didn't make the decision current`
    );
    // Tapping the one on screen in the overview moves nothing, and swipes still count after it (a stuck move once
    // stopped every swipe from registering).
    await page.getByRole("button", { name: "All decisions" }).click();
    await page.getByRole("dialog").locator("button.row").first().click();
    await page.waitForTimeout(500);
    await page
      .locator("main > div")
      .last()
      .evaluate((t) => t.scrollTo({ left: t.clientWidth }));
    await page.waitForTimeout(600);
    expect(
      page.url().endsWith("#fact-checks-20261030080000-2"),
      `${name}: after tapping the current one, a swipe didn't count`
    );
  } else {
    expect(await page.locator("aside").isVisible(), `${name}: no sidebar`);
  }
  // Tapping his answer again keeps it (29 Oct: a second tap took three answers back, reopening them).
  await page
    .locator("section")
    .first()
    .evaluate((s) => s.scrollIntoView({ behavior: "instant" }));
  await page.locator("section").first().locator("button.opt").first().click();
  await page.waitForTimeout(300);
  expect(
    states.get(`size=${name.replace(" ", "-")}`)?.[0]?.status === "answered",
    `${name}: tapping his answer again took it back`
  );
  await page.close();
}
await Promise.all(SIZES.map(check));
await browser.close();
server.stop();
if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log("web layout: every size holds");
