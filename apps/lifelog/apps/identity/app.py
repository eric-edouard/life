"""The speech service: audio in, numbers out, nothing stored.

POST /embed-ranges  body: Ogg Opus (any rate or channels, up to 16 MB). Headers X-Identity-Secret
              and X-Ranges, a JSON list of [start, end] seconds of the file (at most 400).
              -> {embeddings: one {embedding: 192 floats (MECT-B2), L2-normalized, durationSeconds} or null
                  per range (null when it lies outside the file or holds under 0.5 s; one over
                  30 s is cut to its first 30 s), modelId, modelRevision}
POST /transcribe    body: one block's audio, as above. Header X-Identity-Secret.
              -> {durationSeconds, turns: [{start, end, speaker, language, scores}], words: [{start, end,
                  text}], models: {name: "id@revision"}}
                  turns: Nemotron 3's speaker turns in time order, one speaker's joined across a
                  gap under 0.5 s, made exclusive (a turn ends where the next starts); speaker
                  "0", "1"…; language VoxLingua107's top code ("en", "th"…) and scores its
                  probabilities of en, fr and th, for a turn of a second or more, else null.
                  words: Parakeet Ultra's over the whole block. Routing them is the caller's.
GET  /health  -> {ok: true}

One worker thread runs the models behind a bounded queue; a full queue answers 503 with
Retry-After, and work not done in WAIT_SECONDS answers 504 (a failure the caller counts, so a block
that is always slow ends at Scribe instead of coming back forever). Audio stays in memory for one request and is never written or logged.

Parakeet has two runtimes, picked by the host with SPEECH_RUNTIME: "onnx" (onnx-asr on CPU, fp32;
never int8, it drops words) and "mlx" (Apple silicon). The default is mlx on macOS, onnx elsewhere.
Everything else runs on torch's CPU.

  python app.py download   fetch the pinned models into MODEL_DIR (once; the server's volume)
  python app.py            load, self-check, serve on HOST (default "::", every address) and PORT
"""

from __future__ import annotations

import hmac
import io
import json
import os
import queue
import socket
import sys
import threading
from concurrent.futures import Future
from concurrent.futures import TimeoutError as FutureTimeout
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODEL_DIR = os.environ.get("MODEL_DIR", "/models")
RUNTIME = os.environ.get("SPEECH_RUNTIME", "mlx" if sys.platform == "darwin" else "onnx")
THREADS = int(os.environ.get("THREADS", "0")) or os.cpu_count() or 1
# name: (Hugging Face repo, pinned revision, the files used; None for all)
# MECT-B2's code: AntSpeaker is no package, so `download` unpacks this commit of it beside the weights.
ANTSPEAKER = ("ant-research/AntSpeaker", "976f462d7af33a36b5dc2f0d6d75d6f044220d27")
MODELS = {
    "mect-b2": ("AntResearch/AntSpeaker", "fdabda1565f7d2f229a6a09dfff1191dc9faf61a", ["mect_b2_vb2.pt"]),
    "voxlingua": (
        "speechbrain/lang-id-voxlingua107-ecapa",
        "0253049ae131d6a4be1c4f0d8b0ff483a0f8c8e9",
        ["*.ckpt", "hyperparams.yaml", "label_encoder.txt"],
    ),
    "nemotron": (
        "nvidia/Nemotron-3-Diarization",
        "f667ed73aee57d40cc39428eb768b4fd87a0a29e",
        ["config.json", "processor_config.json", "model.safetensors"],
    ),
    "parakeet": {
        "onnx": (
            "Masterx/parakeet-tdt-0.6b-ultra-onnx",
            "99b09f030a5a6efeaa13cf2cf54592100ce2c3f1",
            ["config.json", "vocab.txt", "encoder-model.onnx", "encoder-model.onnx.data", "decoder_joint-model.onnx"],
        ),
        "mlx": ("selcukkubur/parakeet-ultra-mlx", "b554592c50b2a48471add2daa3d46fa9f00fef5e", None),
    }[RUNTIME],
}
SAMPLE_RATE = 16_000
DIMENSIONS = 192
MIN_SECONDS, MAX_SECONDS = 0.5, 30.0
# The bench's turns (docs/research/transcription-bench.md): one speaker's joined across a short
# gap, and VoxLingua107 judged on those of a second or more.
JOIN_GAP_SECONDS = 0.5
LANGUAGE_MIN_SECONDS = 1.0
# onnx-asr gives a token's start only: it ends at the next one, or this long after it.
TOKEN_MAX_SECONDS = 0.5
# MLX decodes a longer block in overlapping pieces of this many seconds: whole, 29 minutes ran out of GPU memory.
PARAKEET_CHUNK_SECONDS = 600
QUEUE_SIZE = int(os.environ.get("QUEUE_SIZE", "8"))
RETRY_AFTER = "5"
WAIT_SECONDS = 120

