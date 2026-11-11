"""One-off cloud backfill of photo descriptions (run by scripts/describe-photos-cloud.ts, never by hand).

stdin: a first line {"prompt": "..."}, then one {"uuid": "...", "jpeg": "<base64>"} per photo.
stdout: one {"uuid": "...", "text": "..."} per described photo, or {"uuid": "...", "error": "..."}.
Nothing is kept on Modal: no Volume, images only in memory, logs print counts only.
"""

import base64
import json
import sys

import modal

MODEL = "Qwen/Qwen3.5-9B"
REVISION = "c202236235762e1c871ad0ccb60c8ee5ba337b9a"
BATCH = 256

app = modal.App("life-photo-descriptions")
image = modal.Image.debian_slim(python_version="3.12").pip_install("vllm>=0.17")


@app.cls(image=image, gpu="H100", timeout=3600)
class Describer:
    @modal.enter()
    def load(self):
        from vllm import LLM

        self.llm = LLM(MODEL, revision=REVISION, dtype="bfloat16", max_model_len=4096)

    @modal.method()
    def describe(self, prompt: str, photos: list[dict]) -> list[dict]:
        from vllm import SamplingParams

        messages = [
            [
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "image_url",
                            "image_url": {"url": "data:image/jpeg;base64," + p["jpeg"]},
                        },
                        {"type": "text", "text": prompt},
                    ],
                }
            ]
            for p in photos
        ]
        outputs = self.llm.chat(
            messages,
            SamplingParams(temperature=0.2, max_tokens=200),
            chat_template_kwargs={"enable_thinking": False},
        )
        rows = []
        for p, o in zip(photos, outputs):
            text = o.outputs[0].text.strip()
            rows.append(
                {"uuid": p["uuid"], "text": text}
                if text
                else {"uuid": p["uuid"], "error": "empty answer"}
            )
        print(f"described {sum('text' in r for r in rows)} of {len(rows)}", file=sys.stderr)
        return rows


@app.local_entrypoint()
def main():
    prompt = json.loads(sys.stdin.readline())["prompt"]
    describer = Describer()
    batch: list[dict] = []

    def flush():
        for row in describer.describe.remote(prompt, batch):
            print(json.dumps(row), flush=True)
        batch.clear()

    for line in sys.stdin:
        photo = json.loads(line)
        base64.b64decode(photo["jpeg"], validate=True)
        batch.append(photo)
        if len(batch) == BATCH:
            flush()
    if batch:
        flush()
