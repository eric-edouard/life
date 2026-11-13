// One-off cloud backfill of photo descriptions (PLAN.md, "Cloud backfill"): sends each undescribed photo's 1024 px
// image to `describe_photos_modal.py` on Modal's GPU, once, and imports the answers through the store's one writer.
// Run only with his OK on the spend: `bun scripts/describe-photos-cloud.ts [limit]`. Nothing is kept on Modal.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { imageOf } from "../apps/server/src/host/describe-photos";
import { promptText } from "../apps/server/src/models/llm";
import {
  DESCRIPTIONS,
  type Description,
  PHOTO_DESCRIPTION_PROMPT,
  writeDescriptions,
} from "../apps/server/src/sources/photo-descriptions";
import {
  LIBRARY,
  type Waiting,
  waitingPhotos,
} from "../apps/server/src/sources/photos";

interface Answer {
  error?: string;
  text?: string;
  uuid: string;
}
/** A line of the entrypoint's answers, or null for anything else Modal prints. */
const answerOf = (line: string): Answer | null => {
  try {
    const a = JSON.parse(line) as Partial<Answer> | null;
    return typeof a?.uuid === "string" ? (a as Answer) : null;
  } catch {
    return null;
  }
};

export const CLOUD_MODEL = "qwen3.5-9b-bf16@vllm";
const SAVE_EVERY = 256;
const MODAL = [
  "modal",
  "run",
  join(dirname(import.meta.path), "describe_photos_modal.py"),
];

/** `photos` (undescribed, newest first) to `command`'s stdin; its answers are imported as they arrive. */
export async function describeInCloud(
  photos: Waiting[],
  o: { command?: string[]; descriptions?: string } = {}
) {
  const { command = MODAL, descriptions = DESCRIPTIONS } = o;
  const tmp = await mkdtemp(join(tmpdir(), "life-photos-cloud-"));
  const proc = Bun.spawn(command, {
    stderr: "inherit",
    stdin: "pipe",
    stdout: "pipe",
  });
  const rows: Description[] = [];
  const save = () => writeDescriptions(rows.splice(0), descriptions);
  try {
    const sent = (async () => {
      proc.stdin.write(
        `${JSON.stringify({ prompt: (await promptText(PHOTO_DESCRIPTION_PROMPT)).trim() })}\n`
      );
      for (const w of photos) {
        // biome-ignore lint/performance/noAwaitInLoops: one image in memory at a time
        const image = await imageOf(w, join(tmp, `${w.uuid}.jpg`));
        if (image) {
          proc.stdin.write(
            `${JSON.stringify({ jpeg: Buffer.from(await Bun.file(image).bytes()).toString("base64"), uuid: w.uuid })}\n`
          );
        } else {
          rows.push({ model: CLOUD_MODEL, outcome: "no-image", uuid: w.uuid });
        }
      }
      await proc.stdin.end();
    })();
    let described = 0;
    for await (const line of lines(proc.stdout)) {
      // Modal's CLI streams its own progress and the container's logs on stdout too: an answer is a line naming a photo.
      const a = answerOf(line);
      if (!a) {
        continue;
      }
      rows.push(
        a.text
          ? {
              model: CLOUD_MODEL,
              outcome: "described",
              text: a.text,
              uuid: a.uuid,
            }
          : {
              error: a.error ?? "no answer",
              model: CLOUD_MODEL,
              outcome: "failed",
              uuid: a.uuid,
            }
      );
      described += a.text ? 1 : 0;
      if (rows.length >= SAVE_EVERY) {
        save();
      }
    }
    await sent;
    save();
    return described;
  } finally {
    save();
    await rm(tmp, { force: true, recursive: true });
  }
}

async function* lines(stream: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder();
  let rest = "";
  for await (const chunk of stream) {
    rest += decoder.decode(chunk, { stream: true });
    const parts = rest.split("\n");
    rest = parts.pop() ?? "";
    yield* parts.filter(Boolean);
  }
  if (rest) {
    yield rest;
  }
}

if (import.meta.main) {
  const limit = Number(Bun.argv[2]) || Number.POSITIVE_INFINITY;
  console.log(
    `described ${await describeInCloud(waitingPhotos(limit, new Date(0), LIBRARY, DESCRIPTIONS))}`
  );
}
