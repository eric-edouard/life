"""A Qwen3-ASR checkpoint in Hugging Face's transformers layout, renamed to mlx-audio's.

    uv run --project apps/stt-bench/local python apps/stt-bench/local/convert_qwen3.py <src dir> <mlx build dir> <out dir>

mlx-audio reads only the original layout (`thinker.*`) or its own; a transformers one (`model.audio_tower`,
`model.language_model`, `model.multi_modal_projector`) loads without error with its audio encoder left
random (Typhoon's Thai fine-tune did, 22 Oct). The config and tokenizer come from an mlx build of the same
size. Load the result with strict=True to check every weight landed.
"""

import shutil
import sys
from pathlib import Path

import mlx.core as mx

src, base, out = (Path(a) for a in sys.argv[1:4])
out.mkdir(parents=True, exist_ok=True)
for f in base.iterdir():
    if f.suffix != ".safetensors":
        shutil.copy(f, out / f.name)
RENAMES = [
    ("model.multi_modal_projector.linear_1.", "audio_tower.proj1."),
    ("model.multi_modal_projector.linear_2.", "audio_tower.proj2."),
    ("model.audio_tower.", "audio_tower."),
    ("model.language_model.", "model."),
]
weights = {}
for name, value in mx.load(str(src / "model.safetensors")).items():
    for old, new in RENAMES:
        name = name.replace(old, new)
    if "conv2d" in name and name.endswith("weight") and value.ndim == 4:
        value = value.transpose(0, 2, 3, 1)  # PyTorch's (out, in, h, w) to MLX's (out, h, w, in)
    weights[name] = value
mx.save_safetensors(str(out / "model.safetensors"), weights)
print(f"{len(weights)} weights to {out}")
