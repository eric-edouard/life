"""Who spoke when, for many blocks at once: the speech service's own Nemotron 3 step (apps/identity/app.py
`transcribe`, the same pinned model, processor and `exclusive`) on Modal GPUs, without its words or languages.

    modal run apps/lifelog/apps/stt-bench/local/modal_speakers.py --listing <"jobId path.ogg" lines> --out <dir>

Writes <out>/<jobId>.json: {"model", "turns": [{start, end, speaker}]}. Audio goes up in each call and lives only in
the container's memory; nothing is kept on Modal but the model.
"""

import json
import os
import sys

import modal

IDENTITY = os.path.join(os.path.dirname(os.path.abspath(__file__)), "../../identity/app.py")
BATCH = 40

image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install("libsndfile1")
    .pip_install("librosa==0.11.0", "numpy==2.3.4", "soundfile==0.14.0", "torch==2.11.0", "torchaudio==2.11.0",
                 "transformers==5.20.2", "huggingface_hub")
    .add_local_file(IDENTITY, "/app/app.py")
)
app = modal.App("lifelog-speakers", image=image)
models = modal.Volume.from_name("lifelog-speaker-models", create_if_missing=True)


@app.cls(gpu="L4", volumes={"/models": models}, timeout=3600, max_containers=20)
class Speakers:
    @modal.enter()
    def load(self):
        sys.path.insert(0, "/app")
        os.environ["MODEL_DIR"] = "/models"
        import app as identity
        from huggingface_hub import snapshot_download
        from transformers import AutoModelForAudioFrameClassification, AutoProcessor

        repo, revision, files = identity.MODELS["nemotron"]
        path = identity.model_path("nemotron")
        snapshot_download(repo, revision=revision, allow_patterns=files, local_dir=path)
        models.commit()
        self.identity = identity
        self.processor = AutoProcessor.from_pretrained(path)
        self.model = AutoModelForAudioFrameClassification.from_pretrained(path).eval().to("cuda")
        self.provenance = identity.provenance("nemotron")

    @modal.method()
    def turns(self, batch: dict[str, bytes]) -> dict[str, dict]:
        import torch

        out = {}
        for job, data in batch.items():
            try:
                samples = self.identity.read_audio(data)
                inputs = self.processor(samples, sampling_rate=self.identity.SAMPLE_RATE)
                with torch.inference_mode():
                    logits = self.model(**{k: v.to("cuda") for k, v in inputs.items()}).logits.cpu()
                found = self.processor.extract_speaker_dict(logits, inputs.attention_mask)[0]
                turns = self.identity.exclusive(
                    [{"end": s["End"], "speaker": str(s["Speaker"]), "start": s["Start"]} for s in found]
                )
                out[job] = {"model": self.provenance, "turns": turns}
            except Exception as error:  # one unreadable block must not lose the batch
                out[job] = {"error": str(error)}
        return out


@app.local_entrypoint()
def main(listing: str, out: str):
    os.makedirs(out, exist_ok=True)
    todo = [line.split(" ", 1) for line in open(listing).read().splitlines()]
    todo = [(job, path) for job, path in todo if not os.path.exists(f"{out}/{job}.json")]
    batches = [todo[i : i + BATCH] for i in range(0, len(todo), BATCH)]
    print(f"{len(todo)} blocks in {len(batches)} batches")
    payloads = ({job: open(path, "rb").read() for job, path in b} for b in batches)
    failed = 0
    for result in Speakers().turns.map(payloads, order_outputs=False):
        for job, value in result.items():
            failed += "error" in value
            json.dump(value, open(f"{out}/{job}.json", "w"))
    print(f"done, {failed} failed")
