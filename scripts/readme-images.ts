import { join } from "node:path";
import { chromium } from "playwright";

// The README's pictures: each figure of assets/readme/diagrams.html, drawn on Life's own tokens.css, shot light and
// dark at twice the size into assets/readme/<id>-<scheme>.png. Run `bun scripts/readme-images.ts` after editing it.
const dir = join(import.meta.dir, "../assets/readme");
const browser = await chromium.launch();
for (const colorScheme of ["light", "dark"] as const) {
  const page = await browser.newPage({ colorScheme, deviceScaleFactor: 2 });
  await page.goto(`file://${join(dir, "diagrams.html")}`);
  await page.evaluate(() => document.fonts.ready);
  for (const figure of await page.locator("figure[id]").all()) {
    const id = await figure.getAttribute("id");
    await figure.screenshot({ path: join(dir, `${id}-${colorScheme}.png`) });
  }
  await page.close();
}
await browser.close();