MAX_OGG_BYTES = 16 * 1024 * 1024
MAX_RANGES = 400

# One request's work for the worker: a function of the loaded models.
jobs: queue.Queue = queue.Queue(maxsize=QUEUE_SIZE)


def model_path(name: str) -> str:
    return os.path.join(MODEL_DIR, name)


def provenance(name: str) -> str:
    repo, revision, _ = MODELS[name]
    return f"{repo}@{revision}"


def speaker_pin() -> tuple[str, str]:
    """The speaker model as samples name it: its weights file, and their revision with the code's commit
    (the features are computed by that code, so a new commit is a new model)."""
    repo, revision, (file,) = MODELS["mect-b2"]
    return f"{repo}/{file}", f"{revision}+{ANTSPEAKER[1]}"


def antspeaker_path() -> str:
    return os.path.join(model_path("mect-b2"), f"AntSpeaker-{ANTSPEAKER[1]}")


def download(names=tuple(MODELS)):
    import tarfile
    import tempfile
    import urllib.request

    from huggingface_hub import snapshot_download

    for name in names:
        repo, revision, files = MODELS[name]
        snapshot_download(repo, revision=revision, local_dir=model_path(name), allow_patterns=files)
    if "mect-b2" in names and not os.path.exists(antspeaker_path()):
        repo, commit = ANTSPEAKER
        with urllib.request.urlopen(f"https://github.com/{repo}/archive/{commit}.tar.gz") as archive:
            # The archive's one folder is AntSpeaker-<commit>; renamed into place, so a cut download is fetched again.
            with tempfile.TemporaryDirectory(dir=model_path("mect-b2")) as part:
                tarfile.open(fileobj=archive, mode="r|gz").extractall(part, filter="data")
                os.rename(os.path.join(part, os.path.basename(antspeaker_path())), antspeaker_path())


def speaker_model():
    """MECT-B2 (AntSpeaker): 16 kHz samples to an embedding tensor. The one loader: the voice bench and
    a one-off run elsewhere use it, so every vector comes from the same code."""
    import torch

    sys.path.insert(0, antspeaker_path())
    import antspeaker.models  # noqa: F401  (registers the models)
    import torchaudio.compliance.kaldi as kaldi
    from antspeaker.utils.registry import create_model

    path = os.path.join(model_path("mect-b2"), MODELS["mect-b2"][2][0])
    config = torch.load(path, map_location="cpu")["config"]
    feature = config["feature"]
    model, _ = create_model(config["model"]).load_model(path)
    model.eval()

    def embed(samples):
        fbank = kaldi.fbank(
            torch.from_numpy(samples)[None] * (1 << 15),
            num_mel_bins=feature["num_mel_bins"],
            frame_length=feature["frame_length"],
            frame_shift=feature["frame_shift"],
            dither=0.0,
            energy_floor=0.0,
            window_type="hamming",
            sample_frequency=feature["sampling_rate"],
        )
        return model(fbank[None].transpose(-1, -2))[0]

    return embed


