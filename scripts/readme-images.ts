import { join } from "node:path";
import { chromium } from "playwright";

// The README's pictures: each figure of assets/readme/diagrams.html, drawn on Life's own tokens.css, shot light and
// dark at twice the size into assets/readme/<id>-<scheme>.png. Run `bun scripts/readme-images.ts` after editing it.
const dir = join(import.meta.dir, "../assets/readme");
const html = await Bun.file(join(dir, "diagrams.html")).text();
const ids = [...html.matchAll(/<figure id="([a-z]+)"/g)].map((m) => m[1]);
const browser = await chromium.launch();
await Promise.all(
  ids.flatMap((id) =>
    (["light", "dark"] as const).map(async (colorScheme) => {
      const page = await browser.newPage({ colorScheme, deviceScaleFactor: 2 });
      await page.goto(`file://${join(dir, "diagrams.html")}`);
      await page.evaluate(() => document.fonts.ready);
      await page
        .locator(`figure#${id}`)
        .screenshot({ path: join(dir, `${id}-${colorScheme}.png`) });
    })
  )
);
await browser.close();
