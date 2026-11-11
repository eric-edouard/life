import { join } from "node:path";
import { z } from "zod";
import { MIN } from "../core/clock";
import { download, type Pin } from "../core/pinned";
import { cliEnv, llamaServer, MACHINE_DIR } from "../core/platform";

// The one model Life runs on the Mac instead of a provider (his decision of 11 Nov 2026): Qwen3.5-9B under llama.cpp
// describes his photos, so no image leaves the Mac. Two jobs: run llama-server while photos wait, and describe one
// image. The embedder (`core/embedder.ts`) is a different server, which Lifelog Host keeps running.

/** What a row of the store says wrote it (`sources/photo-descriptions.ts`). */
export const DESCRIBER_MODEL = "qwen3.5-9b-q4_k_m@llama.cpp";
const REVISION = "3885219b6810b007914f3a7950a8d1b469d598a5";
/** unsloth's GGUF of the model (Q4_K_M) and its vision projector, at a fixed revision. */
const FILES: Record<"model" | "projector", Pin & { name: string }> = {
  model: {
    name: "Qwen3.5-9B-Q4_K_M.gguf",
    sha256: "03b74727a860a56338e042c4420bb3f04b2fec5734175f4cb9fa853daf52b7e8",
    url: `https://huggingface.co/unsloth/Qwen3.5-9B-GGUF/resolve/${REVISION}/Qwen3.5-9B-Q4_K_M.gguf`,
  },
  projector: {
    name: "mmproj-F16.gguf",
    sha256: "f70dc3509053962b0d0d3ee8a7eacebf5d60aa560cad78254ae8698516ae029f",
    url: `https://huggingface.co/unsloth/Qwen3.5-9B-GGUF/resolve/${REVISION}/mmproj-F16.gguf`,
  },
};
const PORT = 47_616;
/** Loopback only, like the embedder: the image never leaves the Mac. */
const URL_BASE = `http://127.0.0.1:${PORT}`;
const START_TIMEOUT = 5 * MIN;

const Reply = z.object({
  choices: z
    .array(z.object({ message: z.object({ content: z.string().nullable() }) }))
    .min(1),
});

/**
 * `image` (a JPEG) described by the server at `url` with `prompt`: thinking off, the sampling of the bench (11 Nov 2026).
 * Throws on a refusal, a failed call or an empty answer.
 */
export async function describeAt(
  url: string,
  image: Uint8Array,
  prompt: string
) {
  const res = await fetch(`${url}/v1/chat/completions`, {
    body: JSON.stringify({
      chat_template_kwargs: { enable_thinking: false },
      max_tokens: 200,
      messages: [
        {
          content: [
            {
              image_url: {
                url: `data:image/jpeg;base64,${Buffer.from(image).toString("base64")}`,
              },
              type: "image_url",
            },
            { text: prompt, type: "text" },
          ],
          role: "user",
        },
      ],
      temperature: 0.2,
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
    signal: AbortSignal.timeout(5 * MIN),
  });
  if (!res.ok) {
    throw new Error(`the describer answered ${res.status}`);
  }
  const text = Reply.parse(
    await res.json()
  ).choices[0]?.message.content?.trim();
  if (!text) {
    throw new Error("the describer gave no words");
  }
  return text;
}

const isUp = () =>
  fetch(`${URL_BASE}/health`).then(
    (r) => r.ok,
    () => false
  );

/** The server up, downloading the model first when this Mac has none: its describe function and its stop. */
export async function startDescriber() {
  const server = llamaServer();
  if (!server) {
    throw new Error("llama-server is not installed (LIFE_LLAMA_SERVER)");
  }
  const [model, projector] = await Promise.all(
    [FILES.model, FILES.projector].map((f) =>
      download(f, join(MACHINE_DIR, "models", f.name))
    )
  );
  // A server already on the port is a leftover (it holds the model's memory): fail loudly, never reuse it.
  if (await isUp()) {
    throw new Error(`something already answers on port ${PORT}`);
  }
  // Background priority: it runs for minutes beside his work.
  const proc = Bun.spawn(
    [
      ...["taskpolicy", "-b", server, "-m", model as string],
      ...["--mmproj", projector as string, "--host", "127.0.0.1"],
      ...[
        "--port",
        String(PORT),
        "-ngl",
        "99",
        "--parallel",
        "1",
        "-c",
        "4096",
      ],
    ],
    { env: cliEnv(), stderr: "ignore", stdout: "ignore" }
  );
  // The watcher exits for new code mid-pass: the server must not outlive it.
  const kill = () => proc.kill();
  process.on("exit", kill);
  const stop = async () => {
    process.off("exit", kill);
    kill();
    await proc.exited;
  };
  try {
    const until = performance.now() + START_TIMEOUT;
    for (;;) {
      if (proc.exitCode !== null || performance.now() > until) {
        throw new Error("llama-server did not start");
      }
      // biome-ignore lint/performance/noAwaitInLoops: polls until the model is loaded
      if (await isUp()) {
        break;
      }
      // biome-ignore lint/performance/noAwaitInLoops: polls until the model is loaded
      await Bun.sleep(1000);
    }
  } catch (e) {
    await stop();
    throw e;
  }
  return {
    describe: (image: Uint8Array, prompt: string) =>
      describeAt(URL_BASE, image, prompt),
    stop,
  };
}