class Models:
    """Every model, loaded once per process."""

    def __init__(self):
        import torch
        from speechbrain.inference.classifiers import EncoderClassifier as Classifier
        from transformers import AutoModelForAudioFrameClassification, AutoProcessor

        torch.set_num_threads(THREADS)
        cpu = {"device": "cpu"}
        self.speaker = speaker_model()
        self.voxlingua = Classifier.from_hparams(model_path("voxlingua"), savedir=model_path("voxlingua"), run_opts=cpu)
        self.processor = AutoProcessor.from_pretrained(model_path("nemotron"))
        self.nemotron = AutoModelForAudioFrameClassification.from_pretrained(model_path("nemotron")).eval()
        self.parakeet = PARAKEETS[RUNTIME](model_path("parakeet"))


class OnnxParakeet:
    def __init__(self, path: str):
        import onnx_asr
        import onnxruntime

        options = onnxruntime.SessionOptions()
        options.intra_op_num_threads = THREADS
        options.inter_op_num_threads = 1
        self.model = onnx_asr.load_model(
            "nemo-parakeet-tdt-0.6b-v3", path, providers=["CPUExecutionProvider"], sess_options=options
        ).with_timestamps()

    def tokens(self, samples) -> list[tuple[str, float, float]]:
        heard = self.model.recognize(samples, sample_rate=SAMPLE_RATE)
        starts = list(heard.timestamps or [])
        ends = starts[1:] + [len(samples) / SAMPLE_RATE]
        return [
            (piece.replace("▁", " "), start, min(end, start + TOKEN_MAX_SECONDS))
            for piece, start, end in zip(heard.tokens or [], starts, ends)
        ]


class MlxParakeet:
    def __init__(self, path: str):
        from mlx_audio.stt.utils import load_model

        self.model = load_model(path)

    def tokens(self, samples) -> list[tuple[str, float, float]]:
        import mlx.core as mx

        heard = self.model.generate(mx.array(samples), chunk_duration=PARAKEET_CHUNK_SECONDS)
        # MLX keeps the GPU buffers a block used for the next one: 17 GB after a backlog on a 32 GB Mac.
        mx.clear_cache()
        return [(t.text, t.start, t.end) for s in heard.sentences for t in s.tokens]


PARAKEETS = {"onnx": OnnxParakeet, "mlx": MlxParakeet}


def words_of(tokens: list[tuple[str, float, float]]) -> list[dict]:
    """Subword tokens as words: a token that starts with a space starts a word."""
    words: list[dict] = []
    for text, start, end in tokens:
        if words and not text.startswith(" "):
            words[-1]["text"] += text
            words[-1]["end"] = end
        elif text.strip():
            words.append({"end": end, "start": start, "text": text.strip()})
    return [w for w in words if w["text"]]


def exclusive(turns_in: list[dict]) -> list[dict]:
    """Turns in time order, a turn joined to the one before when it is the same speaker's within
    JOIN_GAP_SECONDS (as the bench's turns), each ending where the next starts; empty ones go."""
    turns = []
    for turn in sorted(turns_in, key=lambda t: t["start"]):
        last = turns[-1] if turns else None
        if last and last["speaker"] == turn["speaker"] and turn["start"] - last["end"] < JOIN_GAP_SECONDS:
            last["end"] = max(last["end"], turn["end"])
        else:
            turns.append(dict(turn))
    for previous, following in zip(turns, turns[1:]):
        previous["end"] = min(previous["end"], following["start"])
    return [t for t in turns if t["end"] > t["start"]]


def embed(models: Models, samples) -> list[float]:
    import numpy as np
    import torch

    with torch.inference_mode():
        out = models.speaker(samples)
    vector = out.reshape(-1).numpy().astype(np.float64)
    norm = np.linalg.norm(vector)
    if vector.shape != (DIMENSIONS,) or not np.isfinite(vector).all() or norm == 0:
        raise RuntimeError(f"bad embedding of shape {vector.shape}")
    return (vector / norm).tolist()


