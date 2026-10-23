"""The language heard in each segment, by an audio language detector on this Mac.

    uv run --project apps/transcription-bench/local python apps/transcription-bench/local/lid.py <clips> <segments.json> <out.json>

segments.json is [{clip, start, end}] (seconds in the clip's .wav). Writes the same list with
`voxlingua`: SpeechBrain's VoxLingua107 ECAPA (21M parameters), its top language and the
probability of Thai.
"""

import json
import sys
from pathlib import Path

import soundfile
import torch
from speechbrain.inference.classifiers import EncoderClassifier

clips, segments_path, out_path = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
segments = json.loads(segments_path.read_text())

voxlingua = EncoderClassifier.from_hparams(
    source="speechbrain/lang-id-voxlingua107-ecapa",
    savedir=str(Path.home() / ".cache/stt-bench-models/voxlingua107"),
)
labels = voxlingua.hparams.label_encoder
thai = labels.lab2ind[next(lab for lab in labels.lab2ind if lab.startswith("th:"))]

audio = {}
for n, seg in enumerate(segments):
    if seg["clip"] not in audio:
        audio[seg["clip"]], _ = soundfile.read(clips / f"{seg['clip']}.wav", dtype="float32")
    # The clips are 16 kHz (bench.ts clips), as VoxLingua107 expects.
    piece = audio[seg["clip"]][int(seg["start"] * 16000) : int(seg["end"] * 16000)]
    probs = voxlingua.classify_batch(torch.from_numpy(piece)[None])[0][0].exp()
    top = int(probs.argmax())
    seg["voxlingua"] = {
        "lang": labels.ind2lab[top].split(":")[0],
        "thai": round(float(probs[thai] / probs.sum()), 4),
    }
    if n % 50 == 0:
        print(f"{n}/{len(segments)}", flush=True)
out_path.write_text(json.dumps(segments, ensure_ascii=False))
