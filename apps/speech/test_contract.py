"""No models, no dependencies: the gate runs it with any python3. Run: python3 -m unittest test_contract"""

import json
import socket
import threading
import unittest
import urllib.error
import urllib.request

import app


class Words(unittest.TestCase):
    def test_tokens_join_into_words_at_a_leading_space(self):
        tokens = [(" To", 2.4, 2.6), ("ut", 2.6, 2.9), (" à", 2.9, 3.2), (" ", 3.2, 3.3), (" fait", 3.5, 3.8)]
        self.assertEqual(
            app.words_of(tokens),
            [
                {"end": 2.9, "start": 2.4, "text": "Tout"},
                {"end": 3.2, "start": 2.9, "text": "à"},
                {"end": 3.8, "start": 3.5, "text": "fait"},
            ],
        )

    def test_a_first_token_without_a_space_still_starts_a_word(self):
        self.assertEqual(app.words_of([("ok", 0.0, 0.2)]), [{"end": 0.2, "start": 0.0, "text": "ok"}])


class Turns(unittest.TestCase):
    def test_turns_are_sorted_and_end_where_the_next_starts(self):
        turns = [
            {"end": 9.0, "speaker": "1", "start": 4.0},
            {"end": 5.0, "speaker": "0", "start": 0.0},
            {"end": 9.0, "speaker": "0", "start": 9.0},
        ]
        self.assertEqual(
            app.exclusive(turns),
            [{"end": 4.0, "speaker": "0", "start": 0.0}, {"end": 9.0, "speaker": "1", "start": 4.0}],
        )

    def test_one_speakers_turns_join_across_a_short_gap(self):
        turns = [
            {"end": 2.0, "speaker": "0", "start": 0.0},
            {"end": 4.0, "speaker": "0", "start": 2.3},
            {"end": 6.0, "speaker": "0", "start": 5.0},
        ]
        self.assertEqual(
            app.exclusive(turns),
            [{"end": 4.0, "speaker": "0", "start": 0.0}, {"end": 6.0, "speaker": "0", "start": 5.0}],
        )

    def test_another_speaker_between_keeps_the_turns_apart(self):
        turns = [
            {"end": 2.0, "speaker": "A", "start": 0.0},
            {"end": 2.3, "speaker": "B", "start": 2.1},
            {"end": 6.0, "speaker": "A", "start": 2.4},
        ]
        self.assertEqual(
            app.exclusive(turns),
            [
                {"end": 2.0, "speaker": "A", "start": 0.0},
                {"end": 2.3, "speaker": "B", "start": 2.1},
                {"end": 6.0, "speaker": "A", "start": 2.4},
            ],
        )

    def test_ranges(self):
        self.assertEqual(app.parse_ranges("[[0, 1.5], [2, 3]]"), [(0, 1.5), (2, 3)])
        for bad in ("[[3, 1]]", "nope", "[]"):
            with self.assertRaises(ValueError):
                app.parse_ranges(bad)


class Http(unittest.TestCase):
    def setUp(self):
        app.Handler.secret = b"s" * 16

        class Local(app.Server):
            address_family = socket.AF_INET  # a build sandbox may have no IPv6

        server = Local(("127.0.0.1", 0), app.Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        self.url = f"http://127.0.0.1:{server.server_port}"

    def status(self, path, secret="s" * 16):
        request = urllib.request.Request(self.url + path, b"x", {"X-Identity-Secret": secret})
        try:
            return urllib.request.urlopen(request).status
        except urllib.error.HTTPError as error:
            return error.code

    def test_health_and_refusals(self):
        self.assertEqual(json.load(urllib.request.urlopen(self.url + "/health")), {"ok": True})
        self.assertEqual(self.status("/transcribe", secret="wrong"), 401)
        self.assertEqual(self.status("/embed-ranges", secret="wrong"), 401)
        self.assertEqual(self.status("/nothing"), 404)


if __name__ == "__main__":
    unittest.main()