# The languages whose probabilities a turn carries: what the server's router reads (route-turns.ts).
SCORED = ("en", "fr", "th")


def language(models: Models, samples) -> tuple[str, dict[str, float]]:
    """VoxLingua107's top code, and its probabilities of the SCORED languages."""
    import torch

    with torch.inference_mode():
        log_probs = models.voxlingua.classify_batch(torch.from_numpy(samples)[None])[0][0]
    labels = models.voxlingua.hparams.label_encoder.ind2lab
    codes = [labels[i].split(":")[0] for i in range(len(labels))]
    probs = log_probs.exp().tolist()
    return codes[int(log_probs.argmax())], {c: probs[codes.index(c)] for c in SCORED}


def transcribe(models: Models, samples) -> dict:
    import torch

    inputs = models.processor(samples, sampling_rate=SAMPLE_RATE)
    with torch.inference_mode():
        logits = models.nemotron(**inputs).logits
    found = models.processor.extract_speaker_dict(logits, inputs.attention_mask)[0]
    turns = exclusive([{"end": s["End"], "speaker": str(s["Speaker"]), "start": s["Start"]} for s in found])
    for turn in turns:
        piece = samples[int(turn["start"] * SAMPLE_RATE) : int(turn["end"] * SAMPLE_RATE)]
        judged = piece.size >= LANGUAGE_MIN_SECONDS * SAMPLE_RATE
        turn["language"], turn["scores"] = language(models, piece) if judged else (None, None)
    return {
        "durationSeconds": samples.size / SAMPLE_RATE,
        "models": {name: provenance(name) for name in ("nemotron", "voxlingua", "parakeet")},
        "turns": turns,
        "words": words_of(models.parakeet.tokens(samples)),
    }


def read_audio(data: bytes):
    """An audio file (Ogg Opus, or anything libsndfile reads) as 16 kHz mono float32."""
    import soundfile

    try:
        samples, rate = soundfile.read(io.BytesIO(data), dtype="float32", always_2d=True)
    except soundfile.LibsndfileError as error:
        raise ValueError(f"not readable audio: {error}") from error
    samples = samples.mean(axis=1)
    if rate != SAMPLE_RATE:
        import torch
        from torchaudio.functional import resample

        samples = resample(torch.from_numpy(samples), rate, SAMPLE_RATE).numpy()
    return samples


def clips_of(samples, ranges: list[tuple[float, float]]) -> list:
    """The clips of `ranges`; None for one outside the audio or under MIN_SECONDS. Over MAX_SECONDS is cut."""
    clips = []
    for start, end in ranges:
        clip = samples[int(start * SAMPLE_RATE) : int(min(end, start + MAX_SECONDS) * SAMPLE_RATE)]
        clips.append(clip if clip.size / SAMPLE_RATE >= MIN_SECONDS else None)
    return clips


def parse_ranges(header: str) -> list[tuple[float, float]]:
    try:
        ranges = [(float(a), float(b)) for a, b in json.loads(header)]
    except (TypeError, ValueError) as error:
        raise ValueError("X-Ranges must be a JSON list of [start, end] seconds") from error
    if not 0 < len(ranges) <= MAX_RANGES or any(not 0 <= a < b for a, b in ranges):
        raise ValueError(f"X-Ranges needs 1 to {MAX_RANGES} ranges with 0 <= start < end")
    return ranges


def synthetic_clip(seconds: float = 3.0):
    """A voiced-sounding tone: harmonics of 140 Hz at a syllable-like rate, plus noise."""
    import numpy as np

    t = np.arange(int(seconds * SAMPLE_RATE)) / SAMPLE_RATE
    voice = sum(np.sin(2 * np.pi * 140 * k * t) / k for k in range(1, 6))
    envelope = 0.5 + 0.5 * np.sin(2 * np.pi * 4 * t)
    noise = np.random.default_rng(0).standard_normal(t.size)
    return (0.2 * voice * envelope + 0.01 * noise).astype(np.float32)


