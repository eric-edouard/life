"""Speaker embeddings for the voice server: SpeechBrain ECAPA on CPU.

POST /embed-ranges   body: Ogg Opus (any rate or channels, up to 16 MB). Headers X-Identity-Secret
              and X-Ranges, a JSON list of [start, end] seconds of the file (at most 400).
              -> {embeddings: one {embedding: 192 floats, L2-normalized, durationSeconds} or null
                  per range (null when it lies outside the file or holds under 0.5 s; one over
                  30 s is cut to its first 30 s), modelId, modelRevision}
GET  /health  -> {ok: true}

One worker thread runs the model behind a bounded queue; a full queue answers 503 with
Retry-After. Audio stays in memory for one request and is never written or logged.

  python app.py download   fetch the pinned model revision into MODEL_DIR (image build)
  python app.py            load, self-check, serve on HOST (default "::", every address) and PORT
"""

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

import numpy as np

MODEL_ID = "speechbrain/spkrec-ecapa-voxceleb"
MODEL_REVISION = "0f99f2d0ebe89ac095bcc5903c4dd8f72b367286"
MODEL_DIR = os.environ.get("MODEL_DIR", "/models/ecapa")
SAMPLE_RATE = 16_000
DIMENSIONS = 192
MIN_SECONDS, MAX_SECONDS = 0.5, 30.0
QUEUE_SIZE = int(os.environ.get("QUEUE_SIZE", "8"))
RETRY_AFTER = "5"
WAIT_SECONDS = 120

MAX_OGG_BYTES = 16 * 1024 * 1024
MAX_RANGES = 400

# One request's clips, embedded together by the worker.
jobs: "queue.Queue[tuple[list[np.ndarray], Future]]" = queue.Queue(maxsize=QUEUE_SIZE)


def download():
    from huggingface_hub import snapshot_download

    snapshot_download(MODEL_ID, revision=MODEL_REVISION, local_dir=MODEL_DIR)


def load_model():
    from speechbrain.inference.speaker import EncoderClassifier

    return EncoderClassifier.from_hparams(
        source=MODEL_DIR, savedir=MODEL_DIR, run_opts={"device": "cpu"}
    )


def embed(model, samples: np.ndarray) -> list[float]:
    import torch

    with torch.inference_mode():
        out = model.encode_batch(torch.from_numpy(samples).unsqueeze(0))
    vector = out.reshape(-1).numpy().astype(np.float64)
    norm = np.linalg.norm(vector)
    if vector.shape != (DIMENSIONS,) or not np.isfinite(vector).all() or norm == 0:
        raise RuntimeError(f"bad embedding of shape {vector.shape}")
    return (vector / norm).tolist()


def read_ranges(data: bytes, ranges: list[tuple[float, float]]) -> list[np.ndarray | None]:
    """The clips of an audio file (Ogg Opus, or anything libsndfile reads) at 16 kHz mono; None for
    a range that lies outside it or holds under MIN_SECONDS. A range over MAX_SECONDS is cut."""
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


def synthetic_clip(seconds: float = 3.0) -> np.ndarray:
    """A voiced-sounding tone: harmonics of 140 Hz at a syllable-like rate, plus noise."""
    t = np.arange(int(seconds * SAMPLE_RATE)) / SAMPLE_RATE
    voice = sum(np.sin(2 * np.pi * 140 * k * t) / k for k in range(1, 6))
    envelope = 0.5 + 0.5 * np.sin(2 * np.pi * 4 * t)
    noise = np.random.default_rng(0).standard_normal(t.size)
    return (0.2 * voice * envelope + 0.01 * noise).astype(np.float32)


def self_check(model):
    """Fails loudly if the model doesn't give a stable, normalized 192-d embedding."""
    first = np.array(embed(model, synthetic_clip()))
    assert first.shape == (DIMENSIONS,), first.shape
    assert abs(np.linalg.norm(first) - 1) < 1e-6
    assert np.allclose(first, embed(model, synthetic_clip()), atol=1e-5), "not deterministic"


def worker(model):
    while True:
        clips, future = jobs.get()
        if future.set_running_or_notify_cancel():
            try:
                future.set_result([embed(model, clip) for clip in clips])
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
        if self.path != "/embed-ranges":
            return self.reply(404, {"error": "not found"})
        given = self.headers.get("X-Identity-Secret", "").encode()
        if not hmac.compare_digest(given, self.secret):
            return self.reply(401, {"error": "unauthorized"})
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_OGG_BYTES:
            return self.reply(413, {"error": "body too large"})
        body = self.rfile.read(length)
        try:
            clips = read_ranges(body, parse_ranges(self.headers.get("X-Ranges", "")))
        except ValueError as error:
            return self.reply(400, {"error": str(error)})
        future: Future = Future()
        try:
            jobs.put_nowait(([c for c in clips if c is not None], future))
        except queue.Full:
            return self.reply(503, {"error": "busy"}, {"Retry-After": RETRY_AFTER})
        try:
            embeddings = iter(future.result(timeout=WAIT_SECONDS))
        except FutureTimeout:
            future.cancel()
            return self.reply(503, {"error": "timed out"}, {"Retry-After": RETRY_AFTER})
        except Exception as error:
            return self.reply(500, {"error": type(error).__name__})
        found = [
            None if clip is None else {
                "durationSeconds": clip.size / SAMPLE_RATE,
                "embedding": next(embeddings),
            }
            for clip in clips
        ]
        self.reply(200, {"embeddings": found, "modelId": MODEL_ID, "modelRevision": MODEL_REVISION})

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
    model = load_model()
    self_check(model)
    print("self-check passed", flush=True)
    threading.Thread(target=worker, args=(model,), daemon=True).start()
    host = os.environ.get("HOST", "::")
    # "::" is dual stack: IPv4 and IPv6 hosts both reach it. Voice Host sets 127.0.0.1.
    Server.address_family = socket.AF_INET6 if ":" in host else socket.AF_INET
    Server((host, int(os.environ.get("PORT", "8000"))), Handler).serve_forever()


if __name__ == "__main__":
    main()
