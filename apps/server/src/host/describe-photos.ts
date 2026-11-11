import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { log } from "../core/log";
import { toJpeg } from "../memory/message-files";
import { DESCRIBER_MODEL, startDescriber } from "../models/describer";
import { promptText } from "../models/llm";
import {
  DESCRIPTIONS,
  type Description,
  PHOTOS_PROMPT,
  writeDescriptions,
} from "../sources/photo-descriptions";
import { LIBRARY, waitingPhotos } from "../sources/photos";

// A pass of the photo descriptions (`watch.ts` runs one every 10 minutes while the `describePhotos` setting is on): the newest
// photos with no description, the model started only when one has an image to read and stopped after. The rows of
// the store are the queue, so a pass keeps no state.

/** About 8 minutes of the model at 8 s a photo. */
const PER_PASS = 60;
/** The long side, in pixels, of the image the model reads: Photos' own preview's. */
const IMAGE_PX = 1024;
const ERROR_MAX = 200;

export async function describePhotos(
  o: {
    descriptions?: string;
    library?: string;
    start?: typeof startDescriber;
  } = {}
) {
  const {
    descriptions = DESCRIPTIONS,
    library = LIBRARY,
    start = startDescriber,
  } = o;
  const waiting = waitingPhotos(PER_PASS, library, descriptions);
  if (waiting.length === 0) {
    return;
  }
  const started = performance.now();
  const tmp = await mkdtemp(join(tmpdir(), "life-photos-"));
  const rows: Description[] = [];
  const count = (outcome: Description["outcome"]) =>
    rows.filter((r) => r.outcome === outcome).length;
  try {
    const images = new Map<string, string>();
    for (const w of waiting) {
      // biome-ignore lint/performance/noAwaitInLoops: one conversion at a time
      const image = await imageOf(w, join(tmp, `${w.uuid}.jpg`));
      if (image) {
        images.set(w.uuid, image);
      } else {
        rows.push({
          model: DESCRIBER_MODEL,
          outcome: "no-image",
          uuid: w.uuid,
        });
      }
    }
    if (images.size > 0) {
      const prompt = (await promptText(PHOTOS_PROMPT)).trim();
      const describer = await start();
      try {
        for (const [uuid, image] of images) {
          rows.push(
            // biome-ignore lint/performance/noAwaitInLoops: the model reads one photo at a time
            await describer
              .describe(await Bun.file(image).bytes(), prompt)
              .then(
                (text): Description => ({
                  model: DESCRIBER_MODEL,
                  outcome: "described",
                  text,
                  uuid,
                }),
                (e: Error): Description => ({
                  error: e.message.slice(0, ERROR_MAX),
                  model: DESCRIBER_MODEL,
                  outcome: "failed",
                  uuid,
                })
              )
          );
        }
      } finally {
        await describer.stop();
      }
    }
  } finally {
    writeDescriptions(rows, descriptions);
    await rm(tmp, { force: true, recursive: true });
    log("photos.describe", {
      described: count("described"),
      failed: count("failed"),
      ms: Math.round(performance.now() - started),
      noImage: count("no-image"),
    });
  }
}

/** The image the model reads: Photos' preview as it is, else the original as a JPEG at `jpeg`; none when Photos holds neither here. */
async function imageOf(
  w: { original?: string; preview?: string },
  jpeg: string
) {
  if (w.preview) {
    return w.preview;
  }
  return w.original && (await toJpeg(w.original, jpeg, IMAGE_PX))
    ? jpeg
    : undefined;
}
