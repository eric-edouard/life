"""The voice bench's models: one L2-normalized embedding per clip, per model.

    uv run --project local python local/embed.py <bench dir> [model…]     (all models by default)

Reads <dir>/clips/<id>.wav (16 kHz mono) and writes <dir>/embeddings/<model>@<revision>.f32 (float32
rows) with a .json beside it naming the clips in row order (secondsPerClip is one CPU thread's time). A clip a model already heard is skipped,
so a run after a new draw or a new model only embeds what is missing. Every model is pinned: its code
to a commit (cloned under <dir>/models/src), its weights to a Hugging Face revision or a release file.
Nothing here leaves the Mac, and nothing it writes belongs in the repo.
"""

import importlib.util
import json
import multiprocessing
import os
import subprocess
import sys
import time
import types
from pathlib import Path

# One thread per worker, set before the math libraries load: left alone, each worker starts a thread
# per core and they fight (ten workers ran three times slower than one alone).
for threads in ("OMP_NUM_THREADS", "VECLIB_MAXIMUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(threads, "1")

import numpy as np  # noqa: E402
import soundfile as sf  # noqa: E402
import torch  # noqa: E402

HERE = Path(__file__).resolve().parent
SAMPLE_RATE = 16_000
SAVE_EVERY = 500
# A worker per core, less a few for the Mac. The Mac's GPU is slower here: every clip has its own
# length, and MPS compiles each shape.
WORKERS = int(os.environ.get("VOICE_BENCH_WORKERS", max(1, (os.cpu_count() or 4) - 4)))


def source(models: Path, repo: str, commit: str) -> Path:
    """A GitHub repo's code at one commit, on sys.path."""
    path = models / "src" / f"{repo.split('/')[-1]}@{commit[:12]}"
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(["git", "clone", "--quiet", f"https://github.com/{repo}", str(path)], check=True)
        subprocess.run(["git", "-C", str(path), "checkout", "--quiet", commit], check=True)
    sys.path.insert(0, str(path))
    return path


def weights(repo: str, revision: str, file: str | None = None) -> str:
    from huggingface_hub import hf_hub_download, snapshot_download

    return hf_hub_download(repo, file, revision=revision) if file else snapshot_download(repo, revision=revision)


def ecapa(_models: Path, revision: str):
    """Production's model, loaded as apps/identity loads it."""
    from speechbrain.inference.classifiers import EncoderClassifier

    path = weights("speechbrain/spkrec-ecapa-voxceleb", revision)
    model = EncoderClassifier.from_hparams(path, savedir=path, run_opts={"device": "cpu"})
    return lambda wave: model.encode_batch(torch.from_numpy(wave).unsqueeze(0)).reshape(-1)


def redimnet2(dataset: str):
    def load(models: Path, revision: str):
        source(models, "PalabraAI/redimnet2", revision)
        from redimnet2 import load_custom

        model = load_custom("b6", train_type="lm", dataset=dataset).eval()
        return lambda wave: model(torch.from_numpy(wave)[None])[0]

    return load


def redimnet2_plus(models: Path, revision: str):
    source(models, "lab260ru/redimnet2-plus", "2a8d6dbd6d85e337a20b1d74ed3323c44bff86c5")
    from asv.models.redimnet2 import ReDimNet2Encoder

    encoder = ReDimNet2Encoder(model_name="b6", pretrained=False, model_overrides={"return_2d_output": True})
    state = torch.load(weights("lab260/redimnet2-plus", revision, "pytorch_model_fsdp.bin"), map_location="cpu")
    state = {k.replace("_orig_mod.", "").replace("module.", "").removeprefix("encoder."): v for k, v in state.items()}
    # Strict: a key or a shape that does not fit is a wrong architecture, never a silent random layer.
    encoder.load_state_dict({k: v for k, v in state.items() if k in encoder.state_dict()}, strict=True)
    encoder.eval()
    return lambda wave: encoder(encoder.spec_frontend(torch.from_numpy(wave)[None]))[0]


def mect(file: str):
    def load(models: Path, revision: str):
        source(models, "ant-research/AntSpeaker", "976f462d7af33a36b5dc2f0d6d75d6f044220d27")
        import antspeaker.models  # noqa: F401  (registers the models)
        import torchaudio.compliance.kaldi as kaldi
        from antspeaker.utils.registry import create_model

        path = weights("AntResearch/AntSpeaker", revision, file)
        config = torch.load(path, map_location="cpu")["config"]
        feature = config["feature"]
        model, _ = create_model(config["model"]).load_model(path)
        model.eval()

        def embed(wave):
            fbank = kaldi.fbank(
                torch.from_numpy(wave)[None] * (1 << 15),
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

    return load


def wespeaker(repo: str):
    def load(models: Path, revision: str):
        path = source(models, "wenet-e2e/wespeaker", "9fecd6cb4f47475d01761d87c826298dff4ef18c")
        # Its package imports every model and front end it has; only the nets are needed here.
        for name in ("wespeaker", "wespeaker.models"):
            sys.modules[name] = types.ModuleType(name)
            sys.modules[name].__path__ = [str(path / name.replace(".", "/"))]
        import torchaudio.compliance.kaldi as kaldi
        import yaml
        from wespeaker.models import campplus, resnet

        config = yaml.safe_load(Path(weights(repo, revision, "config.yaml")).read_text())
        model = getattr(campplus if config["model"].startswith("CAMPPlus") else resnet, config["model"])(
            **config["model_args"]
        )
        state = torch.load(weights(repo, revision, "avg_model.pt"), map_location="cpu")
        # The training head (one row per training speaker) is not part of the net.
        model.load_state_dict({k: v for k, v in state.items() if not k.startswith("projection.")}, strict=True)
        model.eval()

        def embed(wave):
            # As its own CLI computes them (cli/speaker.py compute_features).
            fbank = kaldi.fbank(
                torch.from_numpy(wave)[None] * (1 << 15), num_mel_bins=80, frame_length=25, frame_shift=10
            )
            out = model((fbank - fbank.mean(dim=0))[None])
            return (out[-1] if isinstance(out, tuple) else out)[0]

        return embed

    return load


def identity_pin() -> str:
    """ECAPA's revision, from the one place production pins it."""
    spec = importlib.util.spec_from_file_location("identity_app", HERE.parents[1] / "identity" / "app.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.MODELS["ecapa"][1]


# name: (pinned revision of the weights, or of the code when the weights are a release file; loader)
MODELS = {
    "ecapa": (identity_pin(), ecapa),
    "redimnet2-b6": ("c5bbe0b76e37df698c403f8844e41304ceab6307", redimnet2("vb2+vox2_v0")),
    # The same net trained with Chinese speech too: a third of his turns are Thai.
    "redimnet2-b6-cn": ("c5bbe0b76e37df698c403f8844e41304ceab6307", redimnet2("vb2+vox2+cnc2_v0")),
    "redimnet2-plus": ("fd45d1968c0ea91b62ad0d2469eee4607756bb07", redimnet2_plus),
    "mect-b2": ("fdabda1565f7d2f229a6a09dfff1191dc9faf61a", mect("mect_b2_vb2.pt")),
    "mect-b2-causal": ("fdabda1565f7d2f229a6a09dfff1191dc9faf61a", mect("mect_b2_vc2_streaming.pt")),
    "campplus": ("c5e01c6fcffcce160861e7e79782828320192b5c", wespeaker("Wespeaker/wespeaker-voxceleb-campplus-LM")),
    "resnet293": ("6e6bffe5bf3d772a1f143dc6dbfea58a0799ea83", wespeaker("Wespeaker/wespeaker-voxceleb-resnet293-LM")),
}


EMBED = None


def start(name: str, models: Path) -> None:
    global EMBED
    torch.set_num_threads(1)
    revision, load = MODELS[name]
    EMBED = load(models, revision)


def heard(clip: str) -> tuple[np.ndarray, float]:
    wave, rate = sf.read(clip, dtype="float32")
    if rate != SAMPLE_RATE or wave.ndim != 1:
        raise RuntimeError(f"{clip}: not 16 kHz mono")
    started = time.perf_counter()
    with torch.inference_mode():
        vector = EMBED(wave).reshape(-1).double().numpy()
    seconds = time.perf_counter() - started
    norm = np.linalg.norm(vector)
    if not np.isfinite(vector).all() or norm == 0:
        raise RuntimeError(f"bad embedding for {clip}")
    return (vector / norm).astype(np.float32), seconds


def run(bench: Path, name: str) -> None:
    revision, load = MODELS[name]
    out = bench / "embeddings" / f"{name}@{revision[:12]}"
    meta_path, rows_path = out.with_suffix(".json"), out.with_suffix(".f32")
    meta = json.loads(meta_path.read_text()) if meta_path.exists() else {"ids": [], "seconds": 0.0}
    rows = list(np.fromfile(rows_path, dtype=np.float32).reshape(len(meta["ids"]), -1)) if meta["ids"] else []
    done = set(meta["ids"])
    # VOICE_BENCH_CLIPS=1500 embeds only the first 1,500 clips: a quick look at a model before its full run.
    most = int(os.environ.get("VOICE_BENCH_CLIPS", 0)) or None
    clips = [p for p in sorted((bench / "clips").glob("*.wav"))[:most] if p.stem not in done]
    if not clips:
        print(f"{name}: nothing new", flush=True)
        return
    out.parent.mkdir(exist_ok=True)
    load(bench / "models", revision)  # fetches the code and the weights once, before the workers race for them

    def save():
        np.stack(rows).astype(np.float32).tofile(rows_path)
        meta_path.write_text(
            json.dumps(
                {
                    **meta,
                    "dim": int(rows[0].shape[0]),
                    "model": name,
                    "revision": revision,
                    "secondsPerClip": meta["seconds"] / len(meta["ids"]),
                }
            )
        )

    # A worker is replaced after 80 clips: torch keeps memory for every clip length it has seen, and
    # workers grown to 3 GB each sent the Mac into swap.
    with multiprocessing.get_context("spawn").Pool(WORKERS, start, (name, bench / "models"), 10) as pool:
        for n, (clip, (vector, seconds)) in enumerate(zip(clips, pool.imap(heard, map(str, clips), 8)), 1):
            rows.append(vector)
            meta["ids"].append(clip.stem)
            meta["seconds"] += seconds
            if n % SAVE_EVERY == 0 or n == len(clips):
                save()
                print(f"{name}: {n}/{len(clips)}", flush=True)


if __name__ == "__main__":
    bench = Path(sys.argv[1])
    for name in sys.argv[2:] or MODELS:
        if name not in MODELS:
            sys.exit(f"no model {name}: {', '.join(MODELS)}")
        run(bench, name)
