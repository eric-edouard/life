"""No models, no dependencies: the gate runs it with any python3. Run: python3 -m unittest test_contract"""

import gc
import json
import socket
import threading
import time
import unittest
import weakref
from concurrent.futures import Future
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
    def test_the_speaker_keeps_the_floor_until_their_segment_ends(self):
        turns = [
            {"end": 9.0, "speaker": "1", "start": 4.0},
            {"end": 5.0, "speaker": "0", "start": 0.0},
            {"end": 9.0, "speaker": "0", "start": 9.0},
        ]
        self.assertEqual(
            app.exclusive(turns),
            [{"end": 5.0, "speaker": "0", "start": 0.0}, {"end": 9.0, "speaker": "1", "start": 5.0}],
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

    def test_a_nested_blip_yields_no_turn(self):
        turns = [{"end": 10.0, "speaker": "A", "start": 0.0}, {"end": 5.0, "speaker": "B", "start": 4.0}]
        self.assertEqual(app.exclusive(turns), [{"end": 10.0, "speaker": "A", "start": 0.0}])

    def test_a_crossing_speaker_gets_the_floor_when_the_first_stops(self):
        turns = [{"end": 5.0, "speaker": "A", "start": 0.0}, {"end": 9.0, "speaker": "B", "start": 4.0}]
        self.assertEqual(
            app.exclusive(turns),
            [{"end": 5.0, "speaker": "A", "start": 0.0}, {"end": 9.0, "speaker": "B", "start": 5.0}],
        )

    def test_three_deep_the_earliest_started_keeps_the_floor(self):
        turns = [
            {"end": 6.0, "speaker": "A", "start": 0.0},
            {"end": 8.0, "speaker": "B", "start": 2.0},
            {"end": 5.0, "speaker": "C", "start": 3.0},
        ]
        self.assertEqual(
            [(t["speaker"], t["start"], t["end"]) for t in app.exclusive(turns)],
            [("A", 0.0, 6.0), ("B", 6.0, 8.0)],
        )

    def test_equal_starts_go_to_the_earlier_in_sorted_order(self):
        turns = [{"end": 5.0, "speaker": "A", "start": 0.0}, {"end": 3.0, "speaker": "B", "start": 0.0}]
        self.assertEqual(app.exclusive(turns), [{"end": 5.0, "speaker": "A", "start": 0.0}])

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

    def status(self, path, secret="s" * 16, **headers):
        request = urllib.request.Request(self.url + path, b"x", {"X-Identity-Secret": secret, **headers})
        try:
            return urllib.request.urlopen(request).status
        except urllib.error.HTTPError as error:
            return error.code

    def test_health_and_refusals(self):
        self.assertEqual(json.load(urllib.request.urlopen(self.url + "/health")), {"ok": True})
        self.assertEqual(self.status("/transcribe", secret="wrong"), 401)
        self.assertEqual(self.status("/embed-ranges", secret="wrong"), 401)
        self.assertEqual(self.status("/nothing"), 404)
        self.assertEqual(self.status("/transcribe", **{"X-Priority": "urgent"}), 400)

    def test_work_past_its_wait_is_a_failure_not_busy(self):
        replies, ran = [], []
        handler = waiting_handler(replies)
        self.addCleanup(handler.caller.close)
        self.addCleanup(handler.connection.close)
        wait, app.WAIT_SECONDS = app.WAIT_SECONDS, 0.05
        self.addCleanup(setattr, app, "WAIT_SECONDS", wait)
        app.Handler.run(handler, lambda models: ran.append(1), lambda result: result)
        self.assertEqual(replies, [504])
        app.run_next(None)  # the worker comes to it only now: its caller is gone, so it never runs
        self.assertEqual(ran, [])

    def test_work_whose_caller_hung_up_while_queued_never_runs(self):
        replies, ran = [], []
        handler = waiting_handler(replies)
        self.addCleanup(handler.connection.close)
        handler.caller.close()
        app.Handler.run(handler, lambda models: ran.append(1), lambda result: result)
        app.run_next(None)
        self.assertEqual((replies, ran), ([], []))


def waiting_handler(replies):
    """A handler with a live connection and no worker: what it queues stays queued."""
    handler = object.__new__(app.Handler)
    handler.connection, handler.caller = socket.socketpair()
    handler.reply = lambda status, body, headers=None: replies.append(status)
    return handler


class Admission(unittest.TestCase):
    """The one worker's order: dictation first, then the rest, each in arrival order; nothing cut."""

    def submit(self, priority, work):
        future = Future()
        self.assertTrue(app.enqueue(priority, work, future))
        return future

    def test_work_under_way_finishes_then_dictation_goes_before_older_work(self):
        order, started, release = [], threading.Event(), threading.Event()

        def long_block(models):
            started.set()
            release.wait(5)
            order.append("block")

        thread = threading.Thread(target=app.worker, args=(None,), daemon=True)
        thread.start()
        self.submit("ordinary", long_block)
        started.wait(5)
        first = self.submit("ordinary", lambda models: order.append("first"))
        second = self.submit("ordinary", lambda models: order.append("second"))
        dictation = self.submit("interactive", lambda models: order.append("dictation"))
        release.set()
        for future in (first, second, dictation):
            future.result(5)
        self.assertEqual(order, ["block", "dictation", "first", "second"])
        self.submit("ordinary", stop)
        thread.join(5)

    def test_dictation_has_one_waiting_place_of_its_own(self):
        self.assertTrue(app.enqueue("interactive", lambda models: None, Future()))
        self.assertFalse(app.enqueue("interactive", lambda models: None, Future()))
        for _ in range(app.QUEUE_SIZE):
            self.assertTrue(app.enqueue("ordinary", lambda models: None, Future()))
        self.assertFalse(app.enqueue("ordinary", lambda models: None, Future()))
        for _ in range(app.QUEUE_SIZE + 1):
            app.run_next(None)

    def test_canceled_or_expired_work_is_dropped_before_it_runs(self):
        ran = []
        canceled = self.submit("interactive", lambda models: ran.append("canceled"))
        canceled.cancel()
        app.run_next(None)
        wait, app.WAIT_SECONDS = app.WAIT_SECONDS, 0
        self.addCleanup(setattr, app, "WAIT_SECONDS", wait)
        self.submit("ordinary", lambda models: ran.append("expired"))
        app.run_next(None)
        self.assertEqual(ran, [])

    def test_the_idle_worker_keeps_no_samples_and_no_answer(self):
        class Samples:
            pass

        class Answer:
            pass

        samples = Samples()
        kept = weakref.ref(samples)
        thread = threading.Thread(target=app.worker, args=(None,), daemon=True)
        thread.start()
        future = self.submit("ordinary", lambda models, samples=samples: Answer())
        del samples
        answered = weakref.ref(future.result(5))
        del future
        gone = time.monotonic() + 5
        while (kept() or answered()) and time.monotonic() < gone:  # the worker is back waiting
            gc.collect()
            time.sleep(0.01)
        self.assertIsNone(kept())
        self.assertIsNone(answered())
        self.submit("ordinary", stop)
        thread.join(5)


def stop(models):
    """Ends a test's worker thread: not an Exception, so not handed to the future."""
    raise SystemExit


if __name__ == "__main__":
    unittest.main()
