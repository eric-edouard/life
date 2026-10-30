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
  draft:
    "Bonjour,\n\nMerci pour votre message. Je reviens vers vous demain avec les chiffres.\n\n".repeat(
      4
    ),
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

const server = Bun.serve({
  fetch(req) {
    const { pathname } = new URL(req.url);
    if (pathname.startsWith("/api/")) {
      return req.method === "POST"
        ? new Response("ok")
        : Response.json(DECISIONS);
    }
    const file = Bun.file(
      join(WEB, "dist", pathname.startsWith("/app/") ? pathname : "index.html")
    );
    return new Response(file);
  },
  port: 0,
});

const { chromium } = await import("playwright");
const browser = await chromium.launch();
const failures: string[] = [];
const expect = (ok: boolean, what: string) => {
  if (!ok) {
    failures.push(what);
  }
};

const SIZES = [
  ["small phone", { height: 667, width: 375 }, true],
  ["phone", { height: 852, width: 393 }, true],
  ["desktop", { height: 800, width: 1280 }, false],
] as const;

/** One size: each in its own page, so they run side by side. */
async function check([name, viewport, isPhone]: (typeof SIZES)[number]) {
  const page = await browser.newPage({
    hasTouch: isPhone,
    isMobile: isPhone,
    viewport,
  });
  await page.goto(`${server.url.origin}/decisions`);
  const first = page.locator("section").first();
  await first.locator("textarea").waitFor();
  const box = await page.evaluate(() => ({
    h: innerHeight,
    overflow: document.documentElement.scrollWidth > innerWidth,
  }));
  expect(!box.overflow, `${name}: the page is wider than the screen`);
  const field = await first.locator("textarea").boundingBox();
  const option = await first.locator("button.opt").first().boundingBox();
  expect(
    Boolean(option && option.y >= 0 && option.y + option.height <= box.h),
    `${name}: the first answer isn't on screen`
  );
  expect(
    Boolean(field && field.y + field.height <= box.h),
    `${name}: "say it your way" is below the screen`
  );
  // Every part of a long decision is reachable: the question's part scrolls to its end.
  const scroller = first.locator("article > div").first();
  const reach = await scroller.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
    return Math.abs(el.scrollHeight - el.clientHeight - el.scrollTop) < 2;
  });
  expect(reach, `${name}: the question's part doesn't scroll to its end`);
  // Typing lands (30 Oct: every key was cancelled).
  await first.locator("textarea").click();
  await page.keyboard.type("bonjour");
  expect(
    (await first.locator("textarea").inputValue()) === "bonjour",
    `${name}: typing doesn't land`
  );
  await page.keyboard.press("Escape");
  await page.evaluate(() =>
    (document.activeElement as HTMLElement | null)?.blur()
  );
  if (isPhone) {
    // A sideways move lands on the next decision, whole.
    await page
      .locator("main > div")
      .last()
      .evaluate((t) => t.scrollTo({ left: t.clientWidth }));
    await page.waitForTimeout(400);
    expect(
      page.url().endsWith("#lynx-20261030080000-2"),
      `${name}: the next decision isn't the current one`
    );
  } else {
    // The desktop never pulls a scroll back (30 Oct: a short scroll snapped back to the top).
    await scroller.evaluate((el) => {
      el.scrollTop = 40;
    });
    await page.waitForTimeout(400);
    const kept = await scroller.evaluate((el) =>
      [el.scrollTop, el.scrollHeight, el.clientHeight].join(" ")
    );
    expect(
      kept.startsWith("40 "),
      `${name}: a scroll was pulled back (${kept})`
    );
    expect(await page.locator("aside").isVisible(), `${name}: no sidebar`);
  }
  await page.screenshot({
    path: join(WEB, "dist", `layout-${name.replace(" ", "-")}.png`),
  });
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
