"""Needs the models in MODEL_DIR (`python app.py download`). Run: python -m unittest -v test_app"""

import io
import json
import socket
import threading
import unittest
import urllib.request
from pathlib import Path

import numpy as np

import app

models = app.Models()
# Made-up speech (macOS `say`): an American voice in English, then a French voice in French.
TWO_VOICES = (Path(__file__).parent / "fixtures/two-voices.ogg").read_bytes()


class SelfCheck(unittest.TestCase):
    def test_models_pass_self_check(self):
        app.self_check(models)


def ogg(samples: np.ndarray, rate: int = app.SAMPLE_RATE) -> bytes:
    import soundfile

    out = io.BytesIO()
    soundfile.write(out, samples, rate, format="OGG", subtype="OPUS")
    return out.getvalue()


class Ranges(unittest.TestCase):
    def test_ogg_ranges_embed_like_the_same_samples_and_bad_ranges_are_none(self):
        clip = app.synthetic_clip(3.0)
        file = np.concatenate([clip, clip * 0, clip])  # 9 s: voice, silence, voice
        for rate in (app.SAMPLE_RATE, 48_000):
            source = file if rate == app.SAMPLE_RATE else np.repeat(file, 3)
            clips = app.clips_of(app.read_audio(ogg(source, rate)), [(0, 3), (6, 9), (8, 12), (20, 25), (1, 1.2)])
            self.assertEqual([c is None for c in clips], [False, False, False, True, True])
            self.assertAlmostEqual(clips[2].size / app.SAMPLE_RATE, 1.0, places=1)
            first, last = (np.array(app.embed(models, c)) for c in clips[:2])
            reference = np.array(app.embed(models, clip))
            self.assertGreater(float(first @ reference), 0.95)
            self.assertGreater(float(first @ last), 0.95)

    def test_rejects_audio_it_cannot_read(self):
        with self.assertRaises(ValueError):
            app.read_audio(b"not audio")


class Transcribe(unittest.TestCase):
    def test_two_voices_are_two_speakers_in_their_languages_with_their_words(self):
        heard = app.transcribe(models, app.read_audio(TWO_VOICES))
        self.assertEqual([(t["speaker"], t["language"]) for t in heard["turns"]], [("0", "en"), ("1", "fr")])
        switch = heard["turns"][1]["start"]
        english = " ".join(w["text"] for w in heard["words"] if w["start"] < switch).lower()
        french = " ".join(w["text"] for w in heard["words"] if w["start"] >= switch).lower()
        for said in ("weather", "mountains", "morning", "books", "window"):
            self.assertIn(said, english)
        for said in ("marché", "heures", "pain", "travail"):
            self.assertIn(said, french)


class Http(unittest.TestCase):
    def test_both_routes_answer(self):
        app.Handler.secret = b"s" * 16
        threading.Thread(target=app.worker, args=(models,), daemon=True).start()

        class Local(app.Server):
            address_family = socket.AF_INET  # a build sandbox may have no IPv6

        server = Local(("127.0.0.1", 0), app.Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)

        def post(path, body, **headers):
            request = urllib.request.Request(
                f"http://127.0.0.1:{server.server_port}{path}",
                body,
                {"X-Identity-Secret": "s" * 16, **headers},
            )
            return json.load(urllib.request.urlopen(request))

        clip = app.synthetic_clip(3.0)
        many = post("/embed-ranges", ogg(np.concatenate([clip, clip])), **{"X-Ranges": "[[0, 3], [9, 12]]"})
        self.assertEqual(len(many["embeddings"][0]["embedding"]), app.DIMENSIONS)
        self.assertIsNone(many["embeddings"][1])
        self.assertEqual(many["modelRevision"], app.MODELS["ecapa"][1])
        heard = post("/transcribe", TWO_VOICES)
        self.assertEqual(len(heard["turns"]), 2)
        self.assertEqual(heard["models"]["parakeet"], app.provenance("parakeet"))


if __name__ == "__main__":
    unittest.main()
