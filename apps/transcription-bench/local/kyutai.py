# /// script
# requires-python = "==3.12.*"
# dependencies = ["moshi-mlx==0.3.0"]
# ///
"""Transcribes every clip in a folder with a Kyutai STT model on this Mac (MLX), loaded once.

    uv run --script apps/stt-bench/local/kyutai.py <hf-model> <clips> <out> [json]

Its own environment: moshi-mlx pins an older MLX than mlx-audio. Writes <out>/<clip>.json with the
text and the wall time, like run.py (Kyutai reports no language). The JSON may hold `groups`, as
in run.py; STT_BENCH_MODELS works the same way. Adapted from moshi_mlx.run_inference.
"""

import json
import os
import sys
import time
from pathlib import Path

import mlx.core as mx
import numpy as np
import rustymimi
import sentencepiece
import sphn
from huggingface_hub import hf_hub_download
from moshi_mlx import models, utils

model_id, clips, out = sys.argv[1], Path(sys.argv[2]), Path(sys.argv[3])
options = json.loads(sys.argv[4]) if len(sys.argv) > 4 else {}
groups = options.get("groups")
out.mkdir(parents=True, exist_ok=True)
local = Path(os.environ.get("STT_BENCH_MODELS", "/nonexistent")) / model_id


def fetch(name):
    return str(local / name) if (local / name).exists() else hf_hub_download(model_id, name)


config = json.loads(Path(fetch("config.json")).read_text())
stt = config["stt_config"]
cfg = models.LmConfig.from_config_dict(config)
lm = models.Lm(cfg)
lm.set_dtype(mx.bfloat16)
lm.load_weights(fetch(config.get("moshi_name", "model.safetensors")), strict=True)
tokenizer = sentencepiece.SentencePieceProcessor(fetch(config["tokenizer_name"]))
mimi_weights = fetch(config["mimi_name"])
lm.warmup(None)
FRAME = 1920  # 80 ms at 24 kHz

for clip in sorted(clips.glob("*.wav")):
    target = out / f"{clip.stem}.json"
    if target.exists():
        continue
    if groups and json.loads(clip.with_suffix(".json").read_text())["group"] not in groups:
        continue
    began = time.perf_counter()
    # Both stream, so their state carries from step to step: each clip starts clean (the model's
    # attention cache is otherwise reset only by its warmup).
    for cache in lm.transformer_cache:
        cache.reset()
    mimi = rustymimi.Tokenizer(
        mimi_weights, num_codebooks=max(cfg.generated_codebooks, cfg.other_codebooks)
    )
    pcm, _ = sphn.read(str(clip), sample_rate=24000)
    left = int(stt.get("audio_silence_prefix_seconds", 0.0) * 24000)
    right = int((stt.get("audio_delay_seconds", 0.0) + 1.0) * 24000)
    pcm = np.pad(pcm, [(0, 0), (left, right)])
    steps = pcm.shape[-1] // FRAME
    gen = models.LmGen(
        model=lm,
        max_steps=steps,
        text_sampler=utils.Sampler(top_k=25, temp=0),
        audio_sampler=utils.Sampler(top_k=250, temp=0),
        check=False,
    )
    pieces = []
    for i in range(steps):
        tokens = mimi.encode_step(pcm[None, 0:1, i * FRAME : (i + 1) * FRAME])
        tokens = mx.array(tokens).transpose(0, 2, 1)[:, :, : cfg.other_codebooks]
        token = gen.step(tokens[0], None)[0].item()
        if token not in (0, 3):
            pieces.append(tokenizer.id_to_piece(token).replace("▁", " "))
    target.write_text(
        json.dumps(
            {"text": "".join(pieces).strip(), "wallSeconds": time.perf_counter() - began},
            ensure_ascii=False,
        )
    )
    print(f"{clip.stem} {time.perf_counter() - began:.1f}s", flush=True)