def self_check(models: Models):
    """Fails loudly if a model doesn't load and answer in shape."""
    import numpy as np

    first = np.array(embed(models, synthetic_clip()))
    assert first.shape == (DIMENSIONS,), first.shape
    assert abs(np.linalg.norm(first) - 1) < 1e-6
    assert np.allclose(first, embed(models, synthetic_clip()), atol=1e-5), "not deterministic"
    heard = transcribe(models, synthetic_clip(5.0))
    assert set(heard) == {"durationSeconds", "models", "turns", "words"}, heard.keys()


def worker(models: Models):
    while True:
        work, future = jobs.get()
        if future.set_running_or_notify_cancel():
            try:
                future.set_result(work(models))
            except Exception as error:  # reported to the waiting request
                future.set_exception(error)


class Handler(BaseHTTPRequestHandler):
    secret = b""

    def do_GET(self):
        if self.path == "/health":
            self.reply(200, {"ok": True})
        else:
            self.reply(404, {"error": "not found"})

    def do_POST(self):
        if self.path not in ("/embed-ranges", "/transcribe"):
            return self.reply(404, {"error": "not found"})
        given = self.headers.get("X-Identity-Secret", "").encode()
        if not hmac.compare_digest(given, self.secret):
            return self.reply(401, {"error": "unauthorized"})
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_OGG_BYTES:
            return self.reply(413, {"error": "body too large"})
        body = self.rfile.read(length)
        try:
            if self.path == "/transcribe":
                samples = read_audio(body)
                return self.run(lambda models: transcribe(models, samples), lambda heard: heard)
            clips = clips_of(read_audio(body), parse_ranges(self.headers.get("X-Ranges", "")))
        except ValueError as error:
            return self.reply(400, {"error": str(error)})
        kept = [c for c in clips if c is not None]

        def answer(embeddings):
            found = iter(embeddings)
            model, revision = speaker_pin()
            return {
                "embeddings": [
                    None if c is None else {"durationSeconds": c.size / SAMPLE_RATE, "embedding": next(found)}
                    for c in clips
                ],
                "modelId": model,
                "modelRevision": revision,
            }

        self.run(lambda models: [embed(models, c) for c in kept], answer)

    def run(self, work, answer):
        """`work` on the worker; its result through `answer` to the caller."""
        future: Future = Future()
        try:
            jobs.put_nowait((work, future))
        except queue.Full:
            return self.reply(503, {"error": "busy"}, {"Retry-After": RETRY_AFTER})
        try:
            result = future.result(timeout=WAIT_SECONDS)
        except FutureTimeout:
            future.cancel()
            return self.reply(504, {"error": "timed out"})
        except Exception as error:
            return self.reply(500, {"error": type(error).__name__})
        self.reply(200, answer(result))

    def reply(self, status: int, body: dict, headers: dict | None = None):
        data = json.dumps(body).encode()
        self.send_response(status)
        for name, value in {"Content-Type": "application/json", **(headers or {})}.items():
            self.send_header(name, value)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


class Server(ThreadingHTTPServer):
    daemon_threads = True


def main():
    if sys.argv[1:] == ["download"]:
        return download()
    secret = os.environ.get("IDENTITY_SECRET", "")
    if len(secret) < 16:
        sys.exit("IDENTITY_SECRET must be set (16+ characters)")
    Handler.secret = secret.encode()
    models = Models()
    self_check(models)
    print(f"self-check passed ({RUNTIME})", flush=True)
    threading.Thread(target=worker, args=(models,), daemon=True).start()
    host = os.environ.get("HOST", "::")
    # "::" is dual stack: IPv4 and IPv6 hosts both reach it. Lifelog Host sets 127.0.0.1.
    Server.address_family = socket.AF_INET6 if ":" in host else socket.AF_INET
    Server((host, int(os.environ.get("PORT", "8000"))), Handler).serve_forever()


if __name__ == "__main__":
    main()
