"""Needs the model in MODEL_DIR (`python app.py download`). Run: python -m unittest"""

import io
import json
import socket
import threading
import unittest
import urllib.request

import numpy as np

import app


class SelfCheck(unittest.TestCase):
    def test_model_passes_self_check(self):
        app.self_check(app.load_model())


def ogg(samples: np.ndarray, rate: int = app.SAMPLE_RATE) -> bytes:
    import soundfile

    out = io.BytesIO()
    soundfile.write(out, samples, rate, format="OGG", subtype="OPUS")
    return out.getvalue()


class Ranges(unittest.TestCase):
    def test_ogg_ranges_embed_like_the_same_samples_and_bad_ranges_are_none(self):
        model = app.load_model()
        clip = app.synthetic_clip(3.0)
        file = np.concatenate([clip, clip * 0, clip])  # 9 s: voice, silence, voice
        for rate in (app.SAMPLE_RATE, 48_000):
            source = file if rate == app.SAMPLE_RATE else np.repeat(file, 3)
            clips = app.read_ranges(ogg(source, rate), [(0, 3), (6, 9), (8, 12), (20, 25), (1, 1.2)])
            self.assertEqual([c is None for c in clips], [False, False, False, True, True])
            self.assertAlmostEqual(clips[2].size / app.SAMPLE_RATE, 1.0, places=1)
            first, last = (np.array(app.embed(model, c)) for c in clips[:2])
            reference = np.array(app.embed(model, clip))
            self.assertGreater(float(first @ reference), 0.95)
            self.assertGreater(float(first @ last), 0.95)

    def test_rejects_bad_ranges_and_audio(self):
        with self.assertRaises(ValueError):
            app.parse_ranges("[[3, 1]]")
        with self.assertRaises(ValueError):
            app.parse_ranges("nope")
        with self.assertRaises(ValueError):
            app.read_ranges(b"not audio", [(0, 1)])
        self.assertEqual(app.parse_ranges("[[0, 1.5], [2, 3]]"), [(0, 1.5), (2, 3)])


class Http(unittest.TestCase):
    def test_embed_ranges_answers_one_embedding_or_none_per_range(self):
        app.Handler.secret = b"s" * 16
        threading.Thread(target=app.worker, args=(app.load_model(),), daemon=True).start()
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
        self.assertEqual(many["modelRevision"], app.MODEL_REVISION)


if __name__ == "__main__":
    unittest.main()
