"""The owner's one-off of 11 Nov 2026: every stored voice sample embedded again by the speech service's own
speaker model (apps/identity/app.py `speaker_model`, `read_audio`, `clips_of`, `embed`), on Modal CPUs.

    modal run apps/lifelog/apps/voice-bench/local/modal_embed.py --listing <listing.json> --audio <AUDIO_DIR> --out <dir>

The listing is the server's (GET /voice-samples/reembed: jobs of {key, samples: [{id, range}]}). Writes one file
per job in <out>: {modelId, modelRevision, vectors: [{id, embedding}]}. Audio goes up in each call and lives only
in the container's memory; nothing is kept on Modal but the model. Removed after its run.
"""

import hashlib
import json
import os
import sys

import modal

IDENTITY = os.path.join(os.path.dirname(os.path.abspath(__file__)), "../../identity/app.py")
BATCH_BYTES = 12 * 1024 * 1024

image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install("libsndfile1")
    .pip_install("numpy==2.3.4", "soundfile==0.14.0", "huggingface_hub")
    .pip_install("torch==2.11.0", "torchaudio==2.11.0", index_url="https://download.pytorch.org/whl/cpu")
    .add_local_file(IDENTITY, "/app/app.py")
)
app = modal.App("lifelog-voices", image=image)
models = modal.Volume.from_name("lifelog-voice-models", create_if_missing=True)


@app.cls(cpu=1, memory=4096, volumes={"/models": models}, timeout=3600, max_containers=100)
class Voices:
    @modal.enter()
    def load(self):
        sys.path.insert(0, "/app")
        os.environ["MODEL_DIR"] = "/models"
        import app as identity
        import torch

        torch.set_num_threads(1)
        identity.download(("mect-b2",))
        models.commit()
        self.identity = identity
        self.speaker = identity.speaker_model()

    @modal.method()
    def embed(self, batch: list[tuple[str, bytes, list]]) -> dict[str, dict]:
        identity = self.identity
        model, revision = identity.speaker_pin()
        out = {}
        for name, data, samples in batch:
            try:
                print("job", len(data), len(samples), flush=True)
                clips = identity.clips_of(identity.read_audio(data), [tuple(s["range"]) for s in samples])
                out[name] = {
                    "modelId": model,
                    "modelRevision": revision,
                    "vectors": [
                        {"embedding": identity.embed(self, clip), "id": s["id"]}
                        for s, clip in zip(samples, clips)
                        if clip is not None
                    ],
                }
            except Exception as error:  # one unreadable block must not lose the batch
                out[name] = {"error": str(error)}
        return out


@app.local_entrypoint()
def main(listing: str, audio: str, out: str):
    os.makedirs(out, exist_ok=True)
    name = lambda key: hashlib.sha256(key.encode()).hexdigest()  # noqa: E731
    todo = [j for j in json.load(open(listing))["jobs"] if not os.path.exists(f"{out}/{name(j['key'])}.json")]

    def batches():
        batch, size = [], 0
        for job in todo:
            data = open(os.path.join(audio, job["key"]), "rb").read()
            if batch and size + len(data) > BATCH_BYTES:
                yield batch
                batch, size = [], 0
            batch.append((name(job["key"]), data, job["samples"]))
            size += len(data)
        if batch:
            yield batch

    print(f"{len(todo)} jobs, {sum(len(j['samples']) for j in todo)} samples")
    failed = 0
    for result in Voices().embed.map(batches(), order_outputs=False):
        for job, value in result.items():
            failed += "error" in value
            json.dump(value, open(f"{out}/{job}.json", "w"))
    print(f"done, {failed} failed")
