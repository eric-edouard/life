// `bun run check:web`: the decisions page's layout in a real browser (Playwright's Chromium: `bun x playwright install
// chromium` once),
// on a phone, a small phone and a desktop, with made-up decisions long enough to overflow. Not in `bun run check`: it
// needs a browser. Builds apps/web, serves it with a stub API, and fails on the first broken promise of the layout.
import { join } from "node:path";
import { execOk } from "@life/server/src/core/proc";

const WEB = join(import.meta.dir, "..", "apps", "web");
await execOk(["bun", "x", "vite", "build"], { cwd: WEB, timeout: 120_000 });

const long =
  "Le récap Lynx est coupé depuis deux jours parce que Railway a déconnecté la session : relancer la connexion maintenant, ou attendre la fin de la semaine et le faire avec le reste ?";
const decision = (id: string, question: string, options = 2) => ({
  createdAt: "2026-10-30T08:00:00.000Z",
  draft: `${"Bonjour,\n\nMerci pour votre message. Je reviens vers vous demain avec les chiffres.\n\n".repeat(4)}Bien à vous`,
  id,
  lang: "fr",
  loop: "lynx-store",
  options: Array.from({ length: options }, (_, i) => ({
    consequence:
      "Le récap reprend demain avec les ventes de la boutique et celles du site",
    id: `o${i}`,
    label: `Option ${i + 1}`,
  })),
  question,
  status: "open",
});
const DECISIONS = [
  decision("lynx-20261030080000-1", long, 4),
  decision("lynx-20261030080000-2", "Court ?"),
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
const MORE = /^(Lire le message|Détails)$/;

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
  // The long draft is a preview; the whole of it is in the sheet.
  await first.getByText(MORE).click();
  const sheet = page.getByRole("dialog");
  await sheet.waitFor();
  expect(
    (await sheet.innerText()).includes("Bien à vous"),
    `${name}: the sheet doesn't hold the whole message`
  );
  await shot("sheet");
  await page.keyboard.press("Escape");
  await sheet.waitFor({ state: "hidden" });
  // Typing lands (30 Oct: every key was cancelled), and the options fold away while he types.
  await field.click();
  await page.keyboard.type("bonjour");
  expect(
    (await field.inputValue()) === "bonjour",
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
    page.url().endsWith("#lynx-20261030080000-2"),
    `${name}: answering didn't move to the next one (${page.url()})`
  );
  await page.locator("section").nth(1).locator("button.opt").first().click();
  await page.waitForTimeout(900);
  expect(
    await page.getByText("C'est tout pour aujourd'hui.").isVisible(),
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
      page.url().endsWith("#lynx-20261030080000-1"),
      `${name}: a swipe didn't make the decision current`
    );
  } else {
    expect(await page.locator("aside").isVisible(), `${name}: no sidebar`);
  }
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
